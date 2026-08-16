import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EncryptedCredentialStore, LayeredCredentialStore, SharedCodexCredentialSource } from '../server/credentials.js';
import { CodexUpstreamClient } from '../server/upstream/client.js';

test('credential store encrypts token fields and binds ciphertext to the SillyTavern user identity', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-oauth-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, '.codex-oauth.credentials.enc');
    const credentials = { accessToken: 'access-token-secret', refreshToken: 'refresh-token-secret', expiresAt: 123, accountId: 'acct-a' };
    const store = new EncryptedCredentialStore({ filePath, masterSecret: 'persistent-cookie-secret', identity: 'user-a' });

    await store.write(credentials);
    const saved = await fs.readFile(filePath, 'utf8');
    assert.doesNotMatch(saved, /access-token-secret|refresh-token-secret/);
    assert.deepEqual(await store.read(), credentials);

    const otherUserStore = new EncryptedCredentialStore({ filePath, masterSecret: 'persistent-cookie-secret', identity: 'user-b' });
    await assert.rejects(otherUserStore.read(), error => error.code === 'CREDENTIAL_STORE_UNREADABLE');
    await store.clear();
    assert.equal(await store.read(), null);
});

test('shared Codex credentials are read without mutation and JWT expiry wins over refresh time', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-shared-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'auth.json');
    const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString('base64url');
    const accessToken = `header.${payload}.signature`;
    const document = {
        last_refresh: '2020-01-01T00:00:00.000Z',
        tokens: { access_token: accessToken, refresh_token: 'shared-refresh', id_token: 'id', account_id: 'acct' },
    };
    await fs.writeFile(filePath, JSON.stringify(document), 'utf8');
    const before = await fs.readFile(filePath, 'utf8');

    const credentials = await new SharedCodexCredentialSource({ filePath, logger: { warn() {} } }).read();
    assert.equal(credentials.accessToken, accessToken);
    assert.equal(credentials.refreshToken, 'shared-refresh');
    assert.equal(credentials.expiresAt, 1_900_000_000_000);
    assert.equal(credentials.credentialSource, 'codex-cli');
    assert.equal(await fs.readFile(filePath, 'utf8'), before);
});

test('layered store copies refreshes into encrypted storage and disconnect only disables shared reuse', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-layered-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sharedDocument = path.join(directory, 'auth.json');
    await fs.writeFile(sharedDocument, JSON.stringify({ tokens: { access_token: 'shared-access', refresh_token: 'shared-refresh' } }), 'utf8');
    const primary = new EncryptedCredentialStore({
        filePath: path.join(directory, 'credentials.enc'),
        masterSecret: 'secret',
        identity: 'owner',
    });
    const store = new LayeredCredentialStore({
        primary,
        shared: new SharedCodexCredentialSource({ filePath: sharedDocument, logger: { warn() {} } }),
        disabledFilePath: path.join(directory, 'shared-disabled'),
    });

    assert.equal((await store.read()).credentialSource, 'codex-cli');
    await store.write({ accessToken: 'refreshed-access', refreshToken: 'refreshed-token', expiresAt: 123, credentialSource: 'codex-cli' });
    assert.equal((await store.read()).accessToken, 'refreshed-access');
    assert.match(await fs.readFile(primary.filePath, 'utf8'), /ciphertext/);
    assert.doesNotMatch(await fs.readFile(primary.filePath, 'utf8'), /refreshed-access/);
    await store.clear();
    assert.equal(await store.read(), null);
    assert.match(await fs.readFile(sharedDocument, 'utf8'), /shared-access/);
    assert.equal((await store.enableShared()).accessToken, 'shared-access');
});

test('refresh uses one per-user flight and retains the previous refresh token when unrotated', async () => {
    let stored = { accessToken: 'old-access', refreshToken: 'keep-refresh', expiresAt: 0 };
    let calls = 0;
    const store = {
        key: 'user-store',
        async read() { return stored; },
        async write(value) { stored = value; },
        async clear() { stored = null; },
    };
    const client = new CodexUpstreamClient({
        now: () => 10_000,
        refreshFn: async () => {
            calls += 1;
            await new Promise(resolve => setTimeout(resolve, 10));
            return { access_token: 'new-access', expires_in: 3600 };
        },
        logger: { info() {}, warn() {} },
    });

    const [left, right] = await Promise.all([
        client.refreshCredentials(store, 'user-a'),
        client.refreshCredentials(store, 'user-a'),
    ]);
    assert.equal(calls, 1);
    assert.equal(left.accessToken, 'new-access');
    assert.equal(right.refreshToken, 'keep-refresh');
    assert.equal(stored.refreshToken, 'keep-refresh');
});

test('a single 401 triggers refresh then retries once with refreshed credentials', async () => {
    let stored = { accessToken: 'old-access', refreshToken: 'refresh', accountId: 'acct-123', expiresAt: Date.now() + 3_600_000 };
    const store = {
        key: 'user-store',
        async read() { return stored; },
        async write(value) { stored = value; },
        async clear() { stored = null; },
    };
    const requestHeaders = [];
    const logs = [];
    let fetchCalls = 0;
    const client = new CodexUpstreamClient({
        fetchImpl: async (_url, request) => {
            fetchCalls += 1;
            requestHeaders.push(request.headers);
            return fetchCalls === 1
                ? new Response(JSON.stringify({ error: { code: 'invalid_token' } }), { status: 401 })
                : new Response(JSON.stringify({ id: 'response-1', output_text: 'OK' }), { status: 200 });
        },
        refreshFn: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
        logger: { info(message) { logs.push(message); }, warn() {} },
    });

    const response = await client.request({
        store,
        userKey: 'user-a',
        requestId: 'request-1',
        body: { model: 'gpt-5.5', input: [], stream: false },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(requestHeaders.map(headers => headers.Authorization), ['Bearer old-access', 'Bearer new-access']);
    assert.equal(requestHeaders[0]['ChatGPT-Account-Id'], 'acct-123');
    assert.equal(requestHeaders[0].originator, 'opencode');
    assert.equal(requestHeaders[0]['session-id'], 'request-1');
    assert.equal(requestHeaders[0].Accept, 'application/json');
    assert.equal(stored.refreshToken, 'new-refresh');
    assert.ok(logs.some(message => message.includes('upstream request sent (id=request-1, model=gpt-5.5')));
    assert.ok(logs.some(message => message.includes('upstream response headers received (id=request-1, status=200')));
    assert.equal(logs.join('\n').includes('old-access'), false);
    assert.equal(logs.join('\n').includes('new-access'), false);
});
