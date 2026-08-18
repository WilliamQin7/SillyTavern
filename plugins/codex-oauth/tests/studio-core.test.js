import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildAssetPrompt,
    characterCreatePayload,
    extractJsonObject,
    filterSafeTools,
    normalizeMemoryDraft,
    validateStudioDraft,
} from '../../../public/scripts/extensions/third-party/codex-oauth/studio-core.js';

function draft() {
    return {
        schema: 'amy_creator_studio_v1',
        card: {
            spec: 'chara_card_v2', spec_version: '2.0',
            data: {
                name: 'Mira', description: 'A cartographer.', personality: 'Curious.', scenario: 'At sea.',
                first_mes: 'Hello.', mes_example: '{{char}}: North.', creator_notes: '', system_prompt: '',
                post_history_instructions: '', alternate_greetings: [], tags: ['adventure'], creator: '',
                character_version: '', extensions: { preserved: true },
            },
        },
        lorebook: { name: 'Mira Lore', entries: [{ keys: ['atlas'], content: 'The atlas records shifting islands.' }] },
        visual: { anchor: 'silver hair, blue coat', style: 'watercolor' },
    };
}

test('Character Card V2 draft validation normalizes fields without destroying extensions', () => {
    const result = validateStudioDraft(draft());
    assert.equal(result.valid, true);
    assert.deepEqual(result.draft.card.data.extensions, { preserved: true });
    assert.equal(result.draft.lorebook.entries[0].comment, 'Lore 1');
    const payload = characterCreatePayload(result.draft, 'Mira Lore');
    assert.equal(payload.ch_name, 'Mira');
    assert.deepEqual(JSON.parse(payload.extensions), { preserved: true, world: 'Mira Lore' });
});

test('invalid cards and lore entries are rejected before any import', () => {
    const value = draft();
    value.card.data.name = '';
    value.lorebook.entries[0].keys = [];
    const result = validateStudioDraft(value);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.includes('name is required')));
    assert.ok(result.errors.some(error => error.includes('needs keys')));
});

test('JSON extraction handles fenced model output', () => {
    assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
});

test('safe tool filtering never exposes unrelated registered tools', () => {
    const tools = ['AmyStudioRemember', 'GenerateImage', 'Shell'].map(name => ({ type: 'function', function: { name } }));
    assert.deepEqual(filterSafeTools(tools, true).map(tool => tool.function.name), ['AmyStudioRemember']);
    assert.deepEqual(filterSafeTools(tools, false), []);
});

test('asset prompts preserve the visual identity and memory drafts stay atomic', () => {
    const prompt = buildAssetPrompt({ type: 'expression', characterName: 'Mira', visualAnchor: 'silver hair', visualStyle: 'watercolor', detail: 'surprised' });
    assert.match(prompt, /silver hair/);
    assert.match(prompt, /watercolor/);
    assert.match(prompt, /surprised/);
    assert.deepEqual(normalizeMemoryDraft({ memories: [{ title: 'Map', content: 'Mira found a map.', keys: ['map'], kind: 'event', importance: 9 }] }), [
        { title: 'Map', content: 'Mira found a map.', keys: ['map'], kind: 'event', importance: 5 },
    ]);
});
