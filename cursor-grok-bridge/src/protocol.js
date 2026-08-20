const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

export function contentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

    return content.map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' || part?.type === 'input_text') return String(part.text ?? '');
        if (part?.type === 'image_url' || part?.type === 'input_image') return '[Image omitted by Cursor bridge]';
        return JSON.stringify(part);
    }).join('\n');
}

export function formatMessages(messages) {
    const conversation = messages.map((message) => ({
        role: String(message?.role ?? 'user'),
        content: contentToText(message?.content),
        ...(message?.name ? { name: String(message.name) } : {}),
    }));

    return [
        'Act as the chat assistant for the conversation below.',
        'Follow the system and developer messages in the supplied conversation.',
        'Do not discuss this wrapper, Cursor, coding-agent behavior, tools, or the JSON format.',
        'Reply only with the next assistant message. Do not add role labels or metadata.',
        '',
        '<conversation-json>',
        JSON.stringify(conversation),
        '</conversation-json>',
    ].join('\n');
}

export function resolveModelSelection(body) {
    const requested = String(body?.model ?? 'grok-4.6-high-fast').toLowerCase();
    if (!requested.startsWith('grok-4.6')) {
        throw new Error(`Unsupported model: ${body?.model ?? requested}`);
    }

    const suffixes = requested.slice('grok-4.6'.length).split('-').filter(Boolean);
    const suffixEffort = suffixes.find((value) => EFFORTS.has(value));
    const bodyEffort = EFFORTS.has(body?.reasoning_effort) ? body.reasoning_effort : undefined;
    const effort = suffixEffort ?? bodyEffort ?? 'high';
    const fast = suffixes.includes('fast') || requested === 'grok-4.6';

    return {
        id: 'grok-4.6',
        params: [
            { id: 'effort', value: effort },
            { id: 'fast', value: String(fast) },
        ],
    };
}

export function publicModels(created = Math.floor(Date.now() / 1000)) {
    const efforts = ['low', 'medium', 'high', 'xhigh'];
    const ids = new Set(['grok-4.6-high-fast', 'grok-4.6', 'grok-4.6-fast']);
    for (const effort of efforts) {
        ids.add(`grok-4.6-${effort}`);
        ids.add(`grok-4.6-${effort}-fast`);
    }
    return [...ids].map((id) => ({ id, object: 'model', created, owned_by: 'cursor-subscription' }));
}

export function openAiUsage(usage) {
    if (!usage) return undefined;
    const promptTokens = Number(usage.inputTokens ?? 0);
    const completionTokens = Number(usage.outputTokens ?? 0);
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: Number(usage.totalTokens ?? promptTokens + completionTokens),
    };
}
