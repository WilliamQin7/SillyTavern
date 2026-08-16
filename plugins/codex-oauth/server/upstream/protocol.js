import crypto from 'node:crypto';

import { CodexProviderError } from './errors.js';

function textPart(part) {
    if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
        const text = part.text ?? part.content;
        if (typeof text === 'string') return { type: 'input_text', text };
    }
    if (part?.type === 'image_url' || part?.type === 'input_image' || part?.image_url) {
        throw new CodexProviderError('IMAGES_UNSUPPORTED', 'This Codex provider currently supports text messages only.', { status: 400 });
    }
    throw new CodexProviderError('UNSUPPORTED_MESSAGE_CONTENT', 'A SillyTavern message contains content this Codex provider cannot send.', { status: 400 });
}

/** Converts one already-assembled SillyTavern message without changing order or role. */
export function toResponsesInputMessage(message) {
    const content = typeof message.content === 'string'
        ? message.content
        : message.content.map(textPart);
    return { role: message.role, content };
}

/**
 * Convert SillyTavern's final Chat Completion message array to the Responses
 * payload used by the Codex backend. No instructions, tools, or agent context
 * are inserted here.
 */
export function toResponsesRequest({ model, messages, stream, reasoningEffort, serviceTier }) {
    const body = {
        model,
        input: messages.map(toResponsesInputMessage),
        // The Codex compatibility endpoint requires SSE even when SillyTavern
        // requested a non-streaming reply. The route aggregates that SSE only
        // for the non-streaming caller; browser streaming remains native.
        stream: true,
        store: false,
    };
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
    if (serviceTier) body.service_tier = serviceTier;
    return body;
}

export function extractOutputText(response) {
    if (typeof response?.output_text === 'string') return response.output_text;
    const output = Array.isArray(response?.output) ? response.output : [];
    return output
        .flatMap(item => Array.isArray(item?.content) ? item.content : [])
        .filter(part => part?.type === 'output_text' || part?.type === 'text')
        .map(part => String(part.text ?? ''))
        .join('');
}

function usageFromResponse(response) {
    const usage = response?.usage;
    if (!usage || typeof usage !== 'object') return undefined;
    const promptTokens = usage.input_tokens ?? usage.prompt_tokens;
    const completionTokens = usage.output_tokens ?? usage.completion_tokens;
    if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return undefined;
    return {
        prompt_tokens: Number(promptTokens ?? 0),
        completion_tokens: Number(completionTokens ?? 0),
        total_tokens: Number(usage.total_tokens ?? Number(promptTokens ?? 0) + Number(completionTokens ?? 0)),
    };
}

/** Adapts a completed Responses object to SillyTavern's Chat Completion response contract. */
export function toChatCompletionResponse(response, model) {
    const usage = usageFromResponse(response);
    return {
        id: response?.id ?? `codex-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: response?.model ?? model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: extractOutputText(response) },
            finish_reason: response?.status === 'incomplete' ? 'length' : 'stop',
        }],
        ...(usage ? { usage } : {}),
    };
}

export function toChatCompletionChunk({ id, model, delta, finishReason = null }) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
}

/** @param {object} event */
export function responseEventTextDelta(event) {
    const type = event?.type;
    if (type === 'response.output_text.delta') return typeof event.delta === 'string' ? event.delta : '';
    return '';
}

export function responseEventFailed(event) {
    return ['error', 'response.failed'].includes(event?.type);
}
