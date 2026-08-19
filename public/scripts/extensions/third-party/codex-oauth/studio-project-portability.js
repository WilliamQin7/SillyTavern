import { normalizeWritingProfile } from './studio-writing-core.js';
import { uniqueStoryProjectId } from './studio-project-core.js';
import {
    createStoryProjectBundleManifest,
    normalizeStoryProjectBundleManifest,
    remapImportedProject,
    storyOnlyChatData,
    uniquePortableName,
    validateStoryProjectBundleResources,
} from './studio-project-portability-core.js';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_TEXT_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_BINARY_ASSET_BYTES = 100 * 1024 * 1024;

function text(value) {
    return String(value ?? '').trim();
}

function slug(value, fallback = 'story-project') {
    return text(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || fallback;
}

function jsonLines(value) {
    return value.map(item => JSON.stringify(item)).join('\n');
}

function parseJsonLines(value) {
    const result = text(value).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (!result.length || !result[0] || typeof result[0] !== 'object') throw new Error('Story chat is empty or invalid.');
    return result;
}

async function isPng(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    return bytes.length === 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}

async function loadJSZip() {
    if (!globalThis.JSZip) await import('../../../../lib/jszip.min.js');
    if (!globalThis.JSZip) throw new Error('ZIP support is unavailable.');
    return globalThis.JSZip;
}

async function requestJson(url, deps, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: deps.getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.error === true) throw new Error(data?.message || `Request failed: ${url}`);
    return data;
}

async function readStory(story, deps) {
    if (story.ownerId.startsWith('group:')) {
        return requestJson('/api/chats/group/get', deps, { id: story.chatId });
    }
    if (!story.ownerId) throw new Error(`Story "${story.title}" has no owner reference.`);
    return requestJson('/api/chats/get', deps, { avatar_url: story.ownerId, file_name: story.chatId });
}

async function exportCharacter(character, deps) {
    const response = await fetch('/api/characters/export', {
        method: 'POST',
        headers: deps.getRequestHeaders(),
        body: JSON.stringify({ format: 'png', avatar_url: character.avatar }),
    });
    if (!response.ok) throw new Error(`Could not export character: ${character.name || character.avatar}`);
    return response.blob();
}

function resolveCharacters(project, deps, groups) {
    const all = deps.getCharacters();
    const avatars = new Set(project.stories.filter(story => !story.ownerId.startsWith('group:')).map(story => story.ownerId));
    for (const group of groups) for (const avatar of group.members ?? []) avatars.add(avatar);
    const selected = new Map();
    for (const ref of project.characters) {
        const avatarMatches = all.filter(character => character.avatar === ref);
        const matches = avatarMatches.length ? avatarMatches : all.filter(character => character.name === ref);
        if (matches.length > 1) throw new Error(`Full export found an ambiguous character reference: ${ref}`);
        if (matches.length === 1) selected.set(matches[0], [...(selected.get(matches[0]) ?? []), ref]);
    }
    for (const avatar of avatars) {
        const character = all.find(item => item.avatar === avatar);
        if (character && !selected.has(character)) selected.set(character, []);
    }
    return [...selected].map(([character, refs]) => ({ character, refs }));
}

function referencedGroups(project, deps) {
    const ids = new Set(project.stories
        .filter(story => story.ownerId.startsWith('group:'))
        .map(story => story.ownerId.slice('group:'.length)));
    return deps.getGroups().filter(group => ids.has(String(group.id)));
}

function assertCompleteResources(project, groups, characterItems) {
    const requiredGroupIds = new Set(project.stories
        .filter(story => story.ownerId.startsWith('group:'))
        .map(story => story.ownerId.slice('group:'.length)));
    const foundGroupIds = new Set(groups.map(group => String(group.id)));
    const missingGroups = [...requiredGroupIds].filter(id => !foundGroupIds.has(id));
    if (missingGroups.length) throw new Error(`Full export could not resolve group: ${missingGroups.join(', ')}`);

    const requiredCharacters = new Set(project.characters);
    for (const story of project.stories) if (story.ownerId && !story.ownerId.startsWith('group:')) requiredCharacters.add(story.ownerId);
    for (const group of groups) for (const member of group.members ?? []) requiredCharacters.add(member);
    const foundCharacters = new Set();
    for (const item of characterItems) {
        foundCharacters.add(item.character.avatar);
        for (const ref of item.refs) foundCharacters.add(ref);
    }
    const missingCharacters = [...requiredCharacters].filter(ref => !foundCharacters.has(ref));
    if (missingCharacters.length) throw new Error(`Full export could not resolve character: ${missingCharacters.join(', ')}`);
}

export async function exportStoryProjectBundle(project, mode, deps) {
    if (!project?.stories?.length) throw new Error('The project has no linked story chats to export.');
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const storyAssets = [];
    const continuityWorlds = new Set(project.worlds);
    for (const [index, story] of project.stories.entries()) {
        const chat = await readStory(story, deps);
        if (!Array.isArray(chat) || !chat.length) throw new Error(`Could not read story: ${story.title}`);
        const path = `stories/${String(index + 1).padStart(3, '0')}-${slug(story.title, 'chapter')}.jsonl`;
        const worldInfo = text(chat[0]?.chat_metadata?.world_info);
        if (worldInfo) continuityWorlds.add(worldInfo);
        const portableChat = mode === 'story_only' ? storyOnlyChatData(chat) : chat;
        storyAssets.push({ ...story, worldInfo, path });
        zip.file(path, jsonLines(portableChat));
    }

    const characterAssets = [];
    const worldAssets = [];
    const groupAssets = [];
    let writingProfile = null;
    if (mode === 'full') {
        const groups = referencedGroups(project, deps);
        for (const [index, group] of groups.entries()) {
            const path = `groups/${String(index + 1).padStart(3, '0')}-${slug(group.name, 'group')}.json`;
            zip.file(path, JSON.stringify(group, null, 2));
            groupAssets.push({ id: String(group.id), name: group.name, path });
        }
        const characters = resolveCharacters(project, deps, groups);
        assertCompleteResources(project, groups, characters);
        for (const [index, item] of characters.entries()) {
            const path = `characters/${String(index + 1).padStart(3, '0')}-${slug(item.character.name, 'character')}.png`;
            zip.file(path, await exportCharacter(item.character, deps));
            characterAssets.push({
                avatar: item.character.avatar,
                name: item.character.name,
                refs: item.refs,
                path,
            });
        }
        for (const [index, ref] of [...continuityWorlds].entries()) {
            const world = await deps.getWorldInfo(ref);
            if (!world) throw new Error(`Could not read World Info: ${ref}`);
            const path = `worlds/${String(index + 1).padStart(3, '0')}-${slug(ref, 'world')}.json`;
            zip.file(path, JSON.stringify(world, null, 2));
            worldAssets.push({ name: ref, ref, path });
        }
        writingProfile = (deps.getSettings().writingProfileTemplates ?? [])
            .find(profile => profile.id === project.writingProfileId) ?? null;
        if (project.writingProfileId && !writingProfile) {
            throw new Error(`Full export could not resolve Writing Profile: ${project.writingProfileId}`);
        }
    }

    const manifest = createStoryProjectBundleManifest({
        mode,
        project,
        stories: storyAssets,
        characters: characterAssets,
        worlds: worldAssets,
        groups: groupAssets,
        writingProfile,
    });
    if (!manifest) throw new Error('Could not create a portable project manifest.');
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${slug(project.id)}-${mode === 'full' ? 'full' : 'story-only'}.amy-story.zip`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return manifest;
}

async function zipText(zip, path) {
    const entry = zip.file(path);
    if (!entry) throw new Error(`Portable package is missing ${path}.`);
    const value = await entry.async('string');
    if (new Blob([value]).size > MAX_TEXT_ASSET_BYTES) throw new Error(`Portable package entry is too large: ${path}`);
    return value;
}

export async function readStoryProjectBundle(file) {
    if (!file || file.size > MAX_ARCHIVE_BYTES) throw new Error('Portable package is missing or too large.');
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(file, { checkCRC32: true, createFolders: false });
    const manifest = normalizeStoryProjectBundleManifest(await zipText(zip, 'manifest.json'));
    if (!manifest) throw new Error('Portable project manifest is invalid or unsupported.');
    const stories = [];
    let extractedBytes = 0;
    for (const asset of manifest.assets.stories) {
        const value = await zipText(zip, asset.path);
        extractedBytes += new Blob([value]).size;
        const chat = parseJsonLines(value);
        stories.push({ asset, chat: manifest.mode === 'story_only' ? storyOnlyChatData(chat) : chat });
    }
    const characters = [];
    for (const asset of manifest.assets.characters) {
        const entry = zip.file(asset.path);
        if (!entry) throw new Error(`Portable package is missing ${asset.path}.`);
        const blob = await entry.async('blob');
        if (blob.size > MAX_BINARY_ASSET_BYTES) throw new Error(`Portable package entry is too large: ${asset.path}`);
        if (!await isPng(blob)) throw new Error(`Portable character card is not a PNG file: ${asset.path}`);
        extractedBytes += blob.size;
        characters.push({ asset, blob });
    }
    const worlds = [];
    for (const asset of manifest.assets.worlds) {
        const value = await zipText(zip, asset.path);
        extractedBytes += new Blob([value]).size;
        const data = JSON.parse(value);
        if (!data || typeof data !== 'object' || Array.isArray(data) || !data.entries || typeof data.entries !== 'object') {
            throw new Error(`Portable World Info is invalid: ${asset.path}`);
        }
        worlds.push({ asset, data });
    }
    const groups = [];
    for (const asset of manifest.assets.groups) {
        const value = await zipText(zip, asset.path);
        extractedBytes += new Blob([value]).size;
        const data = JSON.parse(value);
        if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.members)) {
            throw new Error(`Portable group is invalid: ${asset.path}`);
        }
        groups.push({ asset, data });
    }
    if (!validateStoryProjectBundleResources(manifest, groups)) {
        throw new Error('Portable project contains incomplete or ambiguous group member references.');
    }
    if (extractedBytes > MAX_ARCHIVE_BYTES) throw new Error('Portable package expands beyond the safe size limit.');
    return { manifest, stories, characters, worlds, groups };
}

async function importCharacterAsset(item, deps) {
    const form = new FormData();
    form.append('avatar', item.blob, item.asset.avatar.endsWith('.png') ? item.asset.avatar : `${item.asset.avatar}.png`);
    form.append('file_type', 'png');
    form.append('user_name', 'User');
    const response = await fetch('/api/characters/import', {
        method: 'POST',
        headers: deps.getRequestHeaders({ omitContentType: true }),
        body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error || data.file_name === undefined) throw new Error(`Could not import character: ${item.asset.name}`);
    return `${data.file_name}.png`;
}

async function createArchiveCharacter(projectName, deps) {
    const card = {
        name: `${projectName} Story Archive`,
        description: 'Neutral container created for a story-only Amy Creator Studio import.',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: 'This card contains no migrated character or world settings.',
        tags: ['amy-story-import'],
    };
    const blob = new Blob([JSON.stringify(card)], { type: 'application/json' });
    const form = new FormData();
    form.append('avatar', blob, `${slug(projectName, 'story-archive')}.json`);
    form.append('file_type', 'json');
    form.append('user_name', 'User');
    const response = await fetch('/api/characters/import', {
        method: 'POST',
        headers: deps.getRequestHeaders({ omitContentType: true }),
        body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error || data.file_name === undefined) throw new Error('Could not create the neutral story archive character.');
    return `${data.file_name}.png`;
}

async function importWorldAsset(item, usedNames, deps) {
    const name = uniquePortableName(item.asset.name, usedNames);
    const blob = new Blob([JSON.stringify(item.data)], { type: 'application/json' });
    const form = new FormData();
    form.append('avatar', blob, `${name}.json`);
    const response = await fetch('/api/worldinfo/import', {
        method: 'POST',
        headers: deps.getRequestHeaders({ omitContentType: true }),
        body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.name) throw new Error(`Could not import World Info: ${item.asset.name}`);
    usedNames.push(data.name);
    return data.name;
}

function importedProfile(manifest, settings) {
    const profile = normalizeWritingProfile(manifest.writingProfile);
    if (!profile) return null;
    const used = new Set((settings.writingProfileTemplates ?? []).map(item => item.id));
    const base = slug(profile.id || profile.name, 'imported-profile').slice(0, 70);
    let id = base;
    for (let index = 2; used.has(id); index++) id = `${base.slice(0, 70)}-${index}`;
    return { ...profile, id };
}

function importedChatId(story, index) {
    return `${slug(story.chatId, 'chapter').slice(0, 80)}-imported-${Date.now().toString(36)}-${index + 1}`;
}

function patchProjectMetadata(chat, projectId, chatId, worldInfo = '', characterMappings = {}) {
    const result = structuredClone(chat);
    if (!result[0].chat_metadata || typeof result[0].chat_metadata !== 'object') result[0].chat_metadata = {};
    const state = result[0].chat_metadata.amy_creator_studio;
    const studioState = {
        ...(state && typeof state === 'object' ? state : {}),
        storyProjectId: projectId,
    };
    if (text(studioState.writingProfileSourceId).startsWith('project:')) {
        studioState.writingProfileSourceId = `project:${projectId}`;
    }
    if (typeof studioState.pendingMemories === 'string' && studioState.pendingMemories.trim()) {
        try {
            const pending = JSON.parse(studioState.pendingMemories);
            if (pending?.source && typeof pending.source === 'object') pending.source.chatId = chatId;
            studioState.pendingMemories = JSON.stringify(pending, null, 2);
        } catch { /* Preserve an invalid user draft for manual recovery. */ }
    }
    result[0].chat_metadata.amy_creator_studio = studioState;
    if (worldInfo) result[0].chat_metadata.world_info = worldInfo;
    else delete result[0].chat_metadata.world_info;
    for (const message of result.slice(1)) {
        const oldAvatar = text(message.original_avatar);
        const newAvatar = characterMappings[oldAvatar];
        if (!newAvatar) continue;
        message.original_avatar = newAvatar;
        if (typeof message.force_avatar === 'string') {
            message.force_avatar = message.force_avatar
                .replaceAll(encodeURIComponent(oldAvatar), encodeURIComponent(newAvatar))
                .replaceAll(oldAvatar, newAvatar);
        }
    }
    return result;
}

async function saveImportedStory(chat, ownerId, chatId, deps) {
    const isGroup = ownerId.startsWith('group:');
    const response = await fetch(isGroup ? '/api/chats/group/save' : '/api/chats/save', {
        method: 'POST',
        headers: deps.getRequestHeaders(),
        body: JSON.stringify(isGroup
            ? { id: chatId, chat, force: true }
            : { avatar_url: ownerId, file_name: chatId, chat, force: true }),
    });
    if (!response.ok) throw new Error(`Could not import story chat: ${chatId}`);
}

async function createImportedGroups(bundle, storyTargets, characterMappings, deps) {
    const groupMappings = Object.create(null);
    for (const item of bundle.groups) {
        const chatIds = storyTargets.filter(target => target.asset.ownerId === `group:${item.asset.id}`).map(target => target.chatId);
        if (!chatIds.length) continue;
        const group = item.data && typeof item.data === 'object' ? item.data : {};
        const response = await fetch('/api/groups/create', {
            method: 'POST',
            headers: deps.getRequestHeaders(),
            body: JSON.stringify({
                name: `${item.asset.name} (Imported)`,
                members: (Array.isArray(group.members) ? group.members : []).map(member => characterMappings[member]).filter(Boolean),
                allow_self_responses: !!group.allow_self_responses,
                activation_strategy: Number(group.activation_strategy) || 0,
                generation_mode: Number(group.generation_mode) || 0,
                disabled_members: (Array.isArray(group.disabled_members) ? group.disabled_members : [])
                    .map(member => characterMappings[member]).filter(Boolean),
                chat_id: chatIds[0],
                chats: chatIds,
                auto_mode_delay: Number(group.auto_mode_delay) || 5,
                generation_mode_join_prefix: text(group.generation_mode_join_prefix),
                generation_mode_join_suffix: text(group.generation_mode_join_suffix),
                hideMutedSprites: !!group.hideMutedSprites,
                fav: !!group.fav,
            }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.id) throw new Error(`Could not import group: ${item.asset.name}`);
        groupMappings[item.asset.id] = `group:${data.id}`;
    }
    return groupMappings;
}

export async function importStoryProjectBundle(bundle, deps) {
    const settings = deps.getSettings();
    const existingProjects = settings.storyProjects ?? [];
    const projectName = uniquePortableName(bundle.manifest.project.name, existingProjects.map(item => item.name));
    const projectId = uniqueStoryProjectId(bundle.manifest.project.id || projectName, existingProjects, projectName);
    const characterMappings = Object.create(null);
    for (const item of bundle.characters) {
        const avatar = await importCharacterAsset(item, deps);
        characterMappings[item.asset.avatar] = avatar;
        for (const ref of item.asset.refs) characterMappings[ref] = avatar;
    }

    const worldMappings = Object.create(null);
    const usedWorldNames = [...deps.getWorldNames()];
    for (const item of bundle.worlds) {
        const name = await importWorldAsset(item, usedWorldNames, deps);
        worldMappings[item.asset.ref] = name;
        worldMappings[item.asset.name] = name;
    }

    let fallbackOwner = Object.values(characterMappings)[0] || '';
    if (bundle.manifest.mode === 'story_only') {
        fallbackOwner = deps.getCurrentCharacter()?.avatar || await createArchiveCharacter(projectName, deps);
    } else if (!fallbackOwner) {
        fallbackOwner = deps.getCurrentCharacter()?.avatar || await createArchiveCharacter(projectName, deps);
    }

    const storyTargets = bundle.stories.map((item, index) => ({
        ...item,
        chatId: importedChatId(item.asset, index),
    }));
    const groupMappings = bundle.manifest.mode === 'full'
        ? await createImportedGroups(bundle, storyTargets, characterMappings, deps)
        : {};
    const storyMappings = [];
    for (const target of storyTargets) {
        const oldOwner = target.asset.ownerId;
        const ownerId = bundle.manifest.mode === 'story_only'
            ? fallbackOwner
            : oldOwner.startsWith('group:')
                ? groupMappings[oldOwner.slice('group:'.length)] || fallbackOwner
                : characterMappings[oldOwner] || fallbackOwner;
        const worldInfo = bundle.manifest.mode === 'full' ? worldMappings[target.asset.worldInfo] || '' : '';
        await saveImportedStory(patchProjectMetadata(target.chat, projectId, target.chatId, worldInfo, characterMappings), ownerId, target.chatId, deps);
        storyMappings.push({
            chatId: target.chatId,
            ownerId,
            title: target.asset.title,
            character: target.asset.character,
            linkedAt: new Date().toISOString(),
        });
    }

    const profile = importedProfile(bundle.manifest, settings);
    const project = remapImportedProject(bundle.manifest, {
        projectId,
        projectName,
        storyMappings,
        characterMappings,
        worldMappings,
        writingProfileId: profile?.id ?? '',
    });
    if (!project) throw new Error('Could not rebuild the imported project.');
    await deps.refreshCharacters();
    await deps.refreshWorlds();
    return { project, profile };
}
