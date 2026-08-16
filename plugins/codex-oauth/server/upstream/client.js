import {
    CODEX_RESPONSES_ENDPOINT,
    DEFAULT_REQUEST_TIMEOUT_MS,
    REFRESH_EARLY_MS,
} from './constants.js';
import { CodexProviderError, mapUnknownError, mapUpstreamHttpError } from './errors.js';
import { refreshAccessToken } from './oauth.js';

function requestSignal(sourceSignal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(sourceSignal?.reason ?? 'cancelled');
    if (sourceSignal) {
        if (sourceSignal.aborted) onAbort();
        else sourceSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('timeout');
    }, timeoutMs);
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        cleanup: () => {
            clearTimeout(timer);
            sourceSignal?.removeEventListener?.('abort', onAbort);
        },
    };
}

/** Server-side authenticated Codex Responses client with per-user refresh single-flight. */
export class CodexUpstreamClient {
    constructor({ fetchImpl = globalThis.fetch, refreshFn = refreshAccessToken, now = () => Date.now(), logger = console, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
        this.fetchImpl = fetchImpl;
        this.refreshFn = refreshFn;
        this.now = now;
        this.logger = logger;
        this.timeoutMs = timeoutMs;
        this.refreshFlights = new Map();
    }

    async refreshCredentials(store, userKey, { force = false } = {}) {
        const current = await store.read();
        if (!current?.refreshToken) {
            throw new CodexProviderError('NOT_AUTHENTICATED', 'Sign in to ChatGPT before generating.', { status: 401 });
        }
        if (!force && Number(current.expiresAt ?? 0) > this.now() + REFRESH_EARLY_MS) return current;

        const flightKey = `${userKey}:${store.key}`;
        if (this.refreshFlights.has(flightKey)) return this.refreshFlights.get(flightKey);
        const refresh = (async () => {
            try {
                const tokens = await this.refreshFn({ refreshToken: current.refreshToken, fetchImpl: this.fetchImpl });
                const next = {
                    ...current,
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token || current.refreshToken,
                    idToken: tokens.id_token || current.idToken || '',
                    expiresAt: this.now() + Number(tokens.expires_in ?? 3600) * 1000,
                };
                await store.write(next);
                this.logger.info?.('[codex-oauth] token refreshed');
                return next;
            } catch (error) {
                await store.clear().catch(() => {});
                this.logger.warn?.('[codex-oauth] token refresh failed');
                throw new CodexProviderError('REFRESH_FAILED', 'ChatGPT authentication could not be refreshed. Sign in again.', { status: 401, cause: error });
            } finally {
                this.refreshFlights.delete(flightKey);
            }
        })();
        this.refreshFlights.set(flightKey, refresh);
        return refresh;
    }

    async request({ store, userKey, body, signal, requestId, logLevel = 'detailed' }) {
        return this.#requestAttempt({ store, userKey, body, signal, requestId, logLevel, retriedAfter401: false });
    }

    async #requestAttempt({ store, userKey, body, signal, requestId, logLevel, retriedAfter401 }) {
        let credentials = await store.read();
        if (!credentials?.accessToken || !credentials?.refreshToken) {
            throw new CodexProviderError('NOT_AUTHENTICATED', 'Sign in to ChatGPT before generating.', { status: 401 });
        }
        if (Number(credentials.expiresAt ?? 0) <= this.now() + REFRESH_EARLY_MS) {
            credentials = await this.refreshCredentials(store, userKey);
        }

        const timeout = requestSignal(signal, this.timeoutMs);
        let response;
        const requestStartedAt = this.now();
        try {
            const headers = {
                'Content-Type': 'application/json',
                'Accept': body.stream ? 'text/event-stream' : 'application/json',
                'Authorization': `Bearer ${credentials.accessToken}`,
                // This header and originator value track the current OpenCode compatibility flow.
                'originator': 'opencode',
                'User-Agent': 'SillyTavern Codex OAuth Provider',
                'session-id': requestId,
            };
            if (credentials.accountId) headers['ChatGPT-Account-Id'] = credentials.accountId;
            if (logLevel === 'detailed') {
                this.logger.info?.(`[codex-oauth] upstream request sent (id=${requestId}, model=${String(body?.model ?? 'unknown')}, stream=${Boolean(body?.stream)}, retry=${retriedAfter401})`);
            }
            response = await this.fetchImpl(CODEX_RESPONSES_ENDPOINT, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: timeout.signal,
            });
            if (logLevel === 'detailed') {
                this.logger.info?.(`[codex-oauth] upstream response headers received (id=${requestId}, status=${response.status}, elapsed=${Math.max(0, this.now() - requestStartedAt)}ms)`);
            }
        } catch (error) {
            if (timeout.timedOut()) {
                throw new CodexProviderError('UPSTREAM_TIMEOUT', 'Codex backend timed out. Try again.', { status: 504, retryable: true, cause: error });
            }
            if (signal?.aborted) {
                throw new CodexProviderError('REQUEST_CANCELLED', 'Generation was stopped.', { status: 499, cause: error });
            }
            throw mapUnknownError(error);
        } finally {
            timeout.cleanup();
        }

        if (response.status === 401 && !retriedAfter401) {
            try {
                await response.body?.cancel?.();
            } catch {
                // The original 401 body is not relevant after a refresh retry.
            }
            await this.refreshCredentials(store, userKey, { force: true });
            return this.#requestAttempt({ store, userKey, body, signal, requestId, logLevel, retriedAfter401: true });
        }
        if (!response.ok) throw await mapUpstreamHttpError(response);
        return response;
    }
}
