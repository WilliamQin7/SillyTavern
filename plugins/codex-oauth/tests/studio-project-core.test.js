import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assignStoryChat,
    editableSceneFromPlan,
    evaluateStoryGenerationReadiness,
    normalizeSceneBrief,
    normalizeStoryProject,
    normalizeStoryProjectChatState,
    normalizeStoryProjects,
    storyProjectStoryKey,
    storyProjectForChat,
    unassignStoryChat,
    uniqueStoryProjectId,
    upsertStoryProject,
} from '../../../public/scripts/extensions/third-party/codex-oauth/studio-project-core.js';

test('generation readiness rejects chat defaults that cannot fit the target scene', () => {
    const result = evaluateStoryGenerationReadiness({
        contextTokens: 4095,
        responseTokens: 300,
        expectedSceneWords: 1100,
        compiledContextTokens: 900,
        worldInfoPercent: 25,
    });
    assert.equal(result.ready, false);
    assert.equal(result.responseReady, false);
    assert.equal(result.promptReady, false);
    assert.equal(result.estimatedOutputWords, 200);
    assert.equal(result.worldInfoTokens, 949);
    assert.equal(result.recommendedContextTokens, 32768);
    assert.equal(result.recommendedResponseTokens, 4096);
});

test('generation readiness reports usable prompt, response, and lore budgets', () => {
    const result = evaluateStoryGenerationReadiness({
        contextTokens: 32768,
        responseTokens: 4096,
        expectedSceneWords: 1100,
        compiledContextTokens: 950,
        worldInfoPercent: 30,
        worldInfoCap: 5000,
    });
    assert.equal(result.ready, true);
    assert.equal(result.promptTokens, 28672);
    assert.equal(result.worldInfoTokens, 5000);
    assert.ok(result.estimatedOutputWords >= result.expectedSceneWords);
});

test('native story identity includes both its owner and chat id', () => {
    assert.notEqual(
        storyProjectStoryKey({ ownerId: 'Mira.png', chatId: 'Chapter One' }),
        storyProjectStoryKey({ ownerId: 'Ivo.png', chatId: 'Chapter One' }),
    );
    assert.equal(
        storyProjectStoryKey({ ownerId: 'Mira.png', chatId: 'Chapter One' }),
        storyProjectStoryKey({ ownerId: 'mira.png', chatId: 'chapter one' }),
    );
});

test('Story Projects are optional lightweight manifests', () => {
    assert.equal(normalizeStoryProject(null), null);
    assert.equal(normalizeStoryProject({ name: '' }), null);
    assert.equal(normalizeStoryProject({ schema: 'another_format', name: 'Wrong' }), null);
    assert.deepEqual(normalizeStoryProjectChatState({}), {
        storyProjectId: '',
        sceneBrief: {
            schema: 'amy_scene_brief_v1',
            chapterId: '',
            sceneId: '',
            summary: '',
            cast: [],
            time: '',
            location: '',
            mustInclude: [],
            avoid: [],
            ending: '',
            updatedAt: '',
        },
        sceneReferenceSnapshot: [],
        storyPreparationVerification: {
            projectId: '',
            chapterId: '',
            sceneId: '',
            profileId: '',
            proof: '',
            verifiedAt: '',
        },
    });
    const project = normalizeStoryProject({
        name: 'Tidal Atlas',
        characters: ['Mira', 'Mira', { name: 'Ivo' }],
        worlds: 'Moving Islands\nShared Cosmology',
        tags: 'adventure, shared-world',
    });
    assert.equal(project.schema, 'amy_story_project_v1');
    assert.deepEqual(project.characters, ['Mira', 'Ivo']);
    assert.deepEqual(project.worlds, ['Moving Islands', 'Shared Cosmology']);
    assert.deepEqual(project.tags, ['adventure', 'shared-world']);
    assert.equal(project.storyPlan, null);
});

test('scene briefs are bounded private chat overlays instead of project plan mutations', () => {
    const brief = normalizeSceneBrief({
        chapterId: 'chapter-1',
        sceneId: 'scene-1',
        summary: 'Begin after dinner.',
        cast: 'Mira, Ivo, Mira',
        mustInclude: ['A key changes hands'],
        avoid: ['Do not resolve the mystery'],
        ending: 'Stop at the locked door.',
        ignored: 'not persisted',
    });
    assert.deepEqual(brief.cast, ['Mira', 'Ivo']);
    assert.equal(brief.summary, 'Begin after dinner.');
    assert.equal(brief.ending, 'Stop at the locked door.');
    assert.equal(Object.hasOwn(brief, 'ignored'), false);
});

test('editable scenes start from the complete focused plan and preserve reviewed edits', () => {
    const chapter = {
        id: 'chapter-1',
        summary: 'Establish the apartment rules.',
        goals: ['Show the key', 'Keep the power imbalance visible'],
        constraints: ['Do not reveal the later reversal'],
    };
    const scene = {
        id: 'scene-1',
        summary: 'Set the rules after dinner.',
        goals: ['Show the key'],
        constraints: ['Do not skip the negotiation'],
    };
    const initial = editableSceneFromPlan(chapter, scene, null);
    assert.equal(initial.summary, 'Set the rules after dinner.');
    assert.deepEqual(initial.mustInclude, ['Show the key', 'Keep the power imbalance visible']);
    assert.deepEqual(initial.avoid, ['Do not reveal the later reversal', 'Do not skip the negotiation']);

    const edited = editableSceneFromPlan(chapter, scene, {
        chapterId: 'chapter-1',
        sceneId: 'scene-1',
        summary: 'Begin when the tenant returns with groceries.',
        mustInclude: [],
        avoid: [],
        updatedAt: '2026-08-20T02:00:00.000Z',
    });
    assert.equal(edited.summary, 'Begin when the tenant returns with groceries.');
    assert.deepEqual(edited.mustInclude, []);
    assert.deepEqual(edited.avoid, []);
});

test('chat preparation verification is bounded and remains private chat state', () => {
    const state = normalizeStoryProjectChatState({
        storyProjectId: 'atlas',
        storyPreparationVerification: {
            projectId: 'atlas',
            chapterId: 'chapter-1',
            sceneId: 'scene-2',
            profileId: 'restrained',
            proof: 'prompt-scan',
            verifiedAt: '2026-08-19T15:00:00.000Z',
            ignored: 'not persisted',
        },
    });
    assert.deepEqual(state.storyPreparationVerification, {
        projectId: 'atlas',
        chapterId: 'chapter-1',
        sceneId: 'scene-2',
        profileId: 'restrained',
        proof: 'prompt-scan',
        verifiedAt: '2026-08-19T15:00:00.000Z',
    });
});

test('the same characters and worlds may be referenced by several projects', () => {
    const projects = normalizeStoryProjects([
        { id: 'atlas', name: 'Atlas', characters: ['Mira'], worlds: ['Shared Cosmology'] },
        { id: 'harbor', name: 'Harbor', characters: ['Mira'], worlds: ['Shared Cosmology'] },
    ]);
    assert.equal(projects.length, 2);
    assert.deepEqual(projects[0].characters, projects[1].characters);
    assert.deepEqual(projects[0].worlds, projects[1].worlds);
    assert.equal(storyProjectForChat(projects, { storyProjectId: 'harbor' }).name, 'Harbor');
});

test('project ids remain unique while an existing project can be updated', () => {
    const projects = normalizeStoryProjects([
        { id: 'shared', name: 'One' },
        { id: 'shared', name: 'Two' },
    ]);
    assert.deepEqual(projects.map(project => project.id), ['shared', 'shared-2']);
    assert.equal(uniqueStoryProjectId('shared', projects), 'shared-3');
    const result = upsertStoryProject(projects, { id: 'shared', name: 'One revised', characters: ['Mira'] });
    assert.equal(result.projects.length, 2);
    assert.equal(result.projects[0].name, 'One revised');
});

test('a project plot is a reusable snapshot and does not become active state', () => {
    const project = normalizeStoryProject({
        name: 'Atlas',
        storyPlan: {
            title: 'Atlas plot',
            chapters: [{ title: 'Arrival', goals: ['Meet Ivo'] }],
        },
    });
    assert.equal(project.storyPlan.schema, 'amy_story_plan_v1');
    assert.equal(project.storyPlan.chapters[0].title, 'Arrival');
    assert.equal(Object.hasOwn(project, 'storyPlanProgress'), false);
    assert.equal(Object.hasOwn(project, 'storyState'), false);
});

test('generated prose stays in native chats while projects index story ownership', () => {
    let projects = normalizeStoryProjects([
        { id: 'atlas', name: 'Atlas' },
        { id: 'harbor', name: 'Harbor', stories: [{ chatId: 'chapter-1', title: 'Old link' }] },
    ]);
    projects = assignStoryChat(projects, 'atlas', {
        chatId: 'chapter-1',
        ownerId: 'Mira.png',
        title: 'Chapter One',
        character: 'Mira',
        linkedAt: '2026-08-19T12:00:00.000Z',
        content: 'Private generated prose must not be duplicated here.',
    });
    assert.equal(projects[0].stories.length, 1);
    assert.equal(projects[1].stories.length, 0);
    assert.deepEqual(projects[0].stories[0], {
        chatId: 'chapter-1',
        ownerId: 'Mira.png',
        title: 'Chapter One',
        character: 'Mira',
        linkedAt: '2026-08-19T12:00:00.000Z',
    });
    assert.equal(Object.hasOwn(projects[0].stories[0], 'content'), false);
    projects = unassignStoryChat(projects, { chatId: 'chapter-1', ownerId: 'Mira.png' });
    assert.equal(projects[0].stories.length, 0);
});
