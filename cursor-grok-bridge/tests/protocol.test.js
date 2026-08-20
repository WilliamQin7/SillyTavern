import test from 'node:test';
import assert from 'node:assert/strict';
import { contentToText, formatMessages, openAiUsage, publicModels, resolveModelSelection } from '../src/protocol.js';

test('contentToText accepts SillyTavern/OpenAI text parts', () => {
    assert.equal(contentToText('hello'), 'hello');
    assert.equal(contentToText([{ type: 'text', text: 'one' }, { type: 'input_text', text: 'two' }]), 'one\ntwo');
});

test('formatMessages preserves roles and content as JSON', () => {
    const prompt = formatMessages([
        { role: 'system', content: 'Stay in character.' },
        { role: 'user', content: 'Hello' },
    ]);
    assert.match(prompt, /"role":"system"/);
    assert.match(prompt, /Stay in character/);
    assert.match(prompt, /Reply only with the next assistant message/);
});

test('resolveModelSelection maps model variants and reasoning effort', () => {
    assert.deepEqual(resolveModelSelection({ model: 'grok-4.6-low-fast' }), {
        id: 'grok-4.6',
        params: [
            { id: 'effort', value: 'low' },
            { id: 'fast', value: 'true' },
        ],
    });
    assert.equal(resolveModelSelection({ model: 'grok-4.6', reasoning_effort: 'xhigh' }).params[0].value, 'xhigh');
    assert.equal(resolveModelSelection({ model: 'grok-4.6-high-fast', reasoning_effort: 'low' }).params[0].value, 'high');
    assert.equal(resolveModelSelection({}).params[0].value, 'high');
    assert.equal(resolveModelSelection({}).params[1].value, 'true');
    assert.equal(resolveModelSelection({ model: 'grok-4.6-high' }).params[1].value, 'false');
    assert.throws(() => resolveModelSelection({ model: 'gpt-5' }), /Unsupported model/);
});

test('publicModels includes standard and effort variants', () => {
    const ids = publicModels(1).map((model) => model.id);
    assert.equal(ids[0], 'grok-4.6-high-fast');
    assert.ok(ids.includes('grok-4.6'));
    assert.ok(ids.includes('grok-4.6-xhigh-fast'));
});

test('openAiUsage converts Cursor counters', () => {
    assert.deepEqual(openAiUsage({ inputTokens: 10, outputTokens: 3, totalTokens: 13 }), {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
    });
});
