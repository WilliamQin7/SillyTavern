import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createStoryProjectBundleManifest,
    normalizeStoryProjectBundleManifest,
    portableProjectForMode,
    remapImportedProject,
    STORY_PROJECT_BUNDLE_SCHEMA,
    storyOnlyChatData,
    uniquePortableName,
    validateStoryProjectBundleResources,
} from '../../../public/scripts/extensions/third-party/codex-oauth/studio-project-portability-core.js';

const project = {
    id: 'tidal-atlas',
    name: 'Tidal Atlas',
    description: 'A moving-island novel.',
    characters: ['Mira'],
    worlds: ['Moving Islands'],
    storyPlan: { title: 'Atlas', chapters: [{ title: 'Arrival' }] },
    writingProfileId: 'quiet-prose',
    notes: 'Private planning notes.',
    stories: [{ chatId: 'chapter-1', ownerId: 'Mira.png', title: 'Arrival', character: 'Mira' }],
};

test('story-only packages retain prose ordering metadata but exclude creative settings', () => {
    const portable = portableProjectForMode(project, 'story_only');
    assert.deepEqual(portable.characters, []);
    assert.deepEqual(portable.worlds, []);
    assert.equal(portable.storyPlan, null);
    assert.equal(portable.writingProfileId, '');
    assert.equal(portable.notes, '');
    assert.equal(portable.description, '');
    assert.deepEqual(portable.tags, []);
    assert.equal(portable.stories[0].chatId, 'chapter-1');
    assert.equal(portable.stories[0].ownerId, '');
    assert.equal(portable.stories[0].character, '');

    const manifest = createStoryProjectBundleManifest({
        mode: 'story_only',
        project,
        stories: [{ ...project.stories[0], path: 'stories/001-arrival.jsonl' }],
        characters: [{ avatar: 'Mira.png', path: 'characters/mira.png' }],
        worlds: [{ name: 'Moving Islands', path: 'worlds/islands.json' }],
    });
    assert.equal(manifest.schema, STORY_PROJECT_BUNDLE_SCHEMA);
    assert.equal(manifest.assets.stories[0].ownerId, '');
    assert.equal(manifest.assets.stories[0].character, '');
    assert.equal(manifest.assets.stories[0].worldInfo, '');
    assert.deepEqual(manifest.assets.characters, []);
    assert.deepEqual(manifest.assets.worlds, []);
});

test('story-only chat data keeps accepted visible prose and strips creative metadata', () => {
    const chat = storyOnlyChatData([
        {
            user_name: 'Author',
            character_name: 'Mira',
            chat_metadata: {
                world_info: 'Private continuity',
                amy_creator_studio: { storyPlan: { title: 'Future plot' } },
            },
        },
        { name: 'Author', is_user: true, mes: 'Open the door.', extra: { api: 'secret-provider-label' } },
        { name: 'Mira', mes: 'Old swipe', extra: { display_text: 'The accepted paragraph.' }, swipes: ['Draft A', 'Draft B'] },
        { name: 'System', is_system: true, mes: 'Hidden author instruction.' },
    ]);
    assert.deepEqual(chat[0].chat_metadata, {});
    assert.equal(chat.length, 3);
    assert.equal(chat[2].mes, 'The accepted paragraph.');
    assert.equal(Object.hasOwn(chat[1], 'extra'), false);
    assert.equal(Object.hasOwn(chat[2], 'swipes'), false);
    assert.equal(JSON.stringify(chat).includes('Future plot'), false);
    assert.equal(JSON.stringify(chat).includes('Hidden author instruction'), false);
});

test('full packages normalize referenced assets and writing profiles', () => {
    const manifest = createStoryProjectBundleManifest({
        mode: 'full',
        project,
        stories: [{ ...project.stories[0], path: 'stories/001-arrival.jsonl' }],
        characters: [{ avatar: 'Mira.png', name: 'Mira', refs: ['Mira'], path: 'characters/001-mira.png' }],
        worlds: [{ name: 'Moving Islands', ref: 'Moving Islands', path: 'worlds/001-islands.json' }],
        groups: [{ id: 'crew', name: 'Crew', path: 'groups/001-crew.json' }],
        writingProfile: {
            schema: 'amy_writing_profile_v1',
            id: 'quiet-prose',
            name: 'Quiet prose',
            contract: { language: 'zh-CN' },
        },
    });
    assert.equal(manifest.assets.characters[0].avatar, 'Mira.png');
    assert.equal(manifest.assets.worlds[0].ref, 'Moving Islands');
    assert.equal(manifest.assets.groups[0].id, 'crew');
    assert.equal(manifest.writingProfile.id, 'quiet-prose');
});

test('full manifests reject missing referenced resources instead of silently degrading', () => {
    assert.equal(createStoryProjectBundleManifest({
        mode: 'full',
        project,
        stories: [{ ...project.stories[0], path: 'stories/001-arrival.jsonl' }],
        characters: [],
        worlds: [],
        writingProfile: null,
    }), null);
});

test('full manifests reject ambiguous logical character references', () => {
    assert.equal(createStoryProjectBundleManifest({
        mode: 'full',
        project: { name: 'Ambiguous', characters: ['Mira'], stories: [{ chatId: 'one', ownerId: 'Mira-a.png' }] },
        stories: [{ chatId: 'one', ownerId: 'Mira-a.png', path: 'stories/one.jsonl' }],
        characters: [
            { avatar: 'Mira-a.png', name: 'Mira', refs: ['Mira'], path: 'characters/a.png' },
            { avatar: 'Mira-b.png', name: 'Mira', refs: ['Mira'], path: 'characters/b.png' },
        ],
    }), null);
});

test('full bundle resources require every group member card', () => {
    const manifest = createStoryProjectBundleManifest({
        mode: 'full',
        project: { name: 'Crew', characters: ['Mira.png'], stories: [{ chatId: 'one', ownerId: 'group:crew' }] },
        stories: [{ chatId: 'one', ownerId: 'group:crew', path: 'stories/one.jsonl' }],
        characters: [{ avatar: 'Mira.png', name: 'Mira', path: 'characters/mira.png' }],
        groups: [{ id: 'crew', name: 'Crew', path: 'groups/crew.json' }],
    });
    assert.equal(validateStoryProjectBundleResources(manifest, [{
        asset: manifest.assets.groups[0],
        data: { members: ['Mira.png'], disabled_members: [] },
    }]), true);
    assert.equal(validateStoryProjectBundleResources(manifest, [{
        asset: manifest.assets.groups[0],
        data: { members: ['Missing.png'], disabled_members: [] },
    }]), false);
});

test('portable manifests reject traversal paths and missing stories', () => {
    assert.equal(normalizeStoryProjectBundleManifest({
        schema: STORY_PROJECT_BUNDLE_SCHEMA,
        version: 1,
        mode: 'story_only',
        project,
        assets: { stories: [{ chatId: 'chapter-1', path: 'stories/../secret.jsonl' }] },
    }), null);
});

test('import remapping creates a new project without retaining stale resource ids', () => {
    const manifest = createStoryProjectBundleManifest({
        mode: 'full',
        project,
        stories: [{ ...project.stories[0], path: 'stories/001-arrival.jsonl' }],
        characters: [{ avatar: 'Mira.png', name: 'Mira', refs: ['Mira'], path: 'characters/001-mira.png' }],
        worlds: [{ name: 'Moving Islands', ref: 'Moving Islands', path: 'worlds/001-islands.json' }],
        writingProfile: {
            schema: 'amy_writing_profile_v1',
            id: 'quiet-prose',
            name: 'Quiet prose',
            contract: {},
        },
    });
    const imported = remapImportedProject(manifest, {
        projectId: 'tidal-atlas-2',
        projectName: 'Tidal Atlas (Imported 2)',
        storyMappings: [{ chatId: 'arrival-imported', ownerId: 'Mira2.png', title: 'Arrival' }],
        characterMappings: { Mira: 'Mira2.png' },
        worldMappings: { 'Moving Islands': 'Moving Islands (Imported 2)' },
        writingProfileId: 'quiet-prose-2',
    });
    assert.equal(imported.id, 'tidal-atlas-2');
    assert.deepEqual(imported.characters, ['Mira2.png']);
    assert.deepEqual(imported.worlds, ['Moving Islands (Imported 2)']);
    assert.equal(imported.stories[0].ownerId, 'Mira2.png');
    assert.equal(imported.writingProfileId, 'quiet-prose-2');
});

test('portable names never overwrite an existing resource name', () => {
    assert.equal(uniquePortableName('Moving Islands', ['Moving Islands']), 'Moving Islands (Imported 2)');
    assert.equal(uniquePortableName('Moving Islands', ['Another']), 'Moving Islands');
});
