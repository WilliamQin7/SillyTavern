import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryProjectBundleManifest } from '../../../public/scripts/extensions/third-party/codex-oauth/studio-project-portability-core.js';
import { importStoryProjectBundle } from '../../../public/scripts/extensions/third-party/codex-oauth/studio-project-portability.js';

function response(value = {}, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function dependencies(overrides = {}) {
    const settings = {
        storyProjects: [{ id: 'tidal-atlas', name: 'Tidal Atlas' }],
        writingProfileTemplates: [],
    };
    return {
        getSettings: () => settings,
        getWorldNames: () => [],
        getCurrentCharacter: () => ({ avatar: 'Target.png', name: 'Target' }),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        refreshCharacters: async () => {},
        refreshWorlds: async () => {},
        ...overrides,
    };
}

test('story-only import uses a target character and removes source setting references', async (t) => {
    const manifest = createStoryProjectBundleManifest({
        mode: 'story_only',
        project: {
            id: 'tidal-atlas',
            name: 'Tidal Atlas',
            characters: ['Mira'],
            worlds: ['Moving Islands'],
            storyPlan: { title: 'Plot', chapters: [{ title: 'Arrival' }] },
            stories: [{ chatId: 'chapter-1', ownerId: 'Mira.png', title: 'Arrival' }],
        },
        stories: [{
            chatId: 'chapter-1',
            ownerId: 'Mira.png',
            title: 'Arrival',
            worldInfo: 'Moving Islands',
            path: 'stories/001-arrival.jsonl',
        }],
    });
    const bundle = {
        manifest,
        stories: [{
            asset: manifest.assets.stories[0],
            chat: [{ user_name: 'User', character_name: 'Mira', chat_metadata: { world_info: 'Moving Islands' } }],
        }],
        characters: [],
        worlds: [],
        groups: [],
    };
    const calls = [];
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return response({ ok: true });
    };

    const result = await importStoryProjectBundle(bundle, dependencies());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/chats/save');
    assert.equal(calls[0].body.avatar_url, 'Target.png');
    assert.equal(Object.hasOwn(calls[0].body.chat[0].chat_metadata, 'world_info'), false);
    assert.equal(calls[0].body.chat[0].chat_metadata.amy_creator_studio.storyProjectId, 'tidal-atlas-2');
    assert.deepEqual(result.project.characters, []);
    assert.deepEqual(result.project.worlds, []);
    assert.equal(result.project.storyPlan, null);
});

test('story-only import creates a neutral archive character when no target character is open', async (t) => {
    const manifest = createStoryProjectBundleManifest({
        mode: 'story_only',
        project: {
            id: 'tidal-atlas',
            name: 'Tidal Atlas',
            stories: [{ chatId: 'chapter-1', ownerId: 'Mira.png', title: 'Arrival' }],
        },
        stories: [{ chatId: 'chapter-1', ownerId: 'Mira.png', title: 'Arrival', path: 'stories/001-arrival.jsonl' }],
    });
    const bundle = {
        manifest,
        stories: [{ asset: manifest.assets.stories[0], chat: [{ chat_metadata: {} }, { mes: 'Arrival' }] }],
        characters: [],
        worlds: [],
        groups: [],
    };
    const calls = [];
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/characters/import') return response({ file_name: 'Tidal Atlas Story Archive' });
        if (url === '/api/chats/save') return response({ ok: true });
        return response({}, 404);
    };

    await importStoryProjectBundle(bundle, dependencies({ getCurrentCharacter: () => null }));
    const characterImport = calls.find(call => call.url === '/api/characters/import');
    assert.equal(characterImport.options.body.get('file_type'), 'json');
    const chatSave = calls.find(call => call.url === '/api/chats/save');
    assert.equal(JSON.parse(chatSave.options.body).avatar_url, 'Tidal Atlas Story Archive.png');
});

test('full import copies resources and remaps group, world, profile, and chat references', async (t) => {
    const manifest = createStoryProjectBundleManifest({
        mode: 'full',
        project: {
            id: 'tidal-atlas',
            name: 'Tidal Atlas',
            characters: ['Mira'],
            worlds: ['Moving Islands'],
            writingProfileId: 'quiet-prose',
            stories: [{ chatId: 'chapter-1', ownerId: 'group:crew', title: 'Arrival' }],
        },
        stories: [{
            chatId: 'chapter-1',
            ownerId: 'group:crew',
            title: 'Arrival',
            worldInfo: 'Moving Islands',
            path: 'stories/001-arrival.jsonl',
        }],
        characters: [{ avatar: 'Mira.png', name: 'Mira', refs: ['Mira'], path: 'characters/001-mira.png' }],
        worlds: [{ name: 'Moving Islands', ref: 'Moving Islands', path: 'worlds/001-islands.json' }],
        groups: [{ id: 'crew', name: 'Crew', path: 'groups/001-crew.json' }],
        writingProfile: { schema: 'amy_writing_profile_v1', id: 'quiet-prose', name: 'Quiet prose', contract: {} },
    });
    const bundle = {
        manifest,
        stories: [{
            asset: manifest.assets.stories[0],
            chat: [
                {
                    chat_metadata: {
                        world_info: 'Moving Islands',
                        amy_creator_studio: {
                            storyProjectId: 'tidal-atlas',
                            writingProfileSourceId: 'project:tidal-atlas',
                            pendingMemories: JSON.stringify({ source: { chatId: 'chapter-1' }, memories: [] }),
                        },
                    },
                },
                { name: 'Mira', mes: 'Arrival', original_avatar: 'Mira.png', force_avatar: '/thumbnail?file=Mira.png' },
            ],
        }],
        characters: [{ asset: manifest.assets.characters[0], blob: new Blob(['png'], { type: 'image/png' }) }],
        worlds: [{ asset: manifest.assets.worlds[0], data: { entries: {} } }],
        groups: [{ asset: manifest.assets.groups[0], data: { members: ['Mira.png'] } }],
    };
    const calls = [];
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (url === '/api/characters/import') return response({ file_name: 'Mira2' });
        if (url === '/api/worldinfo/import') return response({ name: 'Moving Islands (Imported 2)' });
        if (url === '/api/groups/create') return response({ id: 'new-crew' });
        if (url === '/api/chats/group/save') return response({ ok: true });
        return response({}, 404);
    };
    const deps = dependencies({
        getCurrentCharacter: () => null,
        getWorldNames: () => ['Moving Islands'],
        getSettings: () => ({
            storyProjects: [{ id: 'tidal-atlas', name: 'Tidal Atlas' }],
            writingProfileTemplates: [{ id: 'quiet-prose', name: 'Existing' }],
        }),
    });

    const result = await importStoryProjectBundle(bundle, deps);
    const save = calls.find(call => call.url === '/api/chats/group/save');
    const body = JSON.parse(save.options.body);
    assert.equal(body.chat[0].chat_metadata.world_info, 'Moving Islands (Imported 2)');
    assert.equal(body.chat[0].chat_metadata.amy_creator_studio.storyProjectId, 'tidal-atlas-2');
    assert.equal(body.chat[0].chat_metadata.amy_creator_studio.writingProfileSourceId, 'project:tidal-atlas-2');
    assert.equal(JSON.parse(body.chat[0].chat_metadata.amy_creator_studio.pendingMemories).source.chatId, body.id);
    assert.equal(body.chat[1].original_avatar, 'Mira2.png');
    assert.equal(body.chat[1].force_avatar.includes('Mira2.png'), true);
    assert.deepEqual(result.project.characters, ['Mira2.png']);
    assert.deepEqual(result.project.worlds, ['Moving Islands (Imported 2)']);
    assert.equal(result.project.stories[0].ownerId, 'group:new-crew');
    assert.equal(result.profile.id, 'quiet-prose-2');
});
