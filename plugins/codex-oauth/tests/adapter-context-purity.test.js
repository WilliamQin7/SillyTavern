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

test('request validation accepts bounded function schemas and rejects malformed tools', () => {
    assert.doesNotThrow(() => validateGenerateRequest({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'AmyStudioRemember', parameters: { type: 'object' } } }],
    }));
    assert.throws(() => validateGenerateRequest({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function' }],
    }), error => error.code === 'INVALID_TOOL');
});

test('adapter preserves function-call linkage across a tool round trip', () => {
    const payload = adaptSillyTavernRequest({
        model: 'gpt-5.5',
        messages: [
            { role: 'user', content: 'remember this' },
            {
                role: 'assistant', content: null,
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'AmyStudioRemember', arguments: '{"title":"A"}' } }],
            },
            { role: 'tool', tool_call_id: 'call-1', content: 'Saved.' },
        ],
        tools: [{
            type: 'function',
            function: { name: 'AmyStudioRemember', description: 'Remember', parameters: { type: 'object' } },
        }],
        tool_choice: 'auto',
    });
    assert.deepEqual(payload.input.slice(-2), [
        { type: 'function_call', call_id: 'call-1', name: 'AmyStudioRemember', arguments: '{"title":"A"}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'Saved.' },
    ]);
    assert.deepEqual(payload.tools, [{
        type: 'function', name: 'AmyStudioRemember', description: 'Remember', parameters: { type: 'object' }, strict: false,
    }]);
    assert.equal(payload.parallel_tool_calls, false);
});

test('request validation rejects model IDs that can inject log lines or exceed the bounded field', () => {
    const request = model => ({ model, messages: [{ role: 'user', content: 'hello' }] });
    assert.throws(() => validateGenerateRequest(request('gpt-5.5\nforged-log-line')), error => error.code === 'INVALID_MODEL');
    assert.throws(() => validateGenerateRequest(request('x'.repeat(101))), error => error.code === 'INVALID_MODEL');
});
