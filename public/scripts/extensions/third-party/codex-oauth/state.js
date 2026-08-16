export const DEFAULT_PROVIDER_SETTINGS = Object.freeze({
    model: '',
    manualModel: '',
    reasoningEffort: 'auto',
    speedMode: 'standard',
    logLevel: 'normal',
    showPromptStructure: false,
});

export const PROVIDER_SETTINGS_KEY = 'codex_oauth';

export const SPEED_MODES = Object.freeze(['standard', 'fast']);
export const LOG_LEVELS = Object.freeze(['brief', 'normal', 'detailed']);

// Start new installs on the explicitly requested Luna model when the account
// exposes it, then fall back through the tracked compatibility set. Dynamic
// metadata can contain IDs that a particular ChatGPT subscription has not
// received yet.
export const PREFERRED_MODEL_IDS = Object.freeze([
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.3-codex-spark',
    'gpt-5.4',
    'gpt-5.4-mini',
]);

/** @param {{id?: string}[]} models */
export function selectPreferredModel(models) {
    const available = Array.isArray(models) ? models : [];
    return PREFERRED_MODEL_IDS.find(id => available.some(model => model?.id === id))
        ?? String(available[0]?.id ?? '');
}

export function normalizeProviderSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const speedMode = SPEED_MODES.includes(input.speedMode)
        ? input.speedMode
        : (input.fastMode === true ? 'fast' : DEFAULT_PROVIDER_SETTINGS.speedMode);
    return {
        model: typeof input.model === 'string' ? input.model : DEFAULT_PROVIDER_SETTINGS.model,
        manualModel: typeof input.manualModel === 'string' ? input.manualModel : DEFAULT_PROVIDER_SETTINGS.manualModel,
        reasoningEffort: typeof input.reasoningEffort === 'string' ? input.reasoningEffort : DEFAULT_PROVIDER_SETTINGS.reasoningEffort,
        speedMode,
        logLevel: LOG_LEVELS.includes(input.logLevel) ? input.logLevel : DEFAULT_PROVIDER_SETTINGS.logLevel,
        showPromptStructure: Boolean(input.showPromptStructure),
    };
}

/** Load from SillyTavern's extension settings, with a one-time legacy migration. */
export function loadProviderSettings(extensionSettings, legacySettings) {
    const target = extensionSettings && typeof extensionSettings === 'object' ? extensionSettings : {};
    const hasPersistedSettings = Object.prototype.hasOwnProperty.call(target, PROVIDER_SETTINGS_KEY);
    target[PROVIDER_SETTINGS_KEY] = normalizeProviderSettings(
        hasPersistedSettings ? target[PROVIDER_SETTINGS_KEY] : legacySettings,
    );
    return target[PROVIDER_SETTINGS_KEY];
}
