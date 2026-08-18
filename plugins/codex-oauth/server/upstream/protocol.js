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

/** Converts Chat Completions history, including function calls, to Responses items. */
export function toResponsesInputItems(message) {
    if (message.role === 'tool') {
        const output = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        return [{ type: 'function_call_output', call_id: message.tool_call_id, output }];
    }

    const items = [];
    if (message.content !== null && message.content !== undefined && message.content !== '') {
        items.push(toResponsesInputMessage(message));
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            items.push({
                type: 'function_call',
                call_id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
            });
        }
    }
    return items;
}

export function toResponsesTool(tool) {
    return {
        type: 'function',
        name: tool.function.name,
        description: String(tool.function.description ?? ''),
        parameters: tool.function.parameters,
        strict: false,
    };
}

export function toResponsesToolChoice(choice) {
    if (choice === undefined || choice === null) return undefined;
    if (['auto', 'none', 'required'].includes(choice)) return choice;
    if (choice?.type === 'function' && typeof choice.function?.name === 'string') {
        return { type: 'function', name: choice.function.name };
    }
    return 'auto';
}

/**
 * Convert SillyTavern's final Chat Completion message array to the Responses
 * payload used by the Codex backend. No instructions, tools, or agent context
 * are inserted here.
 */
export function toResponsesRequest({ model, messages, stream, reasoningEffort, serviceTier, tools, toolChoice }) {
    const body = {
        model,
        input: messages.flatMap(toResponsesInputItems),
        // The Codex compatibility endpoint requires SSE even when SillyTavern
        // requested a non-streaming reply. The route aggregates that SSE only
        // for the non-streaming caller; browser streaming remains native.
        stream: true,
        store: false,
    };
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
    if (serviceTier) body.service_tier = serviceTier;
    if (Array.isArray(tools) && tools.length) {
        body.tools = tools.map(toResponsesTool);
        body.tool_choice = toResponsesToolChoice(toolChoice);
        body.parallel_tool_calls = false;
    }
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
    const functionCalls = (Array.isArray(response?.output) ? response.output : [])
        .filter(item => item?.type === 'function_call')
        .map(item => ({
            id: item.call_id ?? item.id,
            type: 'function',
            function: { name: item.name, arguments: String(item.arguments ?? '') },
        }));
    const content = extractOutputText(response);
    return {
        id: response?.id ?? `codex-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: response?.model ?? model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: content || null,
                ...(functionCalls.length ? { tool_calls: functionCalls } : {}),
            },
            finish_reason: response?.status === 'incomplete' ? 'length' : (functionCalls.length ? 'tool_calls' : 'stop'),
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

/** Convert Responses function-call lifecycle events to Chat Completion deltas. */
export function responseEventToolDelta(event, indexByItemId) {
    if (event?.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        const index = indexByItemId.size;
        indexByItemId.set(event.item.id ?? event.output_index, index);
        return {
            index,
            id: event.item.call_id ?? event.item.id,
            type: 'function',
            function: { name: event.item.name, arguments: String(event.item.arguments ?? '') },
        };
    }
    if (event?.type === 'response.function_call_arguments.delta') {
        const key = event.item_id ?? event.output_index;
        const index = indexByItemId.get(key) ?? Number(event.output_index ?? 0);
        return { index, function: { arguments: String(event.delta ?? '') } };
    }
    return null;
}

export function responseEventFailed(event) {
    return ['error', 'response.failed'].includes(event?.type);
}
