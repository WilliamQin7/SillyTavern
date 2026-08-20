import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveStoryGenerationModel,
    resolveStudioAssistantModel,
} from '../../../public/scripts/extensions/third-party/codex-oauth/studio-models.js';

test('keeps the main story model separate from the Studio assistant model', () => {
    const settings = {
        chat_completion_source: 'custom',
        custom_model: 'grok-4.6-high-fast',
    };

    assert.equal(resolveStoryGenerationModel(settings, value => value.custom_model), 'grok-4.6-high-fast');
    assert.equal(resolveStudioAssistantModel({ model: 'gpt-5.3-codex-spark' }), 'gpt-5.3-codex-spark');
});

test('prefers the manually selected Studio assistant model', () => {
    assert.equal(resolveStudioAssistantModel({
        model: 'gpt-5.4',
        manualModel: 'gpt-5.6-luna',
    }), 'gpt-5.6-luna');
});

test('falls back to the active source when no model is available', () => {
    assert.equal(resolveStoryGenerationModel({ chat_completion_source: 'custom' }, () => ''), 'custom');
});
