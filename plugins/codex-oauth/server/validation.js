import { CodexProviderError } from './upstream/errors.js';

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const SPEED_MODES = new Set(['standard', 'fast']);
const LOG_LEVELS = new Set(['brief', 'normal', 'detailed']);
const IMAGE_SIZES = new Set(['auto', '1024x1024', '1024x1536', '1536x1024']);
const IMAGE_QUALITIES = new Set(['auto', 'low', 'medium', 'high']);
const MODEL_ID_LIMIT = 100;
const TOOL_LIMIT = 16;
const TOOL_SCHEMA_LIMIT = 32_000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function assertModelId(model) {
    if (typeof model !== 'string' || model.trim().length === 0) {
        throw new CodexProviderError('MODEL_REQUIRED', 'Choose a Codex model or enter a model ID.', { status: 400 });
    }
    if (model.length > MODEL_ID_LIMIT || CONTROL_CHARACTERS.test(model)) {
        throw new CodexProviderError('INVALID_MODEL', 'The Codex model ID is invalid.', { status: 400 });
    }
}

function assertContent(content) {
    if (typeof content === 'string') return;
    if (Array.isArray(content) && content.every(part => part && typeof part === 'object')) return;
    throw new CodexProviderError('INVALID_MESSAGE_CONTENT', 'Each SillyTavern message must contain text content.', { status: 400 });
}

function assertToolCall(call) {
    if (!call || call.type !== 'function' || typeof call.id !== 'string' || !call.id) {
        throw new CodexProviderError('INVALID_TOOL_CALL', 'Assistant tool calls must include a function and call ID.', { status: 400 });
    }
    if (typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') {
        throw new CodexProviderError('INVALID_TOOL_CALL', 'Assistant tool calls must include a function name and JSON arguments.', { status: 400 });
    }
}

function assertToolDefinition(tool) {
    if (!tool || tool.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name) {
        throw new CodexProviderError('INVALID_TOOL', 'Codex tools must be function definitions with a name.', { status: 400 });
    }
    if (!tool.function.parameters || typeof tool.function.parameters !== 'object') {
        throw new CodexProviderError('INVALID_TOOL', 'Codex function tools require a JSON Schema parameters object.', { status: 400 });
    }
    if (!TOOL_NAME.test(tool.function.name) || JSON.stringify(tool.function.parameters).length > TOOL_SCHEMA_LIMIT) {
        throw new CodexProviderError('INVALID_TOOL', 'Codex function tools must have a bounded name and schema.', { status: 400 });
    }
}

/** Validates request structure only; it does not modify, order, or concatenate messages. */
export function validateGenerateRequest(body) {
    if (!body || typeof body !== 'object') {
        throw new CodexProviderError('INVALID_REQUEST', 'Generation request is missing.', { status: 400 });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw new CodexProviderError('INVALID_MESSAGES', 'Generation request must include at least one SillyTavern message.', { status: 400 });
    }
    for (const message of body.messages) {
        if (!message || typeof message !== 'object' || !ROLES.has(message.role)) {
            throw new CodexProviderError('INVALID_MESSAGE_ROLE', 'Codex supports system, developer, user, and assistant message roles.', { status: 400 });
        }
        if (message.role === 'tool') {
            if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) {
                throw new CodexProviderError('INVALID_TOOL_RESULT', 'Tool messages require a tool_call_id.', { status: 400 });
            }
            assertContent(message.content);
            continue;
        }
        if (message.content !== null && message.content !== undefined) assertContent(message.content);
        if (Array.isArray(message.tool_calls)) message.tool_calls.forEach(assertToolCall);
        if ((message.content === null || message.content === undefined) && !message.tool_calls?.length) {
            throw new CodexProviderError('INVALID_MESSAGE_CONTENT', 'Each message must contain text or tool calls.', { status: 400 });
        }
    }
    if (Array.isArray(body.tools)) {
        if (body.tools.length > TOOL_LIMIT) {
            throw new CodexProviderError('TOO_MANY_TOOLS', `Codex accepts at most ${TOOL_LIMIT} tools per request.`, { status: 400 });
        }
        body.tools.forEach(assertToolDefinition);
    }
    assertModelId(body.model);
}

export function requestedReasoningEffort(body) {
    const effort = body?.codex_oauth?.reasoningEffort;
    return typeof effort === 'string' ? effort : undefined;
}

export function requestedSpeedMode(body) {
    const value = body?.codex_oauth?.speedMode ?? 'standard';
    if (typeof value !== 'string' || !SPEED_MODES.has(value)) {
        throw new CodexProviderError('INVALID_SPEED_MODE', 'Choose Standard or Fast speed mode.', { status: 400 });
    }
    return value;
}

export function requestedLogLevel(body) {
    const value = body?.codex_oauth?.logLevel ?? 'normal';
    if (typeof value !== 'string' || !LOG_LEVELS.has(value)) {
        throw new CodexProviderError('INVALID_LOG_LEVEL', 'Choose Brief, Normal, or Detailed logging.', { status: 400 });
    }
    return value;
}

export function validateImageRequest(body) {
    if (!body || typeof body !== 'object') {
        throw new CodexProviderError('INVALID_REQUEST', 'Image generation request is missing.', { status: 400 });
    }
    if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0 || body.prompt.length > 32_000) {
        throw new CodexProviderError('INVALID_IMAGE_PROMPT', 'Image prompt must contain between 1 and 32,000 characters.', { status: 400 });
    }
    assertModelId(body.model);
    if (!IMAGE_SIZES.has(body.size)) {
        throw new CodexProviderError('INVALID_IMAGE_SIZE', 'Choose a supported Codex image size.', { status: 400 });
    }
    if (!IMAGE_QUALITIES.has(body.quality)) {
        throw new CodexProviderError('INVALID_IMAGE_QUALITY', 'Choose a supported Codex image quality.', { status: 400 });
    }
}
