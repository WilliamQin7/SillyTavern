/**
 * Frontend companion to the server Chat Completion provider registry.
 *
 * External UI extensions register only the stable hooks they need. The core
 * Chat Completion pipeline continues to assemble messages and own streaming.
 */
const providers = new Map();

function assertProvider(definition) {
    if (!definition || typeof definition.id !== 'string' || !/^[a-z0-9_-]+$/.test(definition.id)) {
        throw new TypeError('External Chat Completion provider requires a lowercase id.');
    }
    if (typeof definition.getModel !== 'function') {
        throw new TypeError(`External Chat Completion provider '${definition.id}' requires getModel().`);
    }
}

/**
 * @typedef {object} ExternalChatCompletionProvider
 * @property {string} id
 * @property {(settings: object) => string} getModel
 * @property {(request: object, context: object) => (void|Promise<void>)} [configureRequest]
 * @property {{tools?: boolean, images?: boolean, temperature?: boolean}} [capabilities]
 */

/**
 * @param {ExternalChatCompletionProvider} definition Provider definition.
 * @returns {() => void} Unregister function.
 */
export function registerExternalChatCompletionProvider(definition) {
    assertProvider(definition);
    if (providers.has(definition.id)) {
        throw new Error(`External Chat Completion provider '${definition.id}' is already registered.`);
    }
    providers.set(definition.id, Object.freeze({ ...definition }));
    return () => providers.delete(definition.id);
}

/** @param {string} id Provider id. */
export function getExternalChatCompletionProvider(id) {
    return providers.get(id);
}

/** @returns {string[]} Registered provider ids. */
export function getExternalChatCompletionProviderIds() {
    return [...providers.keys()];
}
