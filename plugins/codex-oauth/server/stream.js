import { CodexProviderError } from './upstream/errors.js';
import { responseEventFailed, responseEventTextDelta, toChatCompletionChunk } from './upstream/protocol.js';

// SillyTavern expects an active Chat Completions SSE response while a reasoning
// model is working. Emit a syntactically valid no-op chunk every 100 ms until
// the first visible token arrives. This keeps the connection visibly active
// without exposing hidden reasoning, while real text deltas bypass the timer.
export const DEFAULT_STREAM_HEARTBEAT_MS = 100;

function parseEvent(block) {
    const event = { event: '', data: '' };
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event.event = line.slice(6).trim();
        if (line.startsWith('data:')) event.data += `${event.data ? '\n' : ''}${line.slice(5).trimStart()}`;
    }
    return event.data ? event : null;
}

/** Parse a Web/Node ReadableStream of SSE events without buffering the complete response. */
export async function* parseSse(body) {
    if (!body) throw new CodexProviderError('INVALID_STREAM', 'Codex backend returned an empty stream.', { status: 502 });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? '';
            for (const block of blocks) {
                const event = parseEvent(block);
                if (event) yield event;
            }
            if (done) break;
        }
        if (buffer.trim()) {
            const event = parseEvent(buffer);
            if (event) yield event;
        }
    } finally {
        reader.releaseLock();
    }
}

function responseIsWritable(response) {
    return !response.writableEnded && !response.destroyed;
}

function flushSse(response) {
    // flushHeaders is available on Node's ServerResponse. flush is added by
    // compression middleware when present. Both are optional in unit tests.
    response.flushHeaders?.();
    response.flush?.();
}

export function writeSse(response, payload) {
    if (!responseIsWritable(response)) return false;
    response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
    flushSse(response);
    return true;
}

/** Open SillyTavern's Chat Completions SSE response before the upstream fetch. */
export function openChatCompletionStream({ response, model, requestId }) {
    response.status?.(200);
    response.set?.({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // Prevent compatible reverse proxies from buffering the heartbeat.
        'X-Accel-Buffering': 'no',
    });
    response.flushHeaders?.();
    return writeSse(response, toChatCompletionChunk({
        id: requestId,
        model,
        delta: { role: 'assistant', content: '' },
    }));
}

/**
 * Send a valid empty Chat Completions delta while Codex is thinking.
 * Returns a cleanup function which is safe to call more than once.
 */
export function startChatCompletionHeartbeat({
    response,
    model,
    requestId,
    intervalMs = DEFAULT_STREAM_HEARTBEAT_MS,
    onHeartbeat,
    onWriteFailure,
}) {
    const interval = Math.max(1, Number(intervalMs) || DEFAULT_STREAM_HEARTBEAT_MS);
    let count = 0;
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
    };
    const timer = setInterval(() => {
        if (!responseIsWritable(response)) {
            stop();
            return;
        }
        try {
            const written = writeSse(response, toChatCompletionChunk({
                id: requestId,
                model,
                delta: {},
            }));
            if (!written) {
                stop();
                return;
            }
            count += 1;
            onHeartbeat?.(count);
        } catch (error) {
            stop();
            onWriteFailure?.(error);
        }
    }, interval);
    timer.unref?.();
    return stop;
}

async function* codexEvents(upstreamBody) {
    for await (const packet of parseSse(upstreamBody)) {
        if (packet.data === '[DONE]') return;
        let event;
        try {
            event = JSON.parse(packet.data);
        } catch {
            throw new CodexProviderError('INVALID_STREAM', 'Codex backend returned an invalid streaming event.', { status: 502 });
        }
        if (responseEventFailed(event)) {
            throw new CodexProviderError('BACKEND_STREAM_ERROR', 'Codex backend ended the stream with an error.', { status: 502 });
        }
        yield event;
    }
}

/** Collect one provider-native image result without logging its bytes. */
export async function collectCodexImage({ upstreamBody, onEvent }) {
    let image;
    for await (const event of codexEvents(upstreamBody)) {
        onEvent?.(event);
        if (event.type === 'response.output_item.done' && event.item?.type === 'image_generation_call') {
            image = {
                data: event.item.result,
                revisedPrompt: event.item.revised_prompt,
            };
        }
    }
    if (typeof image?.data !== 'string' || image.data.length === 0) {
        throw new CodexProviderError('IMAGE_RESULT_MISSING', 'Codex completed without returning an image.', { status: 502 });
    }
    return image;
}

/** Collect Codex's required SSE transport for a SillyTavern non-stream request. */
export async function collectCodexStream({ upstreamBody, model, requestId, onEvent }) {
    let text = '';
    let completed;
    for await (const event of codexEvents(upstreamBody)) {
        onEvent?.(event);
        text += responseEventTextDelta(event);
        if (event.type === 'response.completed' || event.type === 'response.incomplete') completed = event.response ?? event;
    }
    return {
        id: completed?.id ?? requestId,
        model: completed?.model ?? model,
        output_text: typeof completed?.output_text === 'string' ? completed.output_text : text,
        output: completed?.output,
        status: completed?.status ?? 'completed',
        usage: completed?.usage,
    };
}

/** Streams Codex Responses SSE into SillyTavern's native Chat Completion SSE contract. */
export async function forwardCodexStream({ upstreamBody, response, model, requestId, onEvent }) {
    let finishReason = 'stop';
    for await (const event of codexEvents(upstreamBody)) {
        onEvent?.(event);
        if (event.type === 'response.incomplete') finishReason = 'length';
        const delta = responseEventTextDelta(event);
        // Codex emits lifecycle/reasoning events before visible text. Convert
        // those to harmless no-op chunks so the downstream stream remains
        // active even when the model takes a long time to reason.
        writeSse(response, toChatCompletionChunk({
            id: requestId,
            model,
            delta: delta ? { content: delta } : {},
        }));
    }
    writeSse(response, toChatCompletionChunk({
        id: requestId,
        model,
        delta: {},
        finishReason,
    }));
    writeSse(response, '[DONE]');
}
