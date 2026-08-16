import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { adaptImageRequest } from '../server/adapter.js';
import { EncryptedCredentialStore } from '../server/credentials.js';
import { collectCodexImage, collectCodexStream, forwardCodexStream } from '../server/stream.js';
import { ModelCatalog } from '../server/upstream/models.js';
import { validateImageRequest } from '../server/validation.js';

function sseBody(events) {
    const text = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n';
    return new Response(text).body;
}

test('credential store encrypts tokens and binds ciphertext to one user', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-codex-oauth-'));
    const filePath = path.join(root, 'credentials.enc');
    const credentials = {
        accessToken: 'access-secret-value',
        refreshToken: 'refresh-secret-value',
        expiresAt: Date.now() + 60_000,
    };
    try {
        const ownerStore = new EncryptedCredentialStore({ filePath, masterSecret: 'server-secret', identity: 'owner' });
        await ownerStore.write(credentials);
        const ciphertext = await fs.readFile(filePath, 'utf8');
        assert.equal(ciphertext.includes(credentials.accessToken), false);
        assert.equal(ciphertext.includes(credentials.refreshToken), false);
        assert.deepEqual(await ownerStore.read(), credentials);

        const otherStore = new EncryptedCredentialStore({ filePath, masterSecret: 'server-secret', identity: 'other-user' });
        await assert.rejects(otherStore.read(), error => error.code === 'CREDENTIAL_STORE_UNREADABLE');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('image request uses only the native image tool and disables storage', () => {
    const body = adaptImageRequest({
        model: 'gpt-5.4',
        prompt: 'A red fox under moonlight',
        size: '1024x1024',
        quality: 'high',
    });
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.tool_choice, { type: 'image_generation' });
    assert.deepEqual(body.tools, [{
        type: 'image_generation',
        output_format: 'png',
        size: '1024x1024',
        quality: 'high',
    }]);
});

test('image stream returns bytes without mixing in text events', async () => {
    const image = await collectCodexImage({
        upstreamBody: sseBody([
            { type: 'response.output_text.delta', delta: 'ignored' },
            {
                type: 'response.output_item.done',
                item: { type: 'image_generation_call', result: 'aW1hZ2U=', revised_prompt: 'A refined prompt' },
            },
            { type: 'response.completed', response: { status: 'completed' } },
        ]),
    });
    assert.deepEqual(image, { data: 'aW1hZ2U=', revisedPrompt: 'A refined prompt' });
});

test('an incomplete text response remains a normal length-limited completion', async () => {
    const response = await collectCodexStream({
        upstreamBody: sseBody([
            { type: 'response.output_text.delta', delta: 'partial reply' },
            { type: 'response.incomplete', response: { id: 'response-1', status: 'incomplete' } },
        ]),
        model: 'gpt-5.5',
        requestId: 'request-1',
    });
    assert.equal(response.output_text, 'partial reply');
    assert.equal(response.status, 'incomplete');
});

test('an incomplete streaming response ends with the length finish reason', async () => {
    const writes = [];
    const response = {
        writableEnded: false,
        destroyed: false,
        write(chunk) {
            writes.push(chunk);
            return true;
        },
    };
    await forwardCodexStream({
        upstreamBody: sseBody([
            { type: 'response.output_text.delta', delta: 'partial reply' },
            { type: 'response.incomplete', response: { id: 'response-1', status: 'incomplete' } },
        ]),
        response,
        model: 'gpt-5.5',
        requestId: 'request-1',
    });

    const events = writes
        .map(chunk => chunk.match(/^data: (.+)\n\n$/)?.[1])
        .filter(data => data && data !== '[DONE]')
        .map(data => JSON.parse(data));
    assert.equal(events.at(-1).choices[0].finish_reason, 'length');
    assert.equal(writes.at(-1), 'data: [DONE]\n\n');
});

test('image validation rejects unbounded inputs and unknown options', () => {
    assert.throws(
        () => validateImageRequest({ prompt: '', model: 'gpt-5.4', size: '1024x1024', quality: 'auto' }),
        error => error.code === 'INVALID_IMAGE_PROMPT',
    );
    assert.throws(
        () => validateImageRequest({ prompt: 'ok', model: 'gpt-5.4', size: '99999x99999', quality: 'auto' }),
        error => error.code === 'INVALID_IMAGE_SIZE',
    );
});

test('model listing is deterministic and local', async () => {
    const models = await new ModelCatalog().list();
    assert.ok(models.length > 0);
    assert.ok(models.every(model => model.source === 'bundled'));
});
