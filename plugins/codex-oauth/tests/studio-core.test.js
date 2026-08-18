import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildAssetPrompt,
    characterCreatePayload,
    extractJsonObject,
    filterSafeTools,
    memorySourceMatchesChat,
    normalizeMemoryEnvelope,
    normalizeMemoryDraft,
    partitionNewMemories,
    sceneMemoryPrompt,
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

test('memory drafts retain their source chat and reject cross-chat saves', () => {
    const draft = normalizeMemoryEnvelope({
        source: { chatId: 'chapter-1', startMessageId: 4, endMessageId: 9, messageCount: 6 },
        memories: [{ title: 'Map', content: 'Mira found a map.', keys: ['map'] }],
    });
    assert.deepEqual(draft.source, { chatId: 'chapter-1', startMessageId: 4, endMessageId: 9, messageCount: 6 });
    assert.equal(memorySourceMatchesChat(draft.source, 'chapter-1'), true);
    assert.equal(memorySourceMatchesChat(draft.source, 'chapter-2'), false);
    assert.deepEqual(normalizeMemoryEnvelope({ source: { chatId: 'chapter-1' }, memories: [] }).source, {
        chatId: 'chapter-1', startMessageId: null, endMessageId: null, messageCount: 0,
    });
});

test('memory deduplication covers stored entries and duplicates in one review batch', () => {
    const memories = normalizeMemoryDraft({ memories: [
        { title: 'Map', content: 'Mira found a map.', keys: ['map'] },
        { title: 'Map again', content: '  Mira found a map.  ', keys: ['atlas'] },
        { title: 'Promise', content: 'Mira promised to return.', keys: ['promise'] },
    ] });
    const result = partitionNewMemories(memories, [{ content: '[event; importance 3/5] Mira found a map.' }]);
    assert.deepEqual(result.fresh.map(memory => memory.title), ['Promise']);
    assert.deepEqual(result.duplicates.map(memory => memory.title), ['Map', 'Map again']);
    assert.equal(partitionNewMemories([{ content: '[Year 12] Mira returned.' }], [{ content: 'Mira returned.' }]).fresh.length, 1);
});

test('scene close prompt separates occurred events from future plans', () => {
    const prompt = sceneMemoryPrompt('Mira: We made it home.');
    assert.match(prompt, /first item must be a concise chronological scene summary/i);
    assert.match(prompt, /never turn speculation or future plot plans into facts/i);
    assert.match(prompt, /unresolved story threads/i);
});
