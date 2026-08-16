import assert from 'node:assert/strict';
import test from 'node:test';

import {
    LoopbackLoginManager,
    buildAuthorizationUrl,
    exchangeAuthorizationCode,
    extractAccountId,
    generatePkcePair,
    generateState,
    refreshAccessToken,
} from '../server/upstream/oauth.js';
import { OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI, OAUTH_SCOPE } from '../server/upstream/constants.js';

function jwt(claims) {
    return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

test('OAuth PKCE authorization URL contains the tracked client parameters', () => {
    const pkce = generatePkcePair();
    const state = generateState();
    assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.match(state, /^[A-Za-z0-9_-]{32,}$/);

    const url = new URL(buildAuthorizationUrl({ redirectUri: OAUTH_REDIRECT_URI, pkce, state }));
    assert.equal(url.origin, 'https://auth.openai.com');
    assert.equal(url.pathname, '/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), OAUTH_CLIENT_ID);
    assert.equal(url.searchParams.get('scope'), OAUTH_SCOPE);
    assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), state);
});

test('token exchange sends PKCE verifier and refresh preserves an unrotated token', async () => {
    const requests = [];
    const fetchImpl = async (_url, request) => {
        requests.push(new URLSearchParams(request.body));
        return new Response(JSON.stringify({
            access_token: requests.length === 1 ? 'access-from-code' : 'access-from-refresh',
            ...(requests.length === 1 ? { refresh_token: 'rotated-refresh' } : {}),
            expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const exchanged = await exchangeAuthorizationCode({ code: 'code-123', verifier: 'verifier-123', fetchImpl });
    const refreshed = await refreshAccessToken({ refreshToken: 'rotated-refresh', fetchImpl });

    assert.equal(exchanged.refresh_token, 'rotated-refresh');
    assert.equal(refreshed.access_token, 'access-from-refresh');
    assert.equal(refreshed.refresh_token, undefined);
    assert.equal(requests[0].get('grant_type'), 'authorization_code');
    assert.equal(requests[0].get('code_verifier'), 'verifier-123');
    assert.equal(requests[1].get('grant_type'), 'refresh_token');
    assert.equal(requests[1].get('refresh_token'), 'rotated-refresh');
});

test('account ID is read from the ChatGPT OAuth claims without exposing a token', () => {
    assert.equal(extractAccountId({ access_token: jwt({ chatgpt_account_id: 'acct-direct' }) }), 'acct-direct');
    assert.equal(extractAccountId({ id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-nested' } }) }), 'acct-nested');
    assert.equal(extractAccountId({ access_token: 'not-a-jwt' }), undefined);
});

test('loopback callback rejects a bad state without cancelling the matching transaction', async () => {
    const opened = [];
    const saved = [];
    const manager = new LoopbackLoginManager({
        port: 0,
        timeoutMs: 5_000,
        openBrowser: async url => opened.push(url),
        exchangeCode: async ({ code }) => ({ access_token: `access-${code}`, refresh_token: 'refresh' }),
        logger: { info() {}, warn() {} },
    });
    await manager.start({ userKey: 'user-a', onTokens: async tokens => saved.push(tokens) });
    const server = manager.active.servers[0];
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}/auth/callback`;

    const bad = await fetch(`${base}?code=bad&state=wrong`);
    assert.equal(bad.status, 400);
    assert.equal(saved.length, 0);

    const successUrl = new URL(opened[0]);
    const good = await fetch(`${base}?code=good&state=${encodeURIComponent(successUrl.searchParams.get('state'))}`);
    assert.equal(good.status, 200);
    assert.deepEqual(saved, [{ access_token: 'access-good', refresh_token: 'refresh' }]);
    await manager.shutdown();
});
