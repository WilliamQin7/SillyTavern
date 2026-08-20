import http from 'node:http';
import { Cursor } from '@cursor/sdk';
import { formatMessages, openAiUsage, publicModels, resolveModelSelection } from './protocol.js';
import { runCursorChat } from './cursor-chat.js';

const host = process.env.CURSOR_GROK_BRIDGE_HOST ?? '127.0.0.1';
const port = Number(process.env.CURSOR_GROK_BRIDGE_PORT ?? 5111);
const bridgeToken = process.env.CURSOR_GROK_BRIDGE_TOKEN;
const defaultModel = process.env.CURSOR_GROK_DEFAULT_MODEL ?? 'grok-4.6-high-fast';
const timeoutMs = Number(process.env.CURSOR_GROK_TIMEOUT_MS ?? 240_000);
const terminalGraceMs = Number(process.env.CURSOR_GROK_TERMINAL_GRACE_MS ?? 5_000);

function json(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

function openAiError(res, statusCode, message, type = 'cursor_bridge_error') {
    json(res, statusCode, { error: { message, type, param: null, code: null } });
}

async function readJson(req) {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 5 * 1024 * 1024) {
            throw Object.assign(new Error('Request body exceeds 5 MiB.'), { statusCode: 413 });
        }
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req) {
    if (!bridgeToken) return true;
    return req.headers.authorization === `Bearer ${bridgeToken}`;
}

function writeSse(res, data) {
    if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function chunk(id, model, delta, finishReason = null, usage) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: usage ? [] : [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
    };
}

async function handleCompletion(req, res) {
    const body = await readJson(req);
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return openAiError(res, 400, 'messages must be a non-empty array.', 'invalid_request_error');
    }

    const model = String(body.model ?? defaultModel);
    const selection = resolveModelSelection({ ...body, model });
    const prompt = formatMessages(body.messages);
    const id = `chatcmpl-cursor-${crypto.randomUUID()}`;
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    req.once('aborted', abort);
    res.once('close', () => {
        if (!res.writableEnded) abort();
    });

    if (body.stream) {
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        });
        res.flushHeaders();
        writeSse(res, chunk(id, model, { role: 'assistant', content: '' }));
    }

    try {
        const result = await runCursorChat({
            prompt,
            model: selection,
            signal: abortController.signal,
            timeoutMs,
            terminalGraceMs,
            onTextDelta: body.stream
                ? (text) => writeSse(res, chunk(id, model, { content: text }))
                : undefined,
        });
        const usage = openAiUsage(result.usage);

        if (body.stream) {
            writeSse(res, chunk(id, model, {}, 'stop'));
            if (body.stream_options?.include_usage && usage) writeSse(res, chunk(id, model, {}, null, usage));
            if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
            return;
        }

        json(res, 200, {
            id,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: result.text },
                finish_reason: 'stop',
            }],
            ...(usage ? { usage } : {}),
            system_fingerprint: `cursor-sdk-${result.completionMode}`,
        });
    } catch (error) {
        if (error?.name === 'AbortError') return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[cursor-grok-bridge] ${message}`);
        if (body.stream) {
            writeSse(res, { error: { message, type: 'cursor_bridge_error', code: null } });
            if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n');
        } else if (!res.headersSent) {
            openAiError(res, Number(error?.statusCode ?? 502), message);
        }
    }
}

const catalog = await Cursor.models.list();
if (!catalog.some((model) => model.id === 'grok-4.6')) {
    throw new Error('This Cursor account does not expose grok-4.6.');
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
        if (!authorized(req)) return openAiError(res, 401, 'Invalid bridge token.', 'authentication_error');

        if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
            return json(res, 200, { ok: true, model: defaultModel, sandbox: false });
        }
        if (req.method === 'GET' && url.pathname === '/v1/models') {
            return json(res, 200, { object: 'list', data: publicModels() });
        }
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            return await handleCompletion(req, res);
        }
        openAiError(res, 404, `Unknown route: ${req.method} ${url.pathname}`, 'not_found_error');
    } catch (error) {
        if (res.headersSent) return res.destroy(error instanceof Error ? error : undefined);
        const message = error instanceof Error ? error.message : String(error);
        openAiError(res, Number(error?.statusCode ?? 400), message, 'invalid_request_error');
    }
});

server.listen(port, host, () => {
    console.log(`Cursor Grok bridge listening on http://${host}:${port}/v1`);
    console.log(`Default model: ${defaultModel}; sandbox: disabled; tools: disabled`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => process.exit(0)));
}
