import { normalizeStoryProject } from './studio-project-core.js';
import { normalizeWritingProfile } from './studio-writing-core.js';

export const STORY_PROJECT_BUNDLE_SCHEMA = 'amy_story_project_bundle_v1';
export const STORY_PROJECT_BUNDLE_MODES = Object.freeze(['story_only', 'full']);

function text(value, limit = 500) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function assetPath(value, prefix) {
    const result = text(value, 500).replaceAll('\\', '/');
    if (!result.startsWith(`${prefix}/`) || result.includes('../') || result.includes('/..') || result.startsWith('/')) return '';
    return result;
}

function normalizeStoryAsset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const path = assetPath(value.path, 'stories');
    const chatId = text(value.chatId, 300);
    if (!path || !chatId) return null;
    return {
        path,
        chatId,
        ownerId: text(value.ownerId, 300),
        title: text(value.title, 300) || chatId,
        character: text(value.character, 200),
        worldInfo: text(value.worldInfo, 300),
        linkedAt: text(value.linkedAt, 40),
    };
}

function normalizeCharacterAsset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const path = assetPath(value.path, 'characters');
    const avatar = text(value.avatar, 300);
    if (!path || !avatar) return null;
    return {
        path,
        avatar,
        name: text(value.name, 200) || avatar.replace(/\.png$/i, ''),
        refs: [...new Set((Array.isArray(value.refs) ? value.refs : []).map(item => text(item, 300)).filter(Boolean))].slice(0, 100),
    };
}

function normalizeWorldAsset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const path = assetPath(value.path, 'worlds');
    const name = text(value.name, 300);
    if (!path || !name) return null;
    return { path, name, ref: text(value.ref, 300) || name };
}

function normalizeGroupAsset(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const path = assetPath(value.path, 'groups');
    const id = text(value.id, 300);
    if (!path || !id) return null;
    return { path, id, name: text(value.name, 300) || id };
}

function normalizeAssets(value, normalizer, limit) {
    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(value) ? value : []) {
        const normalized = normalizer(item);
        if (normalized && !seen.has(normalized.path)) {
            seen.add(normalized.path);
            result.push(normalized);
        }
        if (result.length >= limit) break;
    }
    return result;
}

function hasUniqueLogicalIdentifiers(assets, identifiers) {
    const claimed = new Map();
    for (const asset of assets) {
        for (const identifier of new Set(identifiers(asset).filter(Boolean))) {
            const owner = claimed.get(identifier);
            if (owner && owner !== asset.path) return false;
            claimed.set(identifier, asset.path);
        }
    }
    return true;
}

export function portableProjectForMode(projectValue, mode) {
    const project = normalizeStoryProject(projectValue);
    if (!project || !STORY_PROJECT_BUNDLE_MODES.includes(mode)) return null;
    if (mode === 'full') return project;
    return normalizeStoryProject({
        name: project.name,
        stories: project.stories.map(story => ({
            chatId: story.chatId,
            title: story.title,
            linkedAt: story.linkedAt,
        })),
    });
}

export function storyOnlyChatData(value) {
    const source = Array.isArray(value) ? value : [];
    const sourceHeader = source[0] && typeof source[0] === 'object' ? source[0] : {};
    const header = {
        user_name: text(sourceHeader.user_name, 200) || 'User',
        character_name: text(sourceHeader.character_name ?? sourceHeader.name, 200) || 'Story',
        create_date: text(sourceHeader.create_date, 80),
        chat_metadata: {},
    };
    const messages = source.slice(1).filter(message => message && typeof message === 'object' && message.is_system !== true)
        .map(message => ({
            name: text(message.name, 200),
            is_user: message.is_user === true,
            is_name: message.is_name === true,
            send_date: message.send_date ?? '',
            mes: typeof message.extra?.display_text === 'string'
                ? message.extra.display_text
                : typeof message.mes === 'string' ? message.mes : '',
        }))
        .filter(message => message.mes.trim());
    return [header, ...messages];
}

export function createStoryProjectBundleManifest({
    mode,
    project,
    stories = [],
    characters = [],
    worlds = [],
    groups = [],
    writingProfile = null,
    exportedAt = new Date().toISOString(),
} = {}) {
    const portableProject = portableProjectForMode(project, mode);
    if (!portableProject) return null;
    return normalizeStoryProjectBundleManifest({
        schema: STORY_PROJECT_BUNDLE_SCHEMA,
        version: 1,
        mode,
        exportedAt,
        project: portableProject,
        assets: { stories, characters, worlds, groups },
        writingProfile: mode === 'full' ? writingProfile : null,
    });
}

export function normalizeStoryProjectBundleManifest(value) {
    let input = value;
    try {
        if (typeof input === 'string') input = JSON.parse(input);
    } catch {
        return null;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    if (input.schema !== STORY_PROJECT_BUNDLE_SCHEMA || Number(input.version) !== 1) return null;
    if (!STORY_PROJECT_BUNDLE_MODES.includes(input.mode)) return null;
    const project = portableProjectForMode(input.project, input.mode);
    if (!project) return null;
    const assets = input.assets && typeof input.assets === 'object' ? input.assets : {};
    const stories = normalizeAssets(assets.stories, normalizeStoryAsset, 500);
    if (!stories.length) return null;
    if (input.mode === 'story_only') {
        for (const story of stories) {
            story.ownerId = '';
            story.character = '';
            story.worldInfo = '';
        }
    }
    const characters = input.mode === 'full' ? normalizeAssets(assets.characters, normalizeCharacterAsset, 200) : [];
    const worlds = input.mode === 'full' ? normalizeAssets(assets.worlds, normalizeWorldAsset, 200) : [];
    const groups = input.mode === 'full' ? normalizeAssets(assets.groups, normalizeGroupAsset, 100) : [];
    const writingProfile = input.mode === 'full' ? normalizeWritingProfile(input.writingProfile) : null;
    if (input.mode === 'full') {
        if (!hasUniqueLogicalIdentifiers(characters, asset => [asset.avatar, ...asset.refs])
            || !hasUniqueLogicalIdentifiers(worlds, asset => [asset.ref, asset.name])
            || !hasUniqueLogicalIdentifiers(groups, asset => [asset.id])) return null;
        const characterRefs = new Set(characters.flatMap(asset => [asset.avatar, ...asset.refs]));
        const worldRefs = new Set(worlds.flatMap(asset => [asset.ref, asset.name]));
        const groupIds = new Set(groups.map(asset => asset.id));
        const missingOwner = stories.some(story => story.ownerId.startsWith('group:')
            ? !groupIds.has(story.ownerId.slice('group:'.length))
            : !characterRefs.has(story.ownerId));
        const missingCharacter = project.characters.some(ref => !characterRefs.has(ref));
        const missingWorld = project.worlds.some(ref => !worldRefs.has(ref))
            || stories.some(story => story.worldInfo && !worldRefs.has(story.worldInfo));
        const missingProfile = project.writingProfileId && (!writingProfile || writingProfile.id !== project.writingProfileId);
        if (missingOwner || missingCharacter || missingWorld || missingProfile) return null;
    }
    return {
        schema: STORY_PROJECT_BUNDLE_SCHEMA,
        version: 1,
        mode: input.mode,
        exportedAt: text(input.exportedAt, 40),
        project,
        assets: {
            stories,
            characters,
            worlds,
            groups,
        },
        writingProfile,
    };
}

export function validateStoryProjectBundleResources(manifestValue, groupValues = []) {
    const manifest = normalizeStoryProjectBundleManifest(manifestValue);
    if (!manifest) return false;
    if (manifest.mode !== 'full') return true;
    const characterRefs = new Set(manifest.assets.characters.flatMap(asset => [asset.avatar, ...asset.refs]));
    const expectedGroups = new Set(manifest.assets.groups.map(asset => asset.id));
    const seenGroups = new Set();
    for (const item of Array.isArray(groupValues) ? groupValues : []) {
        const id = text(item?.asset?.id, 300);
        const group = item?.data;
        if (!id || seenGroups.has(id) || !expectedGroups.has(id) || !group || typeof group !== 'object') return false;
        seenGroups.add(id);
        const members = Array.isArray(group.members) ? group.members.map(member => text(member, 300)).filter(Boolean) : [];
        const disabled = Array.isArray(group.disabled_members) ? group.disabled_members.map(member => text(member, 300)).filter(Boolean) : [];
        if (members.some(member => !characterRefs.has(member))) return false;
        if (disabled.some(member => !members.includes(member) || !characterRefs.has(member))) return false;
    }
    return seenGroups.size === expectedGroups.size;
}

export function uniquePortableName(value, usedValues = [], suffix = 'Imported') {
    const name = text(value, 300) || 'Imported';
    const used = new Set((Array.isArray(usedValues) ? usedValues : []).map(item => text(item, 300).toLocaleLowerCase()));
    if (!used.has(name.toLocaleLowerCase())) return name;
    for (let index = 2; index < 10000; index++) {
        const candidate = `${name} (${suffix} ${index})`;
        if (!used.has(candidate.toLocaleLowerCase())) return candidate;
    }
    return `${name} (${Date.now().toString(36)})`;
}

export function remapImportedProject(manifestValue, {
    projectId,
    projectName,
    storyMappings = [],
    characterMappings = {},
    worldMappings = {},
    writingProfileId = '',
} = {}) {
    const manifest = normalizeStoryProjectBundleManifest(manifestValue);
    if (!manifest) return null;
    const project = structuredClone(manifest.project);
    project.id = text(projectId, 120);
    project.name = text(projectName, 200) || project.name;
    project.stories = storyMappings.map(mapping => ({
        chatId: text(mapping.chatId, 300),
        ownerId: text(mapping.ownerId, 300),
        title: text(mapping.title, 300) || text(mapping.chatId, 300),
        character: text(mapping.character, 200),
        linkedAt: text(mapping.linkedAt, 40),
    })).filter(story => story.chatId);
    if (manifest.mode === 'full') {
        project.characters = project.characters.map(ref => text(characterMappings[ref], 300) || ref);
        project.worlds = project.worlds.map(ref => text(worldMappings[ref], 300) || ref);
        project.writingProfileId = text(writingProfileId, 120);
    } else {
        project.characters = [];
        project.worlds = [];
        project.storyPlan = null;
        project.writingProfileId = '';
        project.notes = '';
    }
    return normalizeStoryProject(project);
}
