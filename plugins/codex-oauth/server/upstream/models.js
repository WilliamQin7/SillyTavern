import { CODEX_CAPABILITIES, FALLBACK_MODELS } from './constants.js';
import { CodexProviderError } from './errors.js';

function localModels() {
    return FALLBACK_MODELS.map((model) => ({
        ...model,
        contextLength: null,
        outputTokenLimit: null,
        capabilities: {
            ...CODEX_CAPABILITIES,
            reasoningEfforts: [],
            fastMode: Boolean(model.fastServiceTier),
            fastServiceTier: model.fastServiceTier ?? null,
        },
        source: 'bundled',
    }));
}

/**
 * A local-only catalog. Model IDs can still be entered manually, but listing
 * models never contacts an unrelated metadata service.
 */
export class ModelCatalog {
    async list() {
        return localModels();
    }

    async find(modelId) {
        const id = String(modelId ?? '').trim();
        if (!id) throw new CodexProviderError('MODEL_REQUIRED', 'Choose a Codex model or enter a model ID.', { status: 400 });
        const model = (await this.list()).find(item => item.id === id);
        return model ?? {
            id,
            name: id,
            contextLength: null,
            outputTokenLimit: null,
            capabilities: { ...CODEX_CAPABILITIES, reasoningEfforts: [] },
            source: 'manual',
        };
    }
}

/** @param {object} model @param {string|undefined} speedMode */
export function assertSupportedSpeedMode(model, speedMode) {
    const value = String(speedMode ?? 'standard').trim();
    if (!value || value === 'standard') return undefined;
    if (value !== 'fast') {
        throw new CodexProviderError('INVALID_SPEED_MODE', 'Choose Standard or Fast speed mode.', { status: 400 });
    }
    const serviceTier = model?.capabilities?.fastServiceTier;
    if (serviceTier !== 'priority') {
        throw new CodexProviderError('UNSUPPORTED_SPEED_MODE', 'The selected Codex model does not advertise Fast mode support.', { status: 400 });
    }
    return serviceTier;
}

/** @param {object} model @param {string|undefined} effort */
export function assertSupportedReasoning(model, effort) {
    const value = String(effort ?? '').trim();
    if (!value || value === 'auto') return undefined;
    const supported = model?.capabilities?.reasoningEfforts ?? [];
    if (supported.length > 0 && !supported.includes(value)) {
        throw new CodexProviderError('UNSUPPORTED_REASONING', 'The selected reasoning effort is not supported by this Codex model.', { status: 400 });
    }
    return value;
}
