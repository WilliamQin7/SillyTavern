import { registerChatCompletionProvider } from '../../../src/chat-completion-provider-registry.js';
import { PLUGIN_ID } from './upstream/constants.js';
import { createCodexService, installRoutes } from './routes.js';

export const info = {
    id: PLUGIN_ID,
    name: 'Codex (ChatGPT) OAuth Provider',
    description: 'Server-side ChatGPT OAuth and Codex Responses compatibility provider for SillyTavern.',
};

let activeService = null;
let unregister = null;

export async function init(router) {
    if (activeService) return;
    if (!router || typeof router.get !== 'function' || typeof router.post !== 'function') {
        console.warn('[codex-oauth] compatibility warning: this SillyTavern build did not provide the expected server-plugin router; Codex provider was not activated.');
        return;
    }
    activeService = createCodexService();
    unregister = registerChatCompletionProvider(PLUGIN_ID, {
        status: (request, response) => activeService.connectionStatus(request, response),
        generate: (request, response) => activeService.generate(request, response),
    });
    installRoutes(router, activeService);
}

export async function exit() {
    unregister?.();
    unregister = null;
    await activeService?.shutdown();
    activeService = null;
}
