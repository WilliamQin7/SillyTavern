/**
 * Volatile Codex/OpenAI compatibility values.
 *
 * Keep every upstream-sensitive value in this module so upstream syncs do not
 * leak into the SillyTavern integration layer.
 */
export const PLUGIN_ID = 'codex-oauth';
export const PLUGIN_VERSION = '0.2.0';

export const UPSTREAM_TRACKING = Object.freeze({
    repository: 'anomalyco/opencode',
    branch: 'dev',
    commit: '38e10eb1408feb700021b8e8766fb0ab41bf84e2',
});

// Verified against the tracked OpenCode Codex plugin source.
export const OAUTH_ISSUER = 'https://auth.openai.com';
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OAUTH_SCOPE = 'openid profile email offline_access';
export const OAUTH_LOOPBACK_PORT = 1455;
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_LOOPBACK_PORT}/auth/callback`;
export const OAUTH_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export const CODEX_RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
export const REFRESH_EARLY_MS = 60 * 1000;
// Reasoning-capable Codex models can take several minutes before sending the
// first upstream response. The downstream SSE heartbeat keeps SillyTavern's
// connection alive during that period; this guard only limits the initial
// upstream connection wait.
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const CREDENTIAL_FILE_NAME = '.codex-oauth.credentials.enc';

/** Current OpenCode Codex fallback models, used only when metadata is unavailable. */
export const FALLBACK_MODELS = Object.freeze([
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', fastServiceTier: 'priority' },
    { id: 'gpt-5.5', name: 'GPT-5.5', fastServiceTier: 'priority' },
    { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
    { id: 'gpt-5.4', name: 'GPT-5.4', fastServiceTier: 'priority' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', fastServiceTier: 'priority' },
]);

export const CODEX_CAPABILITIES = Object.freeze({
    streaming: true,
    reasoning: true,
    temperature: false,
    topP: false,
    frequencyPenalty: false,
    presencePenalty: false,
    maxOutputTokens: false,
    tools: false,
    images: true,
});
