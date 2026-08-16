import crypto from 'node:crypto';
import path from 'node:path';

import { getCookieSecret } from '../../../src/users.js';
import { adaptCodexResponse, adaptImageRequest, adaptSillyTavernRequest, capabilities } from './adapter.js';
import { EncryptedCredentialStore } from './credentials.js';
import {
    collectCodexImage,
    collectCodexStream,
    DEFAULT_STREAM_HEARTBEAT_MS,
    forwardCodexStream,
    openChatCompletionStream,
    startChatCompletionHeartbeat,
} from './stream.js';
import { credentialsFromTokenResponse, openSystemBrowser } from './upstream/auth.js';
import { CodexUpstreamClient } from './upstream/client.js';
import { CREDENTIAL_FILE_NAME, PLUGIN_ID, UPSTREAM_TRACKING } from './upstream/constants.js';
import { CodexProviderError, toPublicError } from './upstream/errors.js';
import { ModelCatalog, assertSupportedReasoning, assertSupportedSpeedMode } from './upstream/models.js';
import { LoopbackLoginManager } from './upstream/oauth.js';
import { requestedLogLevel, requestedReasoningEffort, requestedSpeedMode, validateGenerateRequest, validateImageRequest } from './validation.js';

function userContext(request) {
    const root = request?.user?.directories?.root;
    if (!root) {
        throw new CodexProviderError('USER_CONTEXT_UNAVAILABLE', 'SillyTavern user storage is unavailable for this request.', { status: 401 });
    }
    return {
        root,
        key: String(request.user?.profile?.handle ?? root),
    };
}

function bindAbort(request, response, controller) {
    const abort = () => controller.abort('SillyTavern request closed');
    const abortIfUnfinished = () => {
        if (!response.writableEnded) abort();
    };
    request?.once?.('aborted', abort);
    response?.once?.('close', abortIfUnfinished);
    return () => {
        request?.removeListener?.('aborted', abort);
        response?.removeListener?.('close', abortIfUnfinished);
    };
}

function sendJson(response, status, body) {
    return response.status(status).json(body);
}

function sendError(response, error) {
    if (response.writableEnded || response.destroyed) return;
    const publicError = toPublicError(error);
    if (response.headersSent) {
        if (!response.writableEnded) {
            response.write(`data: ${JSON.stringify(publicError.body)}\n\n`);
            response.write('data: [DONE]\n\n');
            response.end();
        }
        return;
    }
    sendJson(response, publicError.status, publicError.body);
}

function safeLogger(logger = console) {
    return {
        info(event) { logger.info?.(`[codex-oauth] ${event}`); },
        warn(event) { logger.warn?.(`[codex-oauth] ${event}`); },
    };
}

const LOG_LEVEL_RANK = Object.freeze({ brief: 0, normal: 1, detailed: 2 });

function scopedRequestLogger(log, level) {
    const rank = LOG_LEVEL_RANK[level] ?? LOG_LEVEL_RANK.normal;
    return {
        brief(event) { log.info(event); },
        normal(event) { if (rank >= LOG_LEVEL_RANK.normal) log.info(event); },
        detailed(event) { if (rank >= LOG_LEVEL_RANK.detailed) log.info(event); },
        warn(event) { log.warn(event); },
    };
}

/**
 * Implements the stable internal interface:
 * codex.status(), login(), logout(), listModels(), generate(), cancel().
 */
export function createCodexService({
    dataRoot = globalThis.DATA_ROOT ?? path.resolve(process.cwd(), 'data'),
    now = () => Date.now(),
    logger = console,
    credentialStoreFactory,
    client = new CodexUpstreamClient({ logger }),
    models = new ModelCatalog({ logger }),
    loginManager,
    openBrowser = openSystemBrowser,
    streamHeartbeatMs = DEFAULT_STREAM_HEARTBEAT_MS,
} = {}) {
    const log = safeLogger(logger);
    const activeRequests = new Map();
    const masterSecret = () => getCookieSecret(dataRoot);
    const getStore = (request) => {
        const user = userContext(request);
        return credentialStoreFactory
            ? credentialStoreFactory(user)
            : new EncryptedCredentialStore({
                filePath: path.join(user.root, CREDENTIAL_FILE_NAME),
                masterSecret: masterSecret(),
                identity: user.key,
            });
    };
    const oauth = loginManager ?? new LoopbackLoginManager({ openBrowser, logger: log });

    const service = {
        async status(request) {
            const credentials = await getStore(request).read();
            return {
                authenticated: Boolean(credentials),
                ...(credentials ? { account: { displayName: 'ChatGPT' } } : {}),
                upstream: { opencodeCommit: UPSTREAM_TRACKING.commit },
                capabilities,
            };
        },

        async login(request) {
            const user = userContext(request);
            const store = getStore(request);
            await oauth.start({
                userKey: user.key,
                onTokens: async (tokens) => store.write(credentialsFromTokenResponse(tokens, now())),
            });
            return { started: true };
        },

        async logout(request) {
            const user = userContext(request);
            await oauth.cancel(user.key);
            await getStore(request).clear();
            log.info('logged out');
            return { authenticated: false };
        },

        async refresh(request) {
            const user = userContext(request);
            await client.refreshCredentials(getStore(request), user.key, { force: true });
            return service.status(request);
        },

        async listModels({ force = false } = {}) {
            return models.list({ force });
        },

        cancel(request, requestId) {
            const active = activeRequests.get(requestId);
            if (!active || active.userKey !== userContext(request).key) return false;
            active.controller.abort('Cancelled by SillyTavern');
            return true;
        },

        async generate(request, response) {
            let requestId;
            let cleanupAbort = () => {};
            let stopHeartbeat = () => {};
            let modelId = 'unknown';
            let streaming = false;
            let requestLog = scopedRequestLogger(log, 'normal');
            const startedAt = now();
            try {
                validateGenerateRequest(request.body);
                const logLevel = requestedLogLevel(request.body);
                requestLog = scopedRequestLogger(log, logLevel);
                const user = userContext(request);
                const model = await models.find(request.body.model);
                modelId = model.id;
                streaming = Boolean(request.body.stream);
                const reasoningEffort = assertSupportedReasoning(model, requestedReasoningEffort(request.body));
                const speedMode = requestedSpeedMode(request.body);
                const serviceTier = assertSupportedSpeedMode(model, speedMode);
                const payload = adaptSillyTavernRequest(request.body, { reasoningEffort, serviceTier });
                requestId = crypto.randomUUID();
                const controller = new AbortController();
                activeRequests.set(requestId, { controller, userKey: user.key });
                cleanupAbort = bindAbort(request, response, controller);
                response.set?.('X-Codex-Request-Id', requestId);
                requestLog.brief(`request started (id=${requestId}, model=${model.id}, stream=${streaming}, speed=${speedMode}, log=${logLevel})`);

                if (streaming) {
                    openChatCompletionStream({ response, model: model.id, requestId });
                    requestLog.detailed(`stream opened; waiting for Codex response (id=${requestId})`);
                    const heartbeatLogEvery = Math.max(1, Math.ceil(10_000 / Math.max(1, Number(streamHeartbeatMs) || DEFAULT_STREAM_HEARTBEAT_MS)));
                    stopHeartbeat = startChatCompletionHeartbeat({
                        response,
                        model: model.id,
                        requestId,
                        intervalMs: streamHeartbeatMs,
                        onHeartbeat: (count) => {
                            // Keep a visible progress trail without logging every
                            // 100 ms transport heartbeat.
                            if (count === 1 || count % heartbeatLogEvery === 0) {
                                requestLog.detailed(`stream keepalive sent (id=${requestId}, count=${count})`);
                            }
                        },
                        onWriteFailure: () => controller.abort('SillyTavern stream write failed'),
                    });
                }

                requestLog.normal(`request dispatching upstream (id=${requestId}, model=${model.id})`);

                const upstream = await client.request({
                    store: getStore(request),
                    userKey: user.key,
                    body: payload,
                    signal: controller.signal,
                    requestId,
                    logLevel,
                });
                requestLog.detailed(`upstream response received (id=${requestId}, status=${upstream.status ?? 'unknown'})`);

                let sawUpstreamEvent = false;
                let sawTextDelta = false;
                const onUpstreamEvent = (event) => {
                    const type = String(event?.type ?? 'unknown');
                    if (!sawUpstreamEvent) {
                        sawUpstreamEvent = true;
                        requestLog.detailed(`upstream first event received (id=${requestId}, type=${type})`);
                    }
                    if (!sawTextDelta && type === 'response.output_text.delta') {
                        sawTextDelta = true;
                        // A text delta is forwarded by forwardCodexStream in
                        // this same event-loop turn; do not wait for the next
                        // heartbeat boundary before SillyTavern sees it.
                        stopHeartbeat();
                        requestLog.normal(`upstream first text delta received (id=${requestId})`);
                    }
                };

                if (streaming) {
                    await forwardCodexStream({
                        upstreamBody: upstream.body,
                        response,
                        model: model.id,
                        requestId,
                        onEvent: onUpstreamEvent,
                    });
                    if (!response.writableEnded) response.end();
                } else {
                    try {
                        const completed = await collectCodexStream({
                            upstreamBody: upstream.body,
                            model: model.id,
                            requestId,
                            onEvent: onUpstreamEvent,
                        });
                        sendJson(response, 200, adaptCodexResponse(completed, model.id));
                    } catch (cause) {
                        throw new CodexProviderError('INVALID_RESPONSE', 'Codex backend returned an invalid response. Try again.', { status: 502, cause });
                    }
                }
                requestLog.brief(`request completed (id=${requestId}, model=${model.id}, elapsed=${Math.max(0, now() - startedAt)}ms)`);
            } catch (error) {
                if (error?.code !== 'REQUEST_CANCELLED') {
                    requestLog.warn(`request failed (id=${requestId ?? 'unassigned'}, model=${modelId}, code=${error?.code ?? 'unknown'}, elapsed=${Math.max(0, now() - startedAt)}ms)`);
                }
                sendError(response, error);
            } finally {
                stopHeartbeat();
                cleanupAbort();
                if (requestId) activeRequests.delete(requestId);
            }
        },

        async generateImage(request, response) {
            let requestId;
            let cleanupAbort = () => {};
            const startedAt = now();
            try {
                validateImageRequest(request.body);
                const user = userContext(request);
                const model = await models.find(request.body.model);
                requestId = crypto.randomUUID();
                const controller = new AbortController();
                activeRequests.set(requestId, { controller, userKey: user.key });
                cleanupAbort = bindAbort(request, response, controller);
                response.set?.('X-Codex-Request-Id', requestId);
                log.info(`image request started (id=${requestId}, model=${model.id})`);

                const upstream = await client.request({
                    store: getStore(request),
                    userKey: user.key,
                    body: adaptImageRequest({
                        model: model.id,
                        prompt: request.body.prompt,
                        size: request.body.size,
                        quality: request.body.quality,
                    }),
                    signal: controller.signal,
                    requestId,
                    logLevel: 'normal',
                });
                const image = await collectCodexImage({ upstreamBody: upstream.body });
                sendJson(response, 200, {
                    format: 'png',
                    data: image.data,
                    ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
                });
                log.info(`image request completed (id=${requestId}, model=${model.id}, elapsed=${Math.max(0, now() - startedAt)}ms)`);
            } catch (error) {
                log.warn(`image request failed (id=${requestId ?? 'unassigned'}, code=${error?.code ?? 'unknown'}, elapsed=${Math.max(0, now() - startedAt)}ms)`);
                sendError(response, error);
            } finally {
                cleanupAbort();
                if (requestId) activeRequests.delete(requestId);
            }
        },

        async connectionStatus(request, response) {
            try {
                const status = await service.status(request);
                if (!status.authenticated) {
                    throw new CodexProviderError('NOT_AUTHENTICATED', 'Sign in to ChatGPT before connecting.', { status: 401 });
                }
                return sendJson(response, 200, { data: [], capabilities: status.capabilities });
            } catch (error) {
                return sendError(response, error);
            }
        },

        async shutdown() {
            for (const active of activeRequests.values()) active.controller.abort('SillyTavern is shutting down');
            activeRequests.clear();
            await oauth.shutdown();
        },
    };
    return service;
}

export function installRoutes(router, service) {
    router.get('/status', async (request, response) => {
        try {
            sendJson(response, 200, await service.status(request));
        } catch (error) {
            sendError(response, error);
        }
    });
    router.post('/auth/login', async (request, response) => {
        try {
            sendJson(response, 200, await service.login(request));
        } catch (error) {
            sendError(response, error);
        }
    });
    router.post('/auth/logout', async (request, response) => {
        try {
            sendJson(response, 200, await service.logout(request));
        } catch (error) {
            sendError(response, error);
        }
    });
    router.post('/auth/refresh', async (request, response) => {
        try {
            sendJson(response, 200, await service.refresh(request));
        } catch (error) {
            sendError(response, error);
        }
    });
    router.post('/models', async (request, response) => {
        try {
            sendJson(response, 200, { data: await service.listModels({ force: Boolean(request.body?.force) }) });
        } catch (error) {
            sendError(response, error);
        }
    });
    router.post('/image', (request, response) => service.generateImage(request, response));
    router.post('/cancel/:requestId', (request, response) => {
        sendJson(response, 200, { cancelled: service.cancel(request, request.params.requestId) });
    });
}

export { PLUGIN_ID };
