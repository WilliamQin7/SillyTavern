import { toChatCompletionResponse, toResponsesRequest } from './upstream/protocol.js';

export const capabilities = Object.freeze({
    streaming: true,
    reasoning: true,
    temperature: false,
    tools: true,
    images: true,
});

/** Stable SillyTavern-to-Codex boundary. */
export function adaptSillyTavernRequest(body, { reasoningEffort, serviceTier } = {}) {
    return toResponsesRequest({
        model: body.model,
        messages: body.messages,
        stream: body.stream,
        reasoningEffort,
        serviceTier,
        tools: body.tools,
        toolChoice: body.tool_choice,
    });
}

/** Stable Codex-to-SillyTavern boundary. */
export function adaptCodexResponse(response, model) {
    return toChatCompletionResponse(response, model);
}

export function adaptImageRequest({ model, prompt, size, quality }) {
    const imageTool = {
        type: 'image_generation',
        output_format: 'png',
        size,
        quality,
    };
    return {
        model,
        instructions: 'Create exactly one image that follows the user request. Use the image generation tool.',
        input: [{ role: 'user', content: prompt }],
        tools: [imageTool],
        tool_choice: { type: 'image_generation' },
        stream: true,
        store: false,
    };
}
