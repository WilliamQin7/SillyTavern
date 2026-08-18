import assert from 'node:assert/strict';
import test from 'node:test';

import { TavernCardValidator } from '../../../src/validator/TavernCardValidator.js';
import {
    activeStoryPlanContext,
    buildAssetPrompt,
    characterCreatePayload,
    extractJsonObject,
    filterSafeTools,
    memorySourceMatchesChat,
    normalizeMemoryEnvelope,
    normalizeMemoryDraft,
    normalizeStoryPlan,
    normalizeStoryPlanProgress,
    normalizeStoryState,
    partitionNewMemories,
    sceneMemoryPrompt,
    storyPlanPrompt,
    storyPlanToLoreContent,
    storyStateToLoreContent,
    validateStudioDraft,
} from '../../../public/scripts/extensions/third-party/codex-oauth/studio-core.js';

function draft() {
    return {
        schema: 'amy_creator_studio_v1',
        card: {
            spec: 'chara_card_v3', spec_version: '3.0',
            data: {
                name: 'Mira', description: 'A cartographer.', personality: 'Curious.', scenario: 'At sea.',
                first_mes: 'Hello.', mes_example: '{{char}}: North.', creator_notes: '', system_prompt: '',
                post_history_instructions: '', alternate_greetings: [], group_only_greetings: ['Ready, crew?'],
                tags: ['adventure'], creator: '', character_version: '', extensions: { preserved: true },
                nickname: 'Captain Mira', source: ['https://example.com/mira'],
                assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
            },
        },
        lorebook: { name: 'Mira Lore', entries: [{ keys: ['atlas'], content: 'The atlas records shifting islands.' }] },
        visual: { anchor: 'silver hair, blue coat', style: 'watercolor' },
    };
}

test('Character Card V3 validation preserves V3 fields and embeds a portable lorebook', () => {
    const result = validateStudioDraft(draft());
    assert.equal(result.valid, true);
    assert.equal(result.draft.card.spec, 'chara_card_v3');
    assert.equal(result.draft.card.spec_version, '3.0');
    assert.deepEqual(result.draft.card.data.extensions, { preserved: true });
    assert.deepEqual(result.draft.card.data.group_only_greetings, ['Ready, crew?']);
    assert.equal(result.draft.card.data.nickname, 'Captain Mira');
    assert.equal(result.draft.card.data.character_book.entries[0].content, 'The atlas records shifting islands.');
    assert.equal(new TavernCardValidator(result.draft.card).validate(), 3);
    assert.equal(result.draft.lorebook.entries[0].comment, 'Lore 1');
    const payload = characterCreatePayload(result.draft, 'Mira Lore');
    assert.equal(payload.ch_name, 'Mira');
    assert.equal(payload.world, '');
    assert.deepEqual(JSON.parse(payload.extensions), { preserved: true, world: 'Mira Lore' });
    assert.equal(JSON.parse(payload.json_data).spec, 'chara_card_v3');
});

test('Character Card V2 drafts migrate deterministically to V3', () => {
    const value = draft();
    value.card.spec = 'chara_card_v2';
    value.card.spec_version = '2.0';
    delete value.card.data.group_only_greetings;
    delete value.card.data.nickname;
    delete value.card.data.source;
    delete value.card.data.assets;
    const result = validateStudioDraft(value);
    assert.equal(result.valid, true);
    assert.equal(result.draft.card.spec, 'chara_card_v3');
    assert.equal(result.draft.card.spec_version, '3.0');
    assert.deepEqual(result.draft.card.data.group_only_greetings, []);
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

test('V3 assets require every standard descriptor field', () => {
    const value = draft();
    delete value.card.data.assets[0].ext;
    const result = validateStudioDraft(value);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.includes('requires type, uri, name, and ext')));
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
    const previous = normalizeStoryState({
        scene: { location: 'Sea' },
        authorPlans: [{ content: 'Reveal the false map later.', status: 'planned' }],
    });
    const prompt = sceneMemoryPrompt('Mira: We made it home.', previous);
    assert.match(prompt, /first memory must be a concise chronological scene summary/i);
    assert.match(prompt, /never turn speculation or future plot plans into facts/i);
    assert.match(prompt, /unresolved story threads/i);
    assert.match(prompt, /preserve existing authorPlans exactly/i);
    assert.match(prompt, /Reveal the false map later/);
});

test('story state normalization separates canon, plans, and directional relationships', () => {
    const state = normalizeStoryState({
        scene: { summary: 'Mira returned.', present_characters: ['Mira', 'Ivo'] },
        characters: [{ name: 'Mira', status: 'tired', inventory: ['atlas'] }],
        relationships: [{ from: 'Mira', to: 'Ivo', state: 'cautious trust', last_change: 'Ivo kept his promise.' }],
        open_threads: [{ title: 'False map', detail: 'Its maker is unknown.' }],
        canon: [{ content: 'Mira returned to port.', keys: ['Mira', 'port'] }],
        author_plans: [{ content: 'Reveal the maker in chapter five.' }],
    });
    assert.equal(state.schema, 'amy_story_state_v1');
    assert.deepEqual(state.scene.presentCharacters, ['Mira', 'Ivo']);
    assert.equal(state.relationships[0].lastChange, 'Ivo kept his promise.');
    assert.equal(state.authorPlans[0].status, 'planned');
    const lore = storyStateToLoreContent(state);
    assert.match(lore, /Mira → Ivo: cautious trust/);
    assert.match(lore, /Canon: Mira returned to port\./);
    assert.doesNotMatch(lore, /Reveal the maker/);
    assert.equal(state.authorPlans[0].content, 'Reveal the maker in chapter five.');
});

test('Story Plan normalizes stable chapter and scene focus without requiring the feature', () => {
    assert.equal(normalizeStoryPlan(null), null);
    assert.equal(normalizeStoryPlan({ chapters: [null, 'invalid'] }), null);
    assert.deepEqual(normalizeStoryPlanProgress({}, null), { active: false, chapterId: '', sceneId: '' });
    const plan = normalizeStoryPlan({
        title: 'The Shifting Atlas',
        premise: 'The final chapter reveals the atlas maker.',
        style_guide: ['limited point of view'],
        chapters: [
            {
                id: 'arrival', title: 'Arrival', summary: 'Mira reaches port.', goals: ['Meet Ivo'],
                scenes: [{ id: 'interview', title: 'Interview', summary: 'Question Ivo.', constraints: ['Do not reveal the maker'] }],
            },
            { id: 'arrival', title: 'Revelation', summary: 'The maker is revealed.', scenes: [] },
        ],
    });
    assert.equal(plan.schema, 'amy_story_plan_v1');
    assert.deepEqual(normalizeStoryPlan({ chapters: [{}], styleGuide: 'limited point of view' }).styleGuide, ['limited point of view']);
    assert.deepEqual(plan.chapters.map(chapter => chapter.id), ['arrival', 'arrival-2']);
    const progress = normalizeStoryPlanProgress({ active: true, chapterId: 'arrival', sceneId: 'interview' }, plan);
    const context = activeStoryPlanContext(plan, progress);
    assert.equal(context.chapter.title, 'Arrival');
    assert.equal(context.scene.title, 'Interview');
    assert.equal(storyPlanToLoreContent(plan, { ...progress, active: false }), '');
    const lore = storyPlanToLoreContent(plan, progress);
    assert.match(lore, /Current chapter — Arrival/);
    assert.match(lore, /Current scene — Interview/);
    assert.match(lore, /Do not reveal the maker/);
    assert.doesNotMatch(lore, /Revelation|final chapter reveals/);
    const boundedLore = storyPlanToLoreContent(normalizeStoryPlan({
        chapters: [{ goals: Array.from({ length: 8 }, (_, index) => `goal-${index + 1}`) }],
    }), { active: true });
    assert.doesNotMatch(boundedLore, /goal-7/);
});

test('Story Plan prompt preserves the outline and forbids invented plot turns', () => {
    const prompt = storyPlanPrompt('Chapter one: Mira arrives.');
    assert.match(prompt, /amy_story_plan_v1/);
    assert.match(prompt, /Do not invent new plot turns/i);
    assert.match(prompt, /Chapter one: Mira arrives\./);
});
