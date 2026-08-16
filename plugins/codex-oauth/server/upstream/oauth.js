import crypto from 'node:crypto';
import http from 'node:http';

import {
    OAUTH_CLIENT_ID,
    OAUTH_ISSUER,
    OAUTH_LOGIN_TIMEOUT_MS,
    OAUTH_LOOPBACK_PORT,
    OAUTH_REDIRECT_URI,
    OAUTH_SCOPE,
} from './constants.js';
import { CodexProviderError } from './errors.js';

/** @returns {{ verifier: string, challenge: string }} */
export function generatePkcePair() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/** @returns {string} */
export function generateState() {
    return crypto.randomBytes(32).toString('base64url');
}

/** @param {{redirectUri: string, pkce: {challenge: string}, state: string}} options */
export function buildAuthorizationUrl({ redirectUri, pkce, state }) {
    const parameters = new URLSearchParams({
        response_type: 'code',
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        scope: OAUTH_SCOPE,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator: 'opencode',
    });
    return `${OAUTH_ISSUER}/oauth/authorize?${parameters.toString()}`;
}

async function requestToken(parameters, fetchImpl = globalThis.fetch, { requireRefreshToken = true } = {}) {
    let response;
    try {
        response = await fetchImpl(`${OAUTH_ISSUER}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(parameters).toString(),
        });
    } catch (error) {
        throw new CodexProviderError('OAUTH_NETWORK_FAILURE', 'Could not reach ChatGPT sign-in. Try again.', { status: 502, retryable: true, cause: error });
    }
    if (!response.ok) {
        throw new CodexProviderError('OAUTH_TOKEN_EXCHANGE_FAILED', 'ChatGPT sign-in did not complete. Please try again.', { status: 401 });
    }
    const tokens = await response.json();
    // A refresh response is allowed to omit refresh_token when the issuer does
    // not rotate it. The caller retains the existing encrypted refresh token.
    if (!tokens?.access_token || (requireRefreshToken && !tokens?.refresh_token)) {
        throw new CodexProviderError('OAUTH_INVALID_TOKEN_RESPONSE', 'ChatGPT sign-in returned an invalid token response. Please try again.', { status: 502 });
    }
    return tokens;
}

/** @param {{code: string, verifier: string, redirectUri?: string, fetchImpl?: typeof fetch}} options */
export function exchangeAuthorizationCode({ code, verifier, redirectUri = OAUTH_REDIRECT_URI, fetchImpl }) {
    return requestToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: OAUTH_CLIENT_ID,
        code_verifier: verifier,
    }, fetchImpl);
}

/** @param {{refreshToken: string, fetchImpl?: typeof fetch}} options */
export function refreshAccessToken({ refreshToken, fetchImpl }) {
    return requestToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
    }, fetchImpl, { requireRefreshToken: false });
}

/** @param {string} token */
export function parseJwtClaims(token) {
    const segments = String(token ?? '').split('.');
    if (segments.length !== 3) return undefined;
    try {
        return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    } catch {
        return undefined;
    }
}

/** @param {{id_token?: string, access_token?: string}} tokens */
export function extractAccountId(tokens) {
    for (const token of [tokens?.id_token, tokens?.access_token]) {
        const claims = parseJwtClaims(token);
        const accountId = claims?.chatgpt_account_id
            ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id
            ?? claims?.organizations?.[0]?.id;
        if (typeof accountId === 'string' && accountId.length > 0) return accountId;
    }
    return undefined;
}

function listenLoopback(server, host, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host, port, exclusive: true });
    });
}

function closeServer(server) {
    if (!server?.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
}

function callbackPage(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p><p>You may close this tab and return to SillyTavern.</p></main></body></html>`;
}

/**
 * Owns one process-wide loopback OAuth login at a time. Both IPv4 and IPv6
 * loopback listeners are attempted; neither listener is reachable externally.
 */
export class LoopbackLoginManager {
    constructor({ openBrowser, exchangeCode = exchangeAuthorizationCode, logger = console, port = OAUTH_LOOPBACK_PORT, timeoutMs = OAUTH_LOGIN_TIMEOUT_MS } = {}) {
        this.openBrowser = openBrowser;
        this.exchangeCode = exchangeCode;
        this.logger = logger;
        this.port = port;
        this.timeoutMs = timeoutMs;
        this.active = null;
    }

    async start({ userKey, onTokens }) {
        if (this.active) {
            throw new CodexProviderError('OAUTH_LOGIN_IN_PROGRESS', 'A ChatGPT sign-in is already in progress. Finish it or cancel it before starting another.', { status: 409 });
        }
        if (typeof this.openBrowser !== 'function') {
            throw new CodexProviderError('BROWSER_LAUNCH_UNAVAILABLE', 'Could not open the system browser for ChatGPT sign-in.', { status: 500 });
        }

        const pkce = generatePkcePair();
        const state = generateState();
        const active = { userKey, pkce, state, onTokens, servers: [], timeout: null };
        this.active = active;
        try {
            await this.#startServers(active);
            active.timeout = setTimeout(() => this.#fail(active, 'OAuth login timed out.'), this.timeoutMs);
            const url = buildAuthorizationUrl({ redirectUri: OAUTH_REDIRECT_URI, pkce, state });
            await this.openBrowser(url);
            this.logger.info?.('login started');
            return { started: true };
        } catch (error) {
            await this.#clear(active);
            if (error instanceof CodexProviderError) throw error;
            throw new CodexProviderError('OAUTH_CALLBACK_UNAVAILABLE', 'Could not start the local ChatGPT sign-in callback server. Make sure port 1455 is available.', { status: 500, cause: error });
        }
    }

    async cancel(userKey) {
        const active = this.active;
        if (!active || active.userKey !== userKey) return false;
        await this.#clear(active);
        this.logger.info?.('login cancelled');
        return true;
    }

    async shutdown() {
        if (this.active) await this.#clear(this.active);
    }

    async #startServers(active) {
        const listener = (request, response) => this.#handleCallback(active, request, response);
        const ipv4 = http.createServer(listener);
        await listenLoopback(ipv4, '127.0.0.1', this.port);
        active.servers.push(ipv4);

        const ipv6 = http.createServer(listener);
        try {
            await listenLoopback(ipv6, '::1', this.port);
            active.servers.push(ipv6);
        } catch {
            // IPv4 loopback is sufficient on systems without IPv6 loopback support.
            if (ipv6.listening) ipv6.close();
        }
    }

    async #handleCallback(active, request, response) {
        const callbackUrl = new URL(request.url ?? '/', OAUTH_REDIRECT_URI);
        if (callbackUrl.pathname === '/cancel') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(callbackPage('Sign-in cancelled', 'The sign-in request was cancelled.'));
            await this.cancel(active.userKey);
            return;
        }
        if (callbackUrl.pathname !== '/auth/callback') {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }

        const state = callbackUrl.searchParams.get('state');
        const code = callbackUrl.searchParams.get('code');
        const oauthError = callbackUrl.searchParams.get('error');
        if (this.active !== active || state !== active.state) {
            response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(callbackPage('Sign-in failed', 'The sign-in state could not be verified. Start sign-in again from SillyTavern.'));
            return;
        }
        if (oauthError || !code) {
            response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(callbackPage('Sign-in failed', 'ChatGPT sign-in did not return an authorization code.'));
            await this.#clear(active);
            return;
        }

        try {
            const tokens = await this.exchangeCode({ code, verifier: active.pkce.verifier, redirectUri: OAUTH_REDIRECT_URI });
            await active.onTokens(tokens);
            this.logger.info?.('login succeeded');
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(callbackPage('Sign-in complete', 'ChatGPT is connected.'));
            await this.#clear(active);
        } catch (error) {
            this.logger.warn?.('login failed');
            response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(callbackPage('Sign-in failed', 'ChatGPT sign-in could not be completed. Start it again from SillyTavern.'));
            await this.#clear(active);
        }
    }

    async #fail(active) {
        if (this.active !== active) return;
        await this.#clear(active);
        this.logger.warn?.('login timed out');
    }

    async #clear(active) {
        if (active.timeout) clearTimeout(active.timeout);
        if (this.active === active) this.active = null;
        await Promise.allSettled(active.servers.map(closeServer));
        active.servers.length = 0;
    }
}
