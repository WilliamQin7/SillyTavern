export function resolveStudioAssistantModel(provider = {}) {
    return String(provider.manualModel || provider.model || 'gpt-5.4').trim();
}

export function resolveStoryGenerationModel(settings, getChatCompletionModel) {
    const model = typeof getChatCompletionModel === 'function' ? getChatCompletionModel(settings) : '';
    return String(model || settings?.chat_completion_source || '').trim();
}
