import { extractJsonObject, normalizeStoryPlan } from './studio-core.js';

export const STORY_PROJECT_SCHEMA = 'amy_story_project_v1';
export const SCENE_BRIEF_SCHEMA = 'amy_scene_brief_v1';

const MIN_LONGFORM_PROMPT_TOKENS = 4096;
const MIN_LONGFORM_RESPONSE_TOKENS = 800;
const TOKENS_PER_TARGET_WORD = 1.5;

function text(value, limit = 500) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function stringList(value, limit = 200) {
    const source = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/\r?\n|,/)
            : [];
    const seen = new Set();
    const result = [];
    for (const item of source) {
        const normalized = text(typeof item === 'object' ? item?.ref ?? item?.name ?? item?.label : item, 300);
        const key = normalized.toLocaleLowerCase();
        if (!normalized || seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
        if (result.length >= limit) break;
    }
    return result;
}

function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

export function evaluateStoryGenerationReadiness(value = {}) {
    const contextTokens = nonNegativeNumber(value.contextTokens);
    const responseTokens = nonNegativeNumber(value.responseTokens);
    const expectedSceneWords = Math.max(200, nonNegativeNumber(value.expectedSceneWords) || 1100);
    const compiledContextTokens = nonNegativeNumber(value.compiledContextTokens);
    const promptTokens = Math.max(0, contextTokens - responseTokens);
    const requiredResponseTokens = Math.max(
        MIN_LONGFORM_RESPONSE_TOKENS,
        Math.ceil(expectedSceneWords * TOKENS_PER_TARGET_WORD),
    );
    const requiredPromptTokens = Math.max(
        MIN_LONGFORM_PROMPT_TOKENS,
        compiledContextTokens + 2048,
    );
    const responseReady = responseTokens >= requiredResponseTokens;
    const promptReady = promptTokens >= requiredPromptTokens;
    const validSplit = contextTokens > responseTokens && responseTokens > 0;
    const estimatedOutputWords = Math.floor(responseTokens / TOKENS_PER_TARGET_WORD);
    const recommendedResponseTokens = Math.max(4096, requiredResponseTokens);
    const recommendedContextTokens = Math.max(32768, requiredPromptTokens + recommendedResponseTokens);
    const worldInfoPercent = Math.min(100, nonNegativeNumber(value.worldInfoPercent));
    const worldInfoCap = nonNegativeNumber(value.worldInfoCap);
    const percentageBudget = Math.round(promptTokens * worldInfoPercent / 100);
    const worldInfoTokens = worldInfoCap > 0
        ? Math.min(percentageBudget, worldInfoCap)
        : percentageBudget;
    return {
        ready: validSplit && responseReady && promptReady,
        validSplit,
        responseReady,
        promptReady,
        contextTokens,
        responseTokens,
        promptTokens,
        expectedSceneWords,
        estimatedOutputWords,
        requiredResponseTokens,
        requiredPromptTokens,
        recommendedResponseTokens,
        recommendedContextTokens,
        compiledContextTokens,
        worldInfoPercent,
        worldInfoTokens,
    };
}

function baseProjectId(value) {
    return text(value, 120)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'story-project';
}

function normalizeProjectStory(value) {
    const input = typeof value === 'string' ? { chatId: value, title: value } : value;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const chatId = text(input.chatId, 300);
    if (!chatId) return null;
    return {
        chatId,
        ownerId: text(input.ownerId, 300),
        title: text(input.title, 300) || chatId,
        character: text(input.character, 200),
        linkedAt: text(input.linkedAt, 40),
    };
}

export function storyProjectStoryKey(storyValue) {
    const story = normalizeProjectStory(storyValue);
    if (!story) return '';
    return `${story.ownerId}\u0000${story.chatId}`.toLocaleLowerCase();
}

function isSameStory(candidate, story) {
    if (storyProjectStoryKey(candidate) === storyProjectStoryKey(story)) return true;
    return !candidate.ownerId && candidate.chatId.toLocaleLowerCase() === story.chatId.toLocaleLowerCase();
}

function normalizeProjectStories(value) {
    const stories = [];
    const seen = new Set();
    for (const item of Array.isArray(value) ? value : []) {
        const story = normalizeProjectStory(item);
        const key = story && storyProjectStoryKey(story);
        if (!story || seen.has(key)) continue;
        seen.add(key);
        stories.push(story);
        if (stories.length >= 500) break;
    }
    return stories;
}

export function uniqueStoryProjectId(value, projects = [], fallback = 'story-project') {
    const used = new Set((Array.isArray(projects) ? projects : []).map(project => text(project?.id, 120)));
    const base = baseProjectId(value || fallback);
    if (!used.has(base)) return base;
    for (let suffix = 2; suffix < 10000; suffix++) {
        const candidate = `${base}-${suffix}`;
        if (!used.has(candidate)) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
}

export function normalizeStoryProject(value) {
    let input = value;
    try {
        if (typeof value === 'string') input = extractJsonObject(value);
    } catch {
        return null;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (input.schema && text(input.schema, 120) !== STORY_PROJECT_SCHEMA) return null;
    const name = text(input.name, 200);
    if (!name) return null;
    return {
        schema: STORY_PROJECT_SCHEMA,
        id: baseProjectId(input.id || name),
        name,
        description: text(input.description, 2000),
        tags: stringList(input.tags, 50),
        characters: stringList(input.characters),
        worlds: stringList(input.worlds),
        storyPlan: normalizeStoryPlan(input.storyPlan),
        writingProfileId: text(input.writingProfileId, 120),
        stories: normalizeProjectStories(input.stories),
        notes: text(input.notes, 4000),
    };
}

export function normalizeStoryProjects(value) {
    const projects = [];
    for (const item of Array.isArray(value) ? value : []) {
        const project = normalizeStoryProject(item);
        if (!project) continue;
        project.id = uniqueStoryProjectId(project.id, projects);
        projects.push(project);
        if (projects.length >= 100) break;
    }
    return projects;
}

export function normalizeStoryProjectSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    return { ...input, storyProjects: normalizeStoryProjects(input.storyProjects) };
}

export function normalizeStoryProjectChatState(value) {
    const input = value && typeof value === 'object' ? value : {};
    const verification = input.storyPreparationVerification && typeof input.storyPreparationVerification === 'object'
        ? input.storyPreparationVerification
        : {};
    return {
        ...input,
        storyProjectId: text(input.storyProjectId, 120),
        sceneBrief: normalizeSceneBrief(input.sceneBrief),
        sceneReferenceSnapshot: normalizeSceneReferenceSnapshot(input.sceneReferenceSnapshot),
        storyPreparationVerification: {
            projectId: text(verification.projectId, 120),
            chapterId: text(verification.chapterId, 120),
            sceneId: text(verification.sceneId, 120),
            profileId: text(verification.profileId, 120),
            proof: ['none', 'prompt-scan', 'protected-entry'].includes(verification.proof) ? verification.proof : '',
            verifiedAt: text(verification.verifiedAt, 80),
        },
    };
}

export function normalizeSceneBrief(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        schema: SCENE_BRIEF_SCHEMA,
        chapterId: text(input.chapterId, 120),
        sceneId: text(input.sceneId, 120),
        summary: text(input.summary, 4000),
        cast: stringList(input.cast, 30),
        time: text(input.time, 300),
        location: text(input.location, 300),
        mustInclude: stringList(input.mustInclude, 30),
        avoid: stringList(input.avoid, 30),
        ending: text(input.ending, 1000),
        updatedAt: text(input.updatedAt, 80),
    };
}

export function editableSceneFromPlan(chapterValue, sceneValue, briefValue) {
    const chapter = chapterValue && typeof chapterValue === 'object' && !Array.isArray(chapterValue) ? chapterValue : {};
    const scene = sceneValue && typeof sceneValue === 'object' && !Array.isArray(sceneValue) ? sceneValue : {};
    const brief = normalizeSceneBrief(briefValue);
    const chapterId = text(chapter.id, 120);
    const sceneId = text(scene.id, 120);
    const savedForFocus = Boolean(brief.updatedAt)
        && brief.chapterId === chapterId
        && brief.sceneId === sceneId;
    if (savedForFocus) return brief;
    return normalizeSceneBrief({
        chapterId,
        sceneId,
        summary: text(scene.summary, 4000) || text(chapter.summary, 4000),
        mustInclude: stringList([...stringList(chapter.goals, 30), ...stringList(scene.goals, 30)], 30),
        avoid: stringList([...stringList(chapter.constraints, 30), ...stringList(scene.constraints, 30)], 30),
    });
}

function normalizeSceneReferenceSnapshot(value) {
    const result = [];
    for (const item of Array.isArray(value) ? value : []) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const content = text(item.content, 2000);
        if (!content) continue;
        result.push({
            source: text(item.source, 300),
            label: text(item.label, 200),
            content,
        });
        if (result.length >= 12) break;
    }
    return result;
}

export function upsertStoryProject(projectsValue, projectValue) {
    const projects = normalizeStoryProjects(projectsValue);
    const project = normalizeStoryProject(projectValue);
    if (!project) return { projects, project: null };
    const existingIndex = projects.findIndex(item => item.id === project.id);
    if (existingIndex >= 0) projects[existingIndex] = project;
    else {
        project.id = uniqueStoryProjectId(project.id, projects);
        projects.push(project);
    }
    return { projects, project };
}

export function storyProjectForChat(projectsValue, chatState) {
    const id = text(chatState?.storyProjectId, 120);
    return normalizeStoryProjects(projectsValue).find(project => project.id === id) ?? null;
}

export function assignStoryChat(projectsValue, projectId, storyValue) {
    const projects = normalizeStoryProjects(projectsValue);
    const story = normalizeProjectStory(storyValue);
    const targetId = text(projectId, 120);
    if (!story || !projects.some(project => project.id === targetId)) return projects;
    for (const project of projects) {
        project.stories = project.stories.filter(item => !isSameStory(item, story));
        if (project.id === targetId) project.stories.push(story);
    }
    return projects;
}

export function unassignStoryChat(projectsValue, storyValue) {
    const projects = normalizeStoryProjects(projectsValue);
    const story = normalizeProjectStory(typeof storyValue === 'string' ? { chatId: storyValue } : storyValue);
    if (!story) return projects;
    for (const project of projects) project.stories = project.stories.filter(item => !isSameStory(item, story));
    return projects;
}
