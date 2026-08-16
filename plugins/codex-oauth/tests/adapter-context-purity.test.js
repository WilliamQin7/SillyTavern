import assert from 'node:assert/strict';
import test from 'node:test';

import { adaptSillyTavernRequest } from '../server/adapter.js';
import { validateGenerateRequest } from '../server/validation.js';

test('adapter preserves the final SillyTavern message roles, order, and content exactly', () => {
    const messages = [
        { role: 'system', content: 'SYSTEM_TEST_123' },
        { role: 'assistant', content: 'ASSISTANT_TEST_789' },
        { role: 'user', content: 'USER_TEST_456' },
    ];
    const payload = adaptSillyTavernRequest({
        model: 'gpt-5.5',
        messages,
        stream: true,
        temperature: 0.9,
        tools: [{ type: 'function', function: { name: 'ignored' } }],
    }, { reasoningEffort: 'medium', serviceTier: 'priority' });

    assert.deepEqual(payload, {
        model: 'gpt-5.5',
        input: messages,
        stream: true,
        store: false,
        reasoning: { effort: 'medium' },
        service_tier: 'priority',
    });
    const serialized = JSON.stringify(payload).toLowerCase();
    for (const forbidden of ['coding agent', 'bash', 'shell', 'tools', 'agents.md', 'repository', 'working directory', 'mcp', 'skills']) {
        assert.equal(serialized.includes(forbidden), false, `payload must not insert ${forbidden}`);
    }
});

test('Codex upstream transport remains SSE when SillyTavern requests a normal response', () => {
    const payload = adaptSillyTavernRequest({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'normal reply' }],
        stream: false,
    });
    assert.equal(payload.stream, true);
});

test('request validation rejects tool schemas rather than silently passing them upstream', () => {
    assert.throws(() => validateGenerateRequest({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function' }],
    }), error => error.code === 'TOOLS_UNSUPPORTED');
});
