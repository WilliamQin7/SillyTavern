/**
 * Runtime registry for server plugins that implement a Chat Completion source.
 *
 * A plugin receives the original Express request, so user-scoped credentials
 * never need to be round-tripped through a frontend setting or an internal
 * HTTP proxy.
 */
const providers = new Map();

function assertProviderId(id) {
    if (typeof id !== 'string' || !/^[a-z0-9_-]+$/.test(id)) {
        throw new TypeError('Chat completion provider id must contain only lowercase letters, numbers, hyphens, or underscores.');
    }
}

/**
 * Register a server-side Chat Completion provider.
 * @param {string} id Provider id used by the frontend source selector.
 * @param {{status?: Function, generate?: Function}} provider Provider handlers.
 * @returns {() => void} Unregister function.
 */
export function registerChatCompletionProvider(id, provider) {
    assertProviderId(id);
    if (!provider || (typeof provider.status !== 'function' && typeof provider.generate !== 'function')) {
        throw new TypeError('Chat completion provider must implement status and/or generate.');
    }
    if (providers.has(id)) {
        throw new Error(`Chat completion provider '${id}' is already registered.`);
    }

    providers.set(id, provider);
    return () => providers.delete(id);
}

/**
 * @param {string} id Provider id.
 * @returns {{status?: Function, generate?: Function}|undefined}
 */
export function getChatCompletionProvider(id) {
    return providers.get(id);
}

/** @returns {string[]} Registered provider ids. */
export function getChatCompletionProviderIds() {
    return [...providers.keys()];
}
