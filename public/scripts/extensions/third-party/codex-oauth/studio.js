import { characters, chat_metadata, eventSource, event_types, getCharacters, getCurrentChatId, getMaxPromptTokens, getRequestHeaders, saveMetadata, saveSettingsDebounced, this_chid } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { groups } from '../../../group-chats.js';
import { oai_settings } from '../../../openai.js';
import { Popup } from '../../../popup.js';
import { getContext } from '../../../st-context.js';
import { escapeHtml } from '../../../utils.js';
import { createWorldInfoEntry, getWorldInfoPrompt, loadWorldInfo, saveWorldInfo, updateWorldInfoList, world_info_budget, world_info_budget_cap } from '../../../world-info.js';
import { tr, translateStudioValidationErrors } from './i18n.js';
import { evaluateStoryGenerationReadiness, normalizeSceneBrief, normalizeStoryProjectChatState, normalizeStoryProjectSettings, storyProjectStoryKey } from './studio-project-core.js';
import { bindStoryProject, storyProjectAdvancedTabMarkup, storyProjectMarkup, storyProjectTabMarkup } from './studio-project.js';
import {
    compileWritingContext,
    buildCurrentSceneWritingRequest,
    markNarrativeLedgerStale,
    mergeNarrativeLedger,
    normalizeWritingProfile,
    WRITING_CONTEXT_ENTRY_COMMENT,
} from './studio-writing-core.js';
import {
    bindWritingControl,
    normalizeWritingChatState,
    normalizeWritingExtensionSettings,
    writingControlMarkup,
    writingControlTabMarkup,
} from './studio-writing.js';
import {
    activeStoryPlanContext,
    appendAudit,
    buildAssetPrompt,
    characterCreatePayload,
    creatorPrompt,
    memorySourceMatchesChat,
    memoryPrompt,
    normalizeMemoryEnvelope,
    normalizeMemoryDraft,
    normalizeStoryPlan,
    normalizeStoryPlanProgress,
    normalizeStoryState,
    normalizeStudioSettings,
    partitionNewMemories,
    sceneMemoryPrompt,
    STORY_PLAN_ENTRY_COMMENT,
    storyPlanPrompt,
    storyPlanToLoreContent,
    STORY_STATE_ENTRY_COMMENT,
    storyStateToLoreContent,
    validateStudioDraft,
} from './studio-core.js';

const SETTINGS_KEY = 'codex_oauth_studio';
const CHAT_STATE_KEY = 'amy_creator_studio';
const PROVIDER_ID = 'codex-oauth';
let chatSaveTimer = null;
let writingController = null;
let projectController = null;

function settings() {
    const input = extension_settings[SETTINGS_KEY];
    const normalized = normalizeStudioSettings(input);
    normalized.writingProfileTemplates = input?.writingProfileTemplates;
    normalized.storyProjects = input?.storyProjects;
    extension_settings[SETTINGS_KEY] = normalizeStoryProjectSettings(normalizeWritingExtensionSettings(normalized));
    return extension_settings[SETTINGS_KEY];
}

function persist() {
    saveSettingsDebounced();
}

function chatState() {
    const input = chat_metadata[CHAT_STATE_KEY];
    const state = input && typeof input === 'object' ? input : {};
    const storyPlan = normalizeStoryPlan(state.storyPlan);
    chat_metadata[CHAT_STATE_KEY] = normalizeStoryProjectChatState(normalizeWritingChatState({
        ...state,
        pendingMemories: typeof state.pendingMemories === 'string' ? state.pendingMemories : '',
        pendingPlanOutline: typeof state.pendingPlanOutline === 'string' ? state.pendingPlanOutline : '',
        pendingPlan: typeof state.pendingPlan === 'string' ? state.pendingPlan : '',
        lastMemoryMessageCount: Math.max(0, Number(state.lastMemoryMessageCount) || 0),
        storyState: normalizeStoryState(state.storyState),
        storyPlan,
        storyPlanProgress: normalizeStoryPlanProgress(state.storyPlanProgress, storyPlan),
    }));
    return chat_metadata[CHAT_STATE_KEY];
}

function currentStoryReference() {
    const context = getContext();
    return {
        chatId: String(getCurrentChatId() ?? ''),
        ownerId: context.groupId ? `group:${context.groupId}` : characters[this_chid]?.avatar ?? '',
    };
}

function persistChat({ immediate = false } = {}) {
    const storyKey = storyProjectStoryKey(currentStoryReference());
    if (!storyKey) return Promise.resolve();
    if (chatSaveTimer) clearTimeout(chatSaveTimer);
    const save = async () => {
        chatSaveTimer = null;
        if (storyProjectStoryKey(currentStoryReference()) !== storyKey) return;
        await saveMetadata();
    };
    if (immediate) return save();
    chatSaveTimer = setTimeout(() => void save(), 500);
    return Promise.resolve();
}

function currentModel() {
    const provider = extension_settings.codex_oauth ?? {};
    return String(provider.manualModel || provider.model || 'gpt-5.4').trim();
}

async function codexText(prompt) {
    const provider = extension_settings.codex_oauth ?? {};
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: PROVIDER_ID,
            model: currentModel(),
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            codex_oauth: {
                reasoningEffort: provider.reasoningEffort === 'auto' ? undefined : provider.reasoningEffort,
                speedMode: provider.speedMode ?? 'standard',
                logLevel: 'brief',
            },
        }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || tr('studio.error.codexFailed'));
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error(tr('studio.error.emptyDraft'));
    return text;
}

function uniqueWorldName(preferred) {
    const names = new Set(getContext().getWorldInfoNames());
    if (!names.has(preferred)) return preferred;
    for (let index = 2; index < 1000; index++) {
        const candidate = `${preferred} (${index})`;
        if (!names.has(candidate)) return candidate;
    }
    return `${preferred} ${Date.now()}`;
}

function toWorldInfo(draft) {
    const data = { entries: {} };
    for (const source of draft.lorebook.entries) {
        const entry = createWorldInfoEntry(draft.lorebook.name, data);
        if (!entry) throw new Error(tr('studio.error.worldEntry'));
        Object.assign(entry, {
            key: source.keys,
            keysecondary: source.secondary_keys,
            content: source.content,
            comment: source.comment,
            constant: source.constant,
            selective: source.selective,
            order: source.order,
            position: 0,
            disable: false,
        });
    }
    return data;
}

async function importDraft() {
    const result = validateStudioDraft($('#amy-studio-draft').val());
    if (!result.valid) throw new Error(translateStudioValidationErrors(result.errors).join('\n'));
    const draft = result.draft;
    const confirmed = await Popup.show.confirm(
        tr('studio.popup.importTitle', { name: escapeHtml(draft.card.data.name) }),
        tr('studio.popup.importBody', { count: draft.lorebook.entries.length }),
    );
    if (!confirmed) return;

    const worldName = uniqueWorldName(draft.lorebook.name);
    await saveWorldInfo(worldName, toWorldInfo(draft), true);
    await updateWorldInfoList();
    const response = await fetch('/api/characters/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(characterCreatePayload(draft, worldName)),
    });
    if (!response.ok) throw new Error(await response.text() || tr('studio.error.characterImport'));
    const avatar = await response.text();
    await getCharacters();
    const state = settings();
    state.visualAnchor = draft.visual.anchor;
    state.visualStyle = draft.visual.style || state.visualStyle;
    appendAudit(state, { tool: 'character_import', status: 'approved', summary: draft.card.data.name });
    persist();
    renderSettings();
    toastr.success(tr('studio.toast.created', { name: draft.card.data.name, world: worldName }), tr('studio.error.actionTitle'));
    return avatar;
}

function quoteSlash(value) {
    return JSON.stringify(String(value ?? ''));
}

async function runSlash(command) {
    const result = await getContext().executeSlashCommandsWithOptions(command, {
        handleExecutionErrors: true,
        source: 'Amy Creator Studio',
    });
    if (result?.isError) throw new Error(result.errorMessage || tr('studio.error.slashFailed'));
    return String(result?.pipe ?? '');
}

async function generateCodexImageBlob(prompt, size, quality = 'high') {
    const response = await fetch('/api/plugins/codex-oauth/image', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ prompt, model: currentModel(), size, quality }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || tr('studio.error.imageFailed'));
    return await (await fetch(`data:image/${data.format || 'png'};base64,${data.data}`)).blob();
}

async function uploadExpressionSprite(blob, label) {
    const character = characters[this_chid];
    if (!character?.name) throw new Error(tr('studio.error.openCharacterExpression'));
    if (!/^[a-z]+$/i.test(label)) throw new Error(tr('studio.error.expressionLabel'));
    const form = new FormData();
    form.append('name', character.name);
    form.append('label', label.toLowerCase());
    form.append('spriteName', label.toLowerCase());
    form.append('avatar', blob, `${label.toLowerCase()}.png`);
    const response = await fetch('/api/sprites/upload', {
        method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form,
    });
    if (!response.ok) throw new Error(await response.text() || tr('studio.error.expressionUpload'));
    return `${character.name}/${label.toLowerCase()}.png`;
}

async function uploadAndSelectBackground(blob) {
    const characterName = String(characters[this_chid]?.name || 'scene').replace(/[^a-z0-9_-]/gi, '_');
    const fileName = `amy-${characterName}-${Date.now()}.png`;
    const form = new FormData();
    form.append('avatar', blob, fileName);
    const response = await fetch('/api/backgrounds/upload', {
        method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form,
    });
    if (!response.ok) throw new Error(await response.text() || tr('studio.error.backgroundUpload'));
    const savedName = await response.text();
    await runSlash(`/bg ${quoteSlash(savedName)}`);
    return savedName;
}

async function generateAsset({ type, detail, requireConfirmation = false } = {}) {
    const state = settings();
    const character = characters[this_chid];
    const assetType = type || state.assetType;
    const prompt = buildAssetPrompt({
        type: assetType,
        characterName: character?.name,
        visualAnchor: state.visualAnchor || character?.description,
        visualStyle: state.visualStyle,
        detail: detail ?? state.assetDetail,
    });
    if (requireConfirmation) {
        const confirmed = await Popup.show.confirm(tr('studio.popup.generateImageTitle'), escapeHtml(prompt));
        if (!confirmed) {
            appendAudit(state, { tool: 'image_generate', status: 'cancelled', summary: assetType });
            persist();
            return tr('studio.result.cancelled');
        }
    }
    let result;
    if (assetType === 'expression') {
        const blob = await generateCodexImageBlob(prompt, '1024x1536');
        result = await uploadExpressionSprite(blob, state.expressionLabel);
        toastr.success(tr('studio.toast.expressionSaved', { label: state.expressionLabel }), tr('studio.error.actionTitle'));
    } else if (assetType === 'background') {
        const blob = await generateCodexImageBlob(prompt, '1536x1024');
        result = await uploadAndSelectBackground(blob);
        toastr.success(tr('studio.toast.backgroundSaved'), tr('studio.error.actionTitle'));
    } else {
        result = await runSlash(`/imagine source=codex quiet=false gallery=true ${quoteSlash(prompt)}`);
    }
    appendAudit(state, { tool: 'image_generate', status: 'approved', summary: `${assetType}: ${String(detail ?? state.assetDetail).slice(0, 80)}` });
    persist();
    renderAudit();
    return result || tr('studio.result.imageCompleted');
}

async function generateAndSetPortrait() {
    const character = characters[this_chid];
    if (!character?.avatar) throw new Error(tr('studio.error.openCharacterPortrait'));
    const state = settings();
    const prompt = buildAssetPrompt({
        type: 'portrait',
        characterName: character.name,
        visualAnchor: state.visualAnchor || character.description,
        visualStyle: state.visualStyle,
        detail: state.assetDetail,
    });
    const confirmed = await Popup.show.confirm(tr('studio.popup.replacePortraitTitle', { name: escapeHtml(character.name) }), escapeHtml(prompt));
    if (!confirmed) return;

    const blob = await generateCodexImageBlob(prompt, '1024x1536');
    const form = new FormData();
    form.append('avatar', blob, 'avatar.png');
    form.append('avatar_url', character.avatar);
    const upload = await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: form,
    });
    if (!upload.ok) throw new Error(await upload.text() || tr('studio.error.portraitUpload'));
    await getCharacters();
    appendAudit(state, { tool: 'portrait_replace', status: 'approved', summary: character.name });
    persist();
    renderAudit();
    toastr.success(tr('studio.toast.portraitUpdated', { name: character.name }), tr('studio.error.actionTitle'));
}

function transcriptWindow(windowSize) {
    const context = getContext();
    const messages = context.chat
        .map((message, id) => ({ message, id }))
        .filter(({ message }) => !message.is_system && typeof message.mes === 'string' && message.mes.trim())
        .slice(-windowSize);
    return {
        text: messages.map(({ message }) => `${message.is_user ? context.name1 : (message.name || context.name2)}: ${message.mes}`).join('\n\n'),
        source: {
            chatId: String(getCurrentChatId() ?? ''),
            startMessageId: messages[0]?.id ?? null,
            endMessageId: messages.at(-1)?.id ?? null,
            messageCount: messages.length,
        },
    };
}

function currentGenerationReadiness() {
    const state = chatState();
    return evaluateStoryGenerationReadiness({
        contextTokens: oai_settings.openai_max_context,
        responseTokens: oai_settings.openai_max_tokens,
        expectedSceneWords: state.expectedSceneWords,
        compiledContextTokens: state.compiledWritingContext?.estimatedTokens,
        worldInfoPercent: world_info_budget,
        worldInfoCap: world_info_budget_cap,
    });
}

function currentSceneCompilationInputs(state = chatState()) {
    return {
        sceneBrief: state.sceneBrief,
        reviewedContinuity: storyStateToLoreContent(state.storyState),
        projectReferences: state.sceneReferenceSnapshot,
        budgetChars: 6000,
    };
}

function alignSceneBriefToFocus(state, plan, progress) {
    const focus = activeStoryPlanContext(plan, progress);
    if (!focus?.chapter) return normalizeSceneBrief(state.sceneBrief);
    const current = normalizeSceneBrief(state.sceneBrief);
    const chapterId = focus.chapter.id ?? '';
    const sceneId = focus.scene?.id ?? '';
    const changed = Boolean(current.chapterId || current.sceneId)
        && (current.chapterId !== chapterId || current.sceneId !== sceneId);
    return normalizeSceneBrief({
        ...(changed ? {} : current),
        chapterId,
        sceneId,
    });
}

function entryKeys(entry) {
    const raw = Array.isArray(entry?.key) ? entry.key : String(entry?.key ?? '').split(/\r?\n|,/);
    return raw.map(item => String(item ?? '').trim()).filter(Boolean);
}

async function collectProjectSceneReferences(project, state, plan, progress) {
    if (!project?.worlds?.length) return [];
    const focus = activeStoryPlanContext(plan, progress);
    const brief = alignSceneBriefToFocus(state, plan, progress);
    const projectCharacters = project.characters
        .map(ref => characters.find(character => character?.avatar === ref || character?.name === ref)?.name ?? '')
        .filter(Boolean);
    const focusText = JSON.stringify({
        chapter: focus?.chapter ?? null,
        scene: focus?.scene ?? null,
        brief,
    }).toLocaleLowerCase();
    const cast = [...new Set([
        ...brief.cast,
        ...(state.storyState?.scene?.presentCharacters ?? []),
        ...projectCharacters.filter(name => focusText.includes(name.toLocaleLowerCase())),
    ])].slice(0, 20);
    const candidates = [];
    for (const [worldIndex, worldName] of project.worlds.slice(0, 20).entries()) {
        let world;
        try {
            world = await loadWorldInfo(worldName);
        } catch (error) {
            console.warn('[amy-studio] Failed to load a project World Info reference', worldName, error);
            continue;
        }
        for (const [entryIndex, entry] of Object.values(world?.entries ?? {}).entries()) {
            if (entry?.disable === true || !String(entry?.content ?? '').trim()) continue;
            const content = String(entry.content).trim();
            const label = String(entry.comment ?? '').trim();
            const keys = entryKeys(entry);
            const keywordMatch = keys.some(key => focusText.includes(key.toLocaleLowerCase()));
            const castMatch = cast.some(name => {
                const term = name.toLocaleLowerCase();
                return label.toLocaleLowerCase().includes(term)
                    || keys.some(key => key.toLocaleLowerCase() === term)
                    || content.toLocaleLowerCase().includes(term);
            });
            const relationshipMatch = /关系|relationship|初始|opening/i.test([label, ...keys].join(' ')) && castMatch;
            if (entry.constant !== true && !keywordMatch && !castMatch && !relationshipMatch) continue;
            candidates.push({
                source: worldName,
                label,
                content: content.slice(0, 1600),
                score: (relationshipMatch ? 100 : 0) + (castMatch ? 50 : 0) + (keywordMatch ? 20 : 0) + (entry.constant === true ? 5 : 0),
                order: worldIndex * 10000 + entryIndex,
            });
        }
    }
    candidates.sort((left, right) => right.score - left.score || left.order - right.order);
    const selected = [];
    let totalChars = 0;
    for (const candidate of candidates) {
        if (selected.length >= 10) break;
        if (totalChars + candidate.content.length > 3200) continue;
        const { score: _score, order: _order, ...reference } = candidate;
        selected.push(reference);
        totalChars += candidate.content.length;
    }
    return selected;
}

function currentWritingContextIsFresh() {
    const state = chatState();
    if (!state.writingControlActive || !state.writingProfile) return true;
    const compiled = compileWritingContext({
        profile: state.writingProfile,
        plan: state.storyPlanProgress?.active ? state.storyPlan : null,
        progress: state.storyPlanProgress,
        ledger: state.narrativeLedger,
        expectedSceneWords: state.expectedSceneWords,
        ...currentSceneCompilationInputs(state),
    });
    return Boolean(state.compiledWritingContext?.sourceHash)
        && compiled.sourceHash === state.compiledWritingContext.sourceHash;
}

function applyRecommendedGenerationCapacity(readiness = currentGenerationReadiness()) {
    const contextTokens = Math.max(readiness.contextTokens, readiness.recommendedContextTokens);
    const responseTokens = Math.max(readiness.responseTokens, readiness.recommendedResponseTokens);
    const contextControl = $('#openai_max_context');
    const contextCounter = $('#openai_max_context_counter');
    const responseControl = $('#openai_max_tokens');
    let contextMaximum = Number(contextControl.attr('max')) || Number.POSITIVE_INFINITY;
    const responseMaximum = Number(responseControl.attr('max')) || Number.POSITIVE_INFINITY;

    if (contextMaximum < contextTokens) {
        const unlockControl = $('#oai_max_context_unlocked');
        if (unlockControl.length) {
            unlockControl.prop('checked', true).trigger('input');
            contextMaximum = Math.max(Number(contextControl.attr('max')) || 0, contextTokens);
            contextControl.attr('max', contextMaximum);
            contextCounter.attr('max', contextMaximum);
        }
    }

    if (contextMaximum < contextTokens || responseMaximum < responseTokens) {
        throw new Error(tr('studio.error.generationCapacityLimit', {
            context: contextTokens,
            response: responseTokens,
        }));
    }
    contextControl.val(contextTokens).trigger('input');
    responseControl.val(responseTokens).trigger('input');
    oai_settings.openai_max_context = contextTokens;
    oai_settings.openai_max_tokens = responseTokens;
    saveSettingsDebounced();
    return currentGenerationReadiness();
}

function currentSceneWritingRequest() {
    const state = chatState();
    if (!state.storyPlanProgress?.active) throw new Error(tr('studio.error.sceneFocusMissing'));
    const focus = activeStoryPlanContext(state.storyPlan, state.storyPlanProgress);
    if (!focus?.chapter) throw new Error(tr('studio.error.sceneFocusMissing'));
    return buildCurrentSceneWritingRequest({
        chapterTitle: focus.chapter.title,
        sceneTitle: focus.scene?.title ?? '',
        language: state.writingProfile?.contract?.language,
        expectedSceneWords: state.expectedSceneWords,
    });
}

function stageCurrentSceneWritingRequest(request) {
    const input = $('#send_textarea');
    if (!input.length) throw new Error(tr('studio.error.chatInputMissing'));
    input.val(String(request ?? '')).trigger('input').focus();
}

async function prepareMemoryDraft(prompt, toastKey, { requireStoryState = false } = {}) {
    const { text, source } = transcriptWindow(settings().memoryWindow);
    if (!source.chatId || !text) throw new Error(tr('studio.error.openChatMemory'));
    const state = chatState();
    const planContext = activeStoryPlanContext(state.storyPlan, state.storyPlanProgress);
    const currentFocus = planContext ? {
        chapterId: planContext.chapter.id,
        chapterTitle: planContext.chapter.title,
        sceneId: planContext.scene?.id ?? '',
        sceneTitle: planContext.scene?.title ?? '',
    } : null;
    const raw = await codexText(prompt(
        text,
        state.storyState,
        state.narrativeLedger,
        state.writingProfile,
        currentFocus,
    ));
    assertMemorySource(source);
    const draft = normalizeMemoryEnvelope(raw, source);
    if (!draft.memories.length && !draft.storyState) throw new Error(tr('studio.error.noMemories'));
    if (requireStoryState && !storyStateToLoreContent(draft.storyState)) throw new Error(tr('studio.error.noStoryState'));
    state.pendingMemories = JSON.stringify({
        source,
        memories: draft.memories,
        ...(draft.storyState ? { storyState: draft.storyState } : {}),
        ...(requireStoryState ? { narrativeLedgerDelta: draft.narrativeLedgerDelta } : {}),
    }, null, 2);
    state.lastMemoryMessageCount = getContext().chat.filter(message => !message.is_system).length;
    assertMemorySource(source);
    await persistChat({ immediate: true });
    renderSettings();
    toastr.success(tr(toastKey, { count: draft.memories.length }), tr('studio.error.actionTitle'));
}

async function extractMemories() {
    await prepareMemoryDraft(memoryPrompt, 'studio.toast.memoriesPrepared');
}

async function closeScene() {
    await prepareMemoryDraft(sceneMemoryPrompt, 'studio.toast.scenePrepared', { requireStoryState: true });
}

async function generateStoryPlanDraft() {
    const outline = String($('#amy-studio-plan-outline').val() ?? '').trim();
    if (!outline) throw new Error(tr('studio.error.planOutline'));
    const source = { chatId: String(getCurrentChatId() ?? '') };
    if (!source.chatId) throw new Error(tr('studio.error.openChatPlan'));
    let plan = normalizeStoryPlan(outline);
    if (!plan) plan = normalizeStoryPlan(await codexText(storyPlanPrompt(outline)));
    assertMemorySource(source);
    if (!plan) throw new Error(tr('studio.error.planInvalid'));
    const state = chatState();
    state.pendingPlan = JSON.stringify(plan, null, 2);
    await persistChat({ immediate: true });
    renderSettings();
    toastr.success(tr('studio.toast.planPrepared', { count: plan.chapters.length }), tr('studio.error.actionTitle'));
}

async function syncActiveContext(content, source, comment) {
    const bookName = await runSlash(`/getchatbook create=${content ? 'true' : 'false'}`);
    assertMemorySource(source);
    if (!bookName) return;
    const data = await loadWorldInfo(bookName) ?? { entries: {} };
    assertMemorySource(source);
    data.entries ??= {};
    const activeComments = new Set([STORY_PLAN_ENTRY_COMMENT, WRITING_CONTEXT_ENTRY_COMMENT]);
    const existingEntries = Object.entries(data.entries).filter(([, entry]) => activeComments.has(entry?.comment));
    const preferred = existingEntries.find(([, entry]) => entry?.comment === comment) ?? existingEntries[0];
    if (!content) {
        if (existingEntries.length) {
            for (const [entryId] of existingEntries) delete data.entries[entryId];
            await saveWorldInfo(bookName, data, true);
        }
        assertMemorySource(source);
        return;
    }
    const entry = preferred?.[1] ?? createWorldInfoEntry(bookName, data);
    if (!entry) throw new Error(tr('studio.error.memoryEntry'));
    for (const [entryId, duplicate] of existingEntries) {
        if (duplicate !== entry) delete data.entries[entryId];
    }
    Object.assign(entry, {
        key: [],
        content,
        comment,
        constant: true,
        // This entry is unique, reviewed, chat-scoped, and compiler-bounded. It must not disappear
        // merely because other constant lore exhausts the percentage-based World Info budget.
        ignoreBudget: true,
        vectorized: false,
        order: 950,
        position: 0,
        disable: false,
    });
    assertMemorySource(source);
    await saveWorldInfo(bookName, data, true);
    assertMemorySource(source);
}

async function syncActiveStoryPlan(plan, progress, source, state = chatState()) {
    state.sceneBrief = alignSceneBriefToFocus(state, plan, progress);
    const project = settings().storyProjects.find(item => item.id === state.storyProjectId) ?? null;
    state.sceneReferenceSnapshot = project
        ? await collectProjectSceneReferences(project, state, plan, progress)
        : [];
    if (state.writingControlActive && state.writingProfile) {
        const compiled = compileWritingContext({
            profile: state.writingProfile,
            plan: progress.active ? plan : null,
            progress,
            ledger: state.narrativeLedger,
            expectedSceneWords: state.expectedSceneWords,
            ...currentSceneCompilationInputs(state),
        });
        await syncActiveContext(compiled.text, source, WRITING_CONTEXT_ENTRY_COMMENT);
        state.compiledWritingContext = compiled;
        return;
    }
    await syncActiveContext(storyPlanToLoreContent(plan, progress), source, STORY_PLAN_ENTRY_COMMENT);
}

async function verifyActiveWritingContext(expectedContent, source) {
    if (!expectedContent) return { proof: 'none' };
    const bookName = chat_metadata.world_info;
    const data = bookName ? await loadWorldInfo(bookName) : null;
    const protectedEntry = Object.values(data?.entries ?? {}).find(entry => (
        entry?.comment === WRITING_CONTEXT_ENTRY_COMMENT
        && entry.content === expectedContent
        && entry.constant === true
        && entry.disable !== true
        && entry.ignoreBudget === true
    ));
    if (!protectedEntry) throw new Error(tr('studio.error.projectContextNotActive'));
    const context = getContext();
    const chat = context.chat
        .filter(message => !message.is_system && typeof message.mes === 'string')
        .map(message => `${message.name}: ${message.mes}`)
        .reverse();
    let result;
    try {
        result = await getWorldInfoPrompt(chat, getMaxPromptTokens(), true, {
            personaDescription: '',
            characterDescription: '',
            characterPersonality: '',
            characterDepthPrompt: '',
            scenario: '',
            creatorNotes: '',
            trigger: 'normal',
        });
    } catch (error) {
        const responseText = String(error?.responseText ?? error?.response?.responseText ?? '');
        if (Number(error?.status ?? error?.response?.status) === 403 && /csrf/i.test(responseText)) {
            console.warn('[amy-studio] Prompt scan was unavailable because the page CSRF token expired; the protected active chat entry was verified instead.');
            return { proof: 'protected-entry' };
        }
        let serialized = '';
        try {
            serialized = JSON.stringify(error);
        } catch {
            // Fall through to the bounded string representation below.
        }
        const detail = error?.message ?? error?.error?.message ?? (serialized || String(error));
        throw new Error(`${tr('studio.error.projectContextNotActive')} (${detail})`);
    }
    assertMemorySource(source);
    if (!result.worldInfoString.includes(expectedContent)) {
        throw new Error(tr('studio.error.projectContextNotActive'));
    }
    return { proof: 'prompt-scan' };
}

async function prepareStoryProjectChat(project) {
    const source = { chatId: String(getCurrentChatId() ?? '') };
    if (!source.chatId) throw new Error(tr('studio.error.openChatProject'));
    const state = chatState();
    const sameProject = state.storyProjectId === project.id;
    const switchingProject = Boolean(state.storyProjectId && !sameProject);
    const plan = normalizeStoryPlan(project.storyPlan);
    const profile = project.writingProfileId
        ? normalizeWritingProfile(settings().writingProfileTemplates.find(item => item.id === project.writingProfileId))
        : null;
    if (project.writingProfileId && !profile) throw new Error(tr('studio.error.projectWritingMissing'));

    const progress = plan
        ? normalizeStoryPlanProgress(sameProject
            ? { ...state.storyPlanProgress, active: true }
            : { active: true }, plan)
        : state.storyPlanProgress;
    const activePlan = plan ?? (!switchingProject && state.storyPlanProgress?.active ? state.storyPlan : null);
    const activeProgress = plan
        ? progress
        : { ...state.storyPlanProgress, active: switchingProject ? false : state.storyPlanProgress?.active === true };
    const clearProjectWriting = switchingProject
        && !profile
        && state.writingProfileSourceId.startsWith('project:');
    const activeProfile = profile
        ?? (!clearProjectWriting && state.writingControlActive ? state.writingProfile : null);
    state.sceneBrief = alignSceneBriefToFocus(state, activePlan, activeProgress);
    const sceneReferenceSnapshot = await collectProjectSceneReferences(project, state, activePlan, activeProgress);
    state.sceneReferenceSnapshot = sceneReferenceSnapshot;
    const compiled = activeProfile
        ? compileWritingContext({
            profile: activeProfile,
            plan: activeProgress?.active ? activePlan : null,
            progress: activeProgress,
            ledger: state.narrativeLedger,
            expectedSceneWords: state.expectedSceneWords,
            ...currentSceneCompilationInputs(state),
        })
        : null;

    const expectedContent = compiled?.text ?? (plan ? storyPlanToLoreContent(plan, progress) : '');
    if (compiled) {
        await syncActiveContext(expectedContent, source, WRITING_CONTEXT_ENTRY_COMMENT);
    } else if (plan) {
        await syncActiveContext(expectedContent, source, STORY_PLAN_ENTRY_COMMENT);
    } else if (switchingProject) {
        await syncActiveContext('', source, STORY_PLAN_ENTRY_COMMENT);
    }
    assertMemorySource(source);
    const verification = await verifyActiveWritingContext(expectedContent, source);

    // World Info slash commands can replace chat_metadata; never persist through the stale pre-sync object.
    const latestState = chatState();
    latestState.storyProjectId = project.id;
    latestState.sceneBrief = state.sceneBrief;
    latestState.sceneReferenceSnapshot = sceneReferenceSnapshot;
    if (plan) {
        latestState.storyPlan = plan;
        latestState.storyPlanProgress = progress;
        latestState.pendingPlan = JSON.stringify(plan, null, 2);
        latestState.pendingPlanOutline = '';
    } else if (switchingProject) {
        latestState.storyPlanProgress = activeProgress;
    }
    if (profile) {
        latestState.writingProfile = profile;
        latestState.pendingWritingProfile = JSON.stringify(profile, null, 2);
        latestState.writingProfileSourceId = `project:${project.id}`;
        latestState.writingControlActive = true;
    } else if (clearProjectWriting) {
        latestState.writingControlActive = false;
    }
    if (compiled) {
        latestState.compiledWritingContext = compiled;
    } else if (clearProjectWriting) {
        latestState.compiledWritingContext = {
            text: '',
            reasons: [],
            exclusions: [],
            warnings: [],
            sourceHash: '',
            estimatedTokens: 0,
            includesFuture: false,
        };
    }
    const context = plan ? activeStoryPlanContext(plan, progress) : null;
    latestState.storyPreparationVerification = {
        projectId: project.id,
        chapterId: context?.chapter.id ?? '',
        sceneId: context?.scene?.id ?? '',
        profileId: profile?.id ?? '',
        proof: verification.proof,
        verifiedAt: new Date().toISOString(),
    };
    await persistChat({ immediate: true });
    assertMemorySource(source);

    return {
        projectId: project.id,
        planActive: Boolean(plan && progress.active),
        chapterId: context?.chapter.id ?? '',
        chapterTitle: context?.chapter.title ?? '',
        sceneId: context?.scene?.id ?? '',
        profileId: profile?.id ?? '',
        writingActive: Boolean(compiled),
        contextVerified: Boolean(expectedContent),
        includesFuture: false,
    };
}

async function saveReviewedStoryPlan() {
    const plan = normalizeStoryPlan($('#amy-studio-plan-draft').val());
    if (!plan) throw new Error(tr('studio.error.planInvalid'));
    const source = { chatId: String(getCurrentChatId() ?? '') };
    if (!source.chatId) throw new Error(tr('studio.error.openChatPlan'));
    const currentProgress = normalizeStoryPlanProgress(chatState().storyPlanProgress, plan);
    const bodyKey = chat_metadata.main_chat && currentProgress.active
        ? 'studio.popup.savePlanBranchBody'
        : 'studio.popup.savePlanBody';
    const confirmed = await Popup.show.confirm(
        tr('studio.popup.savePlanTitle'),
        tr(bodyKey, { count: plan.chapters.length }),
    );
    if (!confirmed) return;
    assertMemorySource(source);
    const state = chatState();
    const progress = normalizeStoryPlanProgress(state.storyPlanProgress, plan);
    if (progress.active) await syncActiveStoryPlan(plan, progress, source, state);
    assertMemorySource(source);
    const latestState = chatState();
    latestState.storyPlan = plan;
    latestState.storyPlanProgress = progress;
    latestState.pendingPlan = JSON.stringify(plan, null, 2);
    latestState.pendingPlanOutline = '';
    if (state.compiledWritingContext?.text) latestState.compiledWritingContext = state.compiledWritingContext;
    latestState.storyPreparationVerification = {
        projectId: '', chapterId: '', sceneId: '', profileId: '', verifiedAt: '',
    };
    await persistChat({ immediate: true });
    appendAudit(settings(), { tool: 'story_plan_save', status: 'approved', summary: `${plan.chapters.length} chapters` });
    persist();
    renderSettings();
    toastr.success(tr('studio.toast.planSaved', { count: plan.chapters.length }), tr('studio.error.actionTitle'));
}

function selectedStoryPlanProgress(active) {
    return {
        active,
        chapterId: String($('#amy-studio-plan-chapter').val() ?? ''),
        sceneId: String($('#amy-studio-plan-scene').val() ?? ''),
    };
}

async function activateStoryPlan() {
    const source = { chatId: String(getCurrentChatId() ?? '') };
    if (!source.chatId) throw new Error(tr('studio.error.openChatPlan'));
    const state = chatState();
    if (!state.storyPlan) throw new Error(tr('studio.error.planMissing'));
    const progress = normalizeStoryPlanProgress(selectedStoryPlanProgress(true), state.storyPlan);
    const context = activeStoryPlanContext(state.storyPlan, progress);
    const bodyKey = chat_metadata.main_chat ? 'studio.popup.activatePlanBranchBody' : 'studio.popup.activatePlanBody';
    const confirmed = await Popup.show.confirm(
        tr('studio.popup.activatePlanTitle'),
        tr(bodyKey, { chapter: context.chapter.title, scene: context.scene?.title ?? tr('studio.plan.noScene') }),
    );
    if (!confirmed) return;
    await syncActiveStoryPlan(state.storyPlan, progress, source, state);
    assertMemorySource(source);
    const expectedContent = state.writingControlActive && state.compiledWritingContext?.text
        ? state.compiledWritingContext.text
        : storyPlanToLoreContent(state.storyPlan, progress);
    const verification = await verifyActiveWritingContext(expectedContent, source);
    // World Info commands may replace chat_metadata. Persist only through the current object.
    const latestState = chatState();
    latestState.storyPlanProgress = progress;
    if (state.compiledWritingContext?.text) latestState.compiledWritingContext = state.compiledWritingContext;
    latestState.storyPreparationVerification = {
        projectId: latestState.storyProjectId,
        chapterId: context.chapter.id,
        sceneId: context.scene?.id ?? '',
        profileId: latestState.writingControlActive ? latestState.writingProfile?.id ?? '' : '',
        proof: verification.proof,
        verifiedAt: new Date().toISOString(),
    };
    await persistChat({ immediate: true });
    appendAudit(settings(), { tool: 'story_plan_activate', status: 'approved', summary: `${progress.chapterId}/${progress.sceneId || '-'}` });
    persist();
    renderSettings();
    toastr.success(tr('studio.toast.planActivated', { chapter: context.chapter.title, scene: context.scene?.title ?? tr('studio.plan.noScene') }), tr('studio.error.actionTitle'));
}

async function deactivateStoryPlan() {
    const source = { chatId: String(getCurrentChatId() ?? '') };
    if (!source.chatId) throw new Error(tr('studio.error.openChatPlan'));
    const state = chatState();
    if (!state.storyPlanProgress.active) {
        toastr.info(tr('studio.toast.planAlreadyInactive'), tr('studio.error.actionTitle'));
        return;
    }
    const bodyKey = chat_metadata.main_chat
        ? 'studio.popup.deactivatePlanBranchBody'
        : 'studio.popup.deactivatePlanBody';
    const confirmed = await Popup.show.confirm(tr('studio.popup.deactivatePlanTitle'), tr(bodyKey));
    if (!confirmed) return;
    const progress = { ...state.storyPlanProgress, active: false };
    await syncActiveStoryPlan(state.storyPlan, progress, source, state);
    assertMemorySource(source);
    const latestState = chatState();
    latestState.storyPlanProgress = progress;
    if (state.compiledWritingContext?.text) latestState.compiledWritingContext = state.compiledWritingContext;
    latestState.storyPreparationVerification = {
        projectId: '', chapterId: '', sceneId: '', profileId: '', verifiedAt: '',
    };
    await persistChat({ immediate: true });
    appendAudit(settings(), { tool: 'story_plan_deactivate', status: 'approved', summary: progress.chapterId });
    persist();
    renderSettings();
    toastr.success(tr('studio.toast.planDeactivated'), tr('studio.error.actionTitle'));
}

async function createCheckpoint() {
    if (!getCurrentChatId() || !getContext().chat.length) throw new Error(tr('studio.error.openChatCheckpoint'));
    const confirmed = await Popup.show.confirm(
        tr('studio.popup.checkpointTitle'),
        tr('studio.popup.checkpointBody'),
    );
    if (!confirmed) return;
    const checkpoint = await runSlash('/checkpoint-create');
    if (!checkpoint) throw new Error(tr('studio.error.checkpointCreate'));
    const state = settings();
    appendAudit(state, { tool: 'checkpoint_create', status: 'approved', summary: checkpoint });
    persist();
    renderAudit();
    toastr.success(tr('studio.toast.checkpointCreated', { name: checkpoint }), tr('studio.error.actionTitle'));
}

async function maybePrepareAutomaticMemory() {
    const state = chatState();
    if (!settings().autoMemoryDraft || state.pendingMemories || !getCurrentChatId()) return;
    const messageCount = getContext().chat.filter(message => !message.is_system).length;
    if (messageCount - state.lastMemoryMessageCount < settings().autoMemoryEvery) return;
    try {
        await extractMemories();
    } catch (error) {
        console.warn('[amy-studio] automatic memory draft failed:', error.message);
    }
}

function assertMemorySource(source) {
    if (source?.chatId && !memorySourceMatchesChat(source, getCurrentChatId())) {
        throw new Error(tr('studio.error.memoryWrongChat', { expected: source.chatId, current: getCurrentChatId() ?? '-' }));
    }
}

function hasLedgerDelta(delta) {
    if (!delta || typeof delta !== 'object') return false;
    return Object.values(delta.metrics ?? {}).some(value => Number(value) > 0)
        || Object.keys(delta.factMentions ?? {}).length > 0
        || Object.keys(delta.ruleApplications ?? {}).length > 0
        || (delta.recentMotifs ?? []).length > 0
        || (delta.recentPhrases ?? []).length > 0;
}

async function saveMemoryEntries(memories, {
    confirm = true,
    source = null,
    storyState = null,
    narrativeLedgerDelta = null,
    auditSource = 'memory_review',
} = {}) {
    const reviewedStoryState = normalizeStoryState(storyState);
    const storyContent = storyStateToLoreContent(reviewedStoryState);
    if (!memories.length && !storyContent) throw new Error(tr('studio.error.noValidMemories'));
    assertMemorySource(source);
    const state = settings();
    if (confirm) {
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.saveMemoryTitle'),
            tr(storyContent ? 'studio.popup.saveSceneBody' : 'studio.popup.saveMemoryBody', { count: memories.length }),
        );
        if (!confirmed) {
            appendAudit(state, { tool: auditSource, status: 'cancelled', summary: `${memories.length} memories` });
            persist();
            return tr('studio.result.cancelled');
        }
    }
    assertMemorySource(source);
    const bookName = await runSlash('/getchatbook create=true');
    assertMemorySource(source);
    if (!bookName) throw new Error(tr('studio.error.chatBook'));
    const data = await loadWorldInfo(bookName) ?? { entries: {} };
    assertMemorySource(source);
    data.entries ??= {};
    const { fresh, duplicates } = partitionNewMemories(memories, Object.values(data.entries));
    const range = Number.isInteger(source?.startMessageId) && Number.isInteger(source?.endMessageId)
        ? ` · #${source.startMessageId}–${source.endMessageId}`
        : '';
    for (const memory of fresh) {
        const entry = createWorldInfoEntry(bookName, data);
        if (!entry) throw new Error(tr('studio.error.memoryEntry'));
        Object.assign(entry, {
            key: memory.keys,
            content: `[${memory.kind}; importance ${memory.importance}/5] ${memory.content}`,
            comment: `${memory.title}${range}`,
            constant: false,
            vectorized: true,
            order: 200 + memory.importance,
            position: 0,
            disable: false,
        });
    }
    if (storyContent) {
        let entry = Object.values(data.entries).find(item => item?.comment === STORY_STATE_ENTRY_COMMENT);
        entry ??= createWorldInfoEntry(bookName, data);
        if (!entry) throw new Error(tr('studio.error.memoryEntry'));
        Object.assign(entry, {
            key: [],
            content: storyContent,
            comment: STORY_STATE_ENTRY_COMMENT,
            constant: true,
            vectorized: false,
            order: 900,
            position: 0,
            disable: false,
        });
    }
    if (fresh.length || storyContent) await saveWorldInfo(bookName, data, true);
    assertMemorySource(source);
    const chat = chatState();
    chat.pendingMemories = '';
    if (storyContent) chat.storyState = reviewedStoryState;
    if (storyContent && hasLedgerDelta(narrativeLedgerDelta)) {
        chat.narrativeLedger = mergeNarrativeLedger(chat.narrativeLedger, narrativeLedgerDelta);
    }
    appendAudit(state, {
        tool: auditSource,
        status: fresh.length || storyContent ? 'approved' : 'skipped',
        summary: `${fresh.length} saved, ${duplicates.length} duplicate, story state ${storyContent ? 'updated' : 'unchanged'} → ${bookName}`,
    });
    persist();
    await persistChat({ immediate: true });
    renderSettings();
    if (storyContent && !fresh.length) {
        toastr.success(tr('studio.toast.storyStateSaved', { book: bookName, duplicates: duplicates.length }), tr('studio.error.actionTitle'));
    } else if (!fresh.length) {
        toastr.info(tr('studio.toast.noNewMemories', { count: duplicates.length }), tr('studio.error.actionTitle'));
    } else if (duplicates.length) {
        toastr.success(tr('studio.toast.memoriesSavedWithDuplicates', { count: fresh.length, duplicates: duplicates.length, book: bookName }), tr('studio.error.actionTitle'));
    } else {
        toastr.success(tr('studio.toast.memoriesSaved', { count: fresh.length, book: bookName }), tr('studio.error.actionTitle'));
    }
    return tr('studio.result.memoriesSaved', { count: fresh.length });
}

async function savePendingMemories() {
    const draft = normalizeMemoryEnvelope($('#amy-studio-memory-draft').val());
    if (!draft.source.chatId) throw new Error(tr('studio.error.memoryMissingSource'));
    await saveMemoryEntries(draft.memories, {
        source: draft.source,
        storyState: draft.storyState,
        narrativeLedgerDelta: draft.narrativeLedgerDelta,
    });
}

function registerSafeTools() {
    const { ToolManager } = getContext();
    ToolManager.registerFunctionTool({
        name: 'AmyStudioRemember',
        displayName: tr('studio.tool.rememberName'),
        description: tr('studio.tool.rememberDescription'),
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                content: { type: 'string', description: 'Standalone third-person memory; never include secrets.' },
                keys: { type: 'array', items: { type: 'string' } },
                kind: { type: 'string', enum: ['fact', 'event', 'relationship', 'goal', 'state'] },
                importance: { type: 'integer', minimum: 1, maximum: 5 },
            },
            required: ['title', 'content', 'keys'],
        },
        shouldRegister: () => settings().enableSafeTools,
        action: async args => saveMemoryEntries(normalizeMemoryDraft({ memories: [args] }), {
            confirm: true,
            source: transcriptWindow(1).source,
            auditSource: 'tool_memory',
        }),
    });
    ToolManager.registerFunctionTool({
        name: 'AmyStudioGenerateImage',
        displayName: tr('studio.tool.imageName'),
        description: tr('studio.tool.imageDescription'),
        parameters: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['portrait', 'expression', 'background'] },
                detail: { type: 'string' },
            },
            required: ['type', 'detail'],
        },
        shouldRegister: () => settings().enableSafeTools,
        action: args => generateAsset({ type: args.type, detail: args.detail, requireConfirmation: true }),
    });
}

function renderAudit() {
    const rows = settings().audit.slice(-20).reverse().map(entry =>
        `${entry.time}  ${tr(`studio.audit.${entry.status}`)}  ${entry.tool}  ${entry.summary ?? ''}`,
    );
    $('#amy-studio-audit').text(rows.join('\n') || tr('studio.tools.noActions'));
}

function populateStoryPlanScenes(chapter) {
    const sceneSelect = $('#amy-studio-plan-scene').empty();
    if (!chapter?.scenes.length) {
        sceneSelect.append($('<option>').val('').text(tr('studio.plan.noScene'))).prop('disabled', true);
        return;
    }
    sceneSelect.prop('disabled', false);
    for (const scene of chapter.scenes) sceneSelect.append($('<option>').val(scene.id).text(scene.title));
}

function renderStoryPlanSelectors() {
    const state = chatState();
    const plan = state.storyPlan;
    const progress = normalizeStoryPlanProgress(state.storyPlanProgress, plan);
    const chapterSelect = $('#amy-studio-plan-chapter').empty();
    const sceneSelect = $('#amy-studio-plan-scene').empty();
    if (!plan) {
        chapterSelect.append($('<option>').val('').text(tr('studio.plan.noPlan'))).prop('disabled', true);
        sceneSelect.append($('<option>').val('').text(tr('studio.plan.noScene'))).prop('disabled', true);
        $('#amy-studio-plan-status').text(tr('studio.plan.inactive'));
        return;
    }
    chapterSelect.prop('disabled', false);
    for (const chapter of plan.chapters) chapterSelect.append($('<option>').val(chapter.id).text(chapter.title));
    chapterSelect.val(progress.chapterId);
    const chapter = plan.chapters.find(item => item.id === progress.chapterId) ?? plan.chapters[0];
    populateStoryPlanScenes(chapter);
    if (chapter.scenes.length) $('#amy-studio-plan-scene').val(progress.sceneId || chapter.scenes[0].id);
    const context = activeStoryPlanContext(plan, progress);
    $('#amy-studio-plan-status').text(progress.active
        ? tr('studio.plan.active', { chapter: context.chapter.title, scene: context.scene?.title ?? tr('studio.plan.noScene') })
        : tr('studio.plan.inactive'));
}

function renderSettings() {
    const state = settings();
    const memoryState = chatState();
    $('#amy-studio-idea').val(state.idea);
    $('#amy-studio-draft').val(state.draft);
    $('#amy-studio-visual-anchor').val(state.visualAnchor);
    $('#amy-studio-visual-style').val(state.visualStyle);
    $('#amy-studio-asset-type').val(state.assetType);
    $('#amy-studio-asset-detail').val(state.assetDetail);
    $('#amy-studio-expression-label').val(state.expressionLabel);
    $('#amy-studio-memory-window').val(state.memoryWindow);
    $('#amy-studio-auto-memory').prop('checked', state.autoMemoryDraft);
    $('#amy-studio-auto-memory-every').val(state.autoMemoryEvery);
    $('#amy-studio-memory-draft').val(memoryState.pendingMemories);
    $('#amy-studio-plan-outline').val(memoryState.pendingPlanOutline);
    $('#amy-studio-plan-draft').val(memoryState.pendingPlan || (memoryState.storyPlan ? JSON.stringify(memoryState.storyPlan, null, 2) : ''));
    $('#amy-studio-story-state').text(memoryState.storyState
        ? JSON.stringify(memoryState.storyState, null, 2)
        : tr('studio.memory.noStoryState'));
    let source = null;
    try {
        source = memoryState.pendingMemories ? normalizeMemoryEnvelope(memoryState.pendingMemories).source : null;
    } catch {
        // Keep an in-progress manual edit visible without replacing it.
    }
    $('#amy-studio-memory-source').text(source?.chatId
        ? tr('studio.memory.source', { chat: source.chatId, start: source.startMessageId ?? '-', end: source.endMessageId ?? '-' })
        : tr('studio.memory.noSource'));
    $('#amy-studio-safe-tools').prop('checked', state.enableSafeTools);
    renderStoryPlanSelectors();
    renderAudit();
    writingController?.render();
    projectController?.render();
}

function setBusy(button, busy) {
    button.prop('disabled', busy).toggleClass('disabled', busy);
}

function bindAction(selector, action) {
    $(selector).on('click', async function () {
        const button = $(this);
        setBusy(button, true);
        try {
            await action();
        } catch (error) {
            console.error('[amy-studio]', error);
            toastr.error(error.message, tr('studio.error.actionTitle'));
        } finally {
            setBusy(button, false);
        }
    });
}

function validateCharacterDraft(value) {
    try {
        return validateStudioDraft(value);
    } catch (error) {
        if (error?.message === 'The model response did not contain a JSON object.') {
            throw new Error(tr('studio.error.characterJsonMissing'));
        }
        throw error;
    }
}

function createPanel() {
    if ($('#amy-creator-studio').length) return;
    const panel = $(`
        <div id="amy-creator-studio" class="amy-studio inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b data-i18n="amyCreatorStudio.studio.title">✨ Amy Creator Studio</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small data-i18n="amyCreatorStudio.studio.subtitle">Codex-powered character authoring, consistent visual assets, reviewed memory, and confirmation-gated tools.</small>
                <div class="amy-studio-nav-label" data-i18n="amyCreatorStudio.studio.nav.daily">Daily writing</div>
                <div class="amy-studio-tabs amy-studio-tabs-primary flex-container">
                    ${storyProjectTabMarkup()}
                    <button class="menu_button amy-studio-tab" data-tab="plan" data-i18n="amyCreatorStudio.studio.tab.plan">Story plan</button>
                    <button class="menu_button amy-studio-tab" data-tab="memory" data-i18n="amyCreatorStudio.studio.tab.memory">Memory</button>
                </div>
                <details class="amy-studio-nav-more">
                    <summary data-i18n="amyCreatorStudio.studio.nav.more">Project and advanced settings</summary>
                    <div class="amy-studio-tabs flex-container">
                        ${storyProjectAdvancedTabMarkup()}
                        <button class="menu_button amy-studio-tab" data-tab="character" data-i18n="amyCreatorStudio.studio.tab.character">Character</button>
                        <button class="menu_button amy-studio-tab" data-tab="assets" data-i18n="amyCreatorStudio.studio.tab.assets">Assets</button>
                        ${writingControlTabMarkup()}
                        <button class="menu_button amy-studio-tab" data-tab="tools" data-i18n="amyCreatorStudio.studio.tab.tools">Safe tools</button>
                    </div>
                </details>
                ${storyProjectMarkup()}
                <section data-amy-tab="character" class="displayNone">
                    <small data-i18n="amyCreatorStudio.studio.character.associationNote">This tab creates or imports a new character card. To associate an existing character, use Novel Project, choose the character, then save the project.</small>
                    <label><span data-i18n="amyCreatorStudio.studio.character.idea">Character idea</span><textarea id="amy-studio-idea" class="text_pole" rows="4" placeholder="Describe the character, relationship, setting, tone, and boundaries." data-i18n="[placeholder]amyCreatorStudio.studio.character.ideaPlaceholder"></textarea></label>
                    <div class="flex-container"><button id="amy-studio-generate" class="menu_button" data-i18n="amyCreatorStudio.studio.character.generate">Generate draft</button><button id="amy-studio-validate" class="menu_button" data-i18n="amyCreatorStudio.studio.character.validate">Validate</button><button id="amy-studio-import" class="menu_button" data-i18n="amyCreatorStudio.studio.character.import">Import character + lorebook</button></div>
                    <label><span data-i18n="amyCreatorStudio.studio.character.draft">Reviewable Character Card V3 draft</span><textarea id="amy-studio-draft" class="text_pole monospace" rows="14"></textarea></label>
                </section>
                <section data-amy-tab="assets" class="displayNone">
                    <label><span data-i18n="amyCreatorStudio.studio.assets.anchor">Visual identity anchor</span><textarea id="amy-studio-visual-anchor" class="text_pole" rows="4" placeholder="Stable face, hair, body, clothing, colors, signature details." data-i18n="[placeholder]amyCreatorStudio.studio.assets.anchorPlaceholder"></textarea></label>
                    <label><span data-i18n="amyCreatorStudio.studio.assets.style">Style bible</span><textarea id="amy-studio-visual-style" class="text_pole" rows="3"></textarea></label>
                    <label><span data-i18n="amyCreatorStudio.studio.assets.type">Asset type</span><select id="amy-studio-asset-type" class="text_pole"><option value="portrait" data-i18n="amyCreatorStudio.studio.assets.portrait">Portrait</option><option value="expression" data-i18n="amyCreatorStudio.studio.assets.expression">Expression</option><option value="background" data-i18n="amyCreatorStudio.studio.assets.background">Background</option></select></label>
                    <label><span data-i18n="amyCreatorStudio.studio.assets.expressionLabel">Expression label</span><select id="amy-studio-expression-label" class="text_pole"><option value="neutral" data-i18n="amyCreatorStudio.studio.assets.expression.neutral">neutral</option><option value="joy" data-i18n="amyCreatorStudio.studio.assets.expression.joy">joy</option><option value="sadness" data-i18n="amyCreatorStudio.studio.assets.expression.sadness">sadness</option><option value="anger" data-i18n="amyCreatorStudio.studio.assets.expression.anger">anger</option><option value="surprise" data-i18n="amyCreatorStudio.studio.assets.expression.surprise">surprise</option><option value="fear" data-i18n="amyCreatorStudio.studio.assets.expression.fear">fear</option></select></label>
                    <label><span data-i18n="amyCreatorStudio.studio.assets.detail">Scene / expression detail</span><textarea id="amy-studio-asset-detail" class="text_pole" rows="3"></textarea></label>
                    <div class="flex-container"><button id="amy-studio-asset-generate" class="menu_button" data-i18n="amyCreatorStudio.studio.assets.generate">Generate selected asset</button><button id="amy-studio-portrait-set" class="menu_button" data-i18n="amyCreatorStudio.studio.assets.setPortrait">Generate portrait + set avatar</button></div>
                    <small data-i18n="amyCreatorStudio.studio.assets.note">Portraits go to chat/gallery; expressions are installed as sprites; backgrounds are uploaded and selected immediately.</small>
                </section>
                <section data-amy-tab="plan" class="displayNone">
                    <div id="amy-studio-plan-focus" class="amy-studio-ready-panel">
                    <h4 data-i18n="amyCreatorStudio.studio.plan.focusHeading">Current writing focus</h4>
                    <label><span data-i18n="amyCreatorStudio.studio.plan.chapter">Current chapter</span><select id="amy-studio-plan-chapter" class="text_pole"></select></label>
                    <label><span data-i18n="amyCreatorStudio.studio.plan.scene">Current scene</span><select id="amy-studio-plan-scene" class="text_pole"></select></label>
                    <div class="flex-container"><button id="amy-studio-plan-activate" class="menu_button" data-i18n="amyCreatorStudio.studio.plan.activate">Confirm and activate selected focus</button><button id="amy-studio-plan-deactivate" class="menu_button" data-i18n="amyCreatorStudio.studio.plan.deactivate">Deactivate plan</button></div>
                    <small id="amy-studio-plan-status"></small>
                    <small data-i18n="amyCreatorStudio.studio.plan.note">Only the selected chapter and scene are added to the writing context. Future chapters stay hidden, and the plan is never treated as established canon.</small>
                    </div>
                    <details>
                    <summary data-i18n="amyCreatorStudio.studio.plan.editPlan">Create or edit the full Story Plan</summary>
                    <label><span data-i18n="amyCreatorStudio.studio.plan.outline">Existing outline (Markdown or Story Plan JSON)</span><textarea id="amy-studio-plan-outline" class="text_pole monospace" rows="8" placeholder="Paste the novel premise and chapter outline here." data-i18n="[placeholder]amyCreatorStudio.studio.plan.outlinePlaceholder"></textarea></label>
                    <div class="flex-container"><button id="amy-studio-plan-generate" class="menu_button" data-i18n="amyCreatorStudio.studio.plan.generate">Prepare structured plan</button><button id="amy-studio-plan-save" class="menu_button" data-i18n="amyCreatorStudio.studio.plan.save">Save reviewed plan</button></div>
                    <label><span data-i18n="amyCreatorStudio.studio.plan.draft">Reviewable Story Plan draft</span><textarea id="amy-studio-plan-draft" class="text_pole monospace" rows="14"></textarea></label>
                    </details>
                </section>
                ${writingControlMarkup()}
                <section data-amy-tab="memory" class="displayNone">
                    <label><span data-i18n="amyCreatorStudio.studio.memory.window">Recent messages to inspect</span><input id="amy-studio-memory-window" class="text_pole" type="number" min="4" max="100"></label>
                    <label class="checkbox_label"><input id="amy-studio-auto-memory" type="checkbox"><span data-i18n="amyCreatorStudio.studio.memory.auto">Automatically prepare a review draft</span></label>
                    <label><span data-i18n="amyCreatorStudio.studio.memory.every">Prepare after this many new messages</span><input id="amy-studio-auto-memory-every" class="text_pole" type="number" min="4" max="100"></label>
                    <div class="flex-container"><button id="amy-studio-memory-extract" class="menu_button" data-i18n="amyCreatorStudio.studio.memory.extract">Extract memory draft</button><button id="amy-studio-scene-close" class="menu_button" data-i18n="amyCreatorStudio.studio.memory.sceneClose">Prepare scene close</button><button id="amy-studio-memory-save" class="menu_button" data-i18n="amyCreatorStudio.studio.memory.save">Save reviewed draft</button><button id="amy-studio-checkpoint" class="menu_button" data-i18n="amyCreatorStudio.studio.memory.checkpoint">Create checkpoint</button></div>
                    <label><span data-i18n="amyCreatorStudio.studio.memory.draft">Reviewable memory and story-state draft</span><textarea id="amy-studio-memory-draft" class="text_pole monospace" rows="12"></textarea></label>
                    <small id="amy-studio-memory-source"></small>
                    <small data-i18n="amyCreatorStudio.studio.memory.note">Memories are atomic and vectorized. A reviewed story state is kept as one compact, always-on chat lorebook entry. Nothing is written until Save is confirmed.</small>
                    <details><summary data-i18n="amyCreatorStudio.studio.memory.currentState">Current reviewed story state</summary><pre id="amy-studio-story-state" class="amy-studio-audit"></pre></details>
                </section>
                <section data-amy-tab="tools" class="displayNone">
                    <label class="checkbox_label"><input id="amy-studio-safe-tools" type="checkbox"><span data-i18n="amyCreatorStudio.studio.tools.enable">Allow Codex to propose Amy Studio tools</span></label>
                    <small data-i18n="amyCreatorStudio.studio.tools.note">Enabling this also enables SillyTavern function calling. Only AmyStudioRemember and AmyStudioGenerateImage are exposed. Both require an on-screen confirmation before a write or paid image request. Other SillyTavern and third-party tools remain blocked for this provider.</small>
                    <h4 data-i18n="amyCreatorStudio.studio.tools.audit">Local audit trail</h4><pre id="amy-studio-audit" class="amy-studio-audit"></pre>
                </section>
            </div>
        </div>`);
    $('#extensions_settings2').prepend(panel);

    $('.amy-studio-tab').on('click', async function () {
        const tab = $(this).data('tab');
        $('[data-amy-tab]').addClass('displayNone');
        $(`[data-amy-tab="${tab}"]`).removeClass('displayNone');
        $('.amy-studio-tab').removeClass('selected');
        $(this).addClass('selected');
        if (tab === 'project' || tab === 'scene') {
            try {
                await getCharacters();
            } catch (error) {
                console.error('[amy-studio] Failed to refresh characters', error);
            }
            projectController?.render();
        }
    });
    $('.amy-studio-tab[data-tab="scene"]').addClass('selected');
    $('#amy-studio-idea, #amy-studio-draft, #amy-studio-visual-anchor, #amy-studio-visual-style, #amy-studio-asset-detail').on('input', function () {
        const state = settings();
        const map = {
            'amy-studio-idea': 'idea', 'amy-studio-draft': 'draft', 'amy-studio-visual-anchor': 'visualAnchor',
            'amy-studio-visual-style': 'visualStyle', 'amy-studio-asset-detail': 'assetDetail',
        };
        state[map[this.id]] = String($(this).val() ?? '');
        persist();
    });
    $('#amy-studio-memory-draft').on('input', function () {
        chatState().pendingMemories = String($(this).val() ?? '');
        persistChat();
    });
    $('#amy-studio-plan-outline').on('input', function () {
        chatState().pendingPlanOutline = String($(this).val() ?? '');
        persistChat();
    });
    $('#amy-studio-plan-draft').on('input', function () {
        chatState().pendingPlan = String($(this).val() ?? '');
        persistChat();
    });
    $('#amy-studio-plan-chapter').on('change', function () {
        const plan = chatState().storyPlan;
        const chapter = plan?.chapters.find(item => item.id === String($(this).val()));
        populateStoryPlanScenes(chapter);
    });
    $('#amy-studio-asset-type').on('change', function () { settings().assetType = String($(this).val()); persist(); });
    $('#amy-studio-expression-label').on('change', function () { settings().expressionLabel = String($(this).val()); persist(); });
    $('#amy-studio-memory-window').on('change', function () { settings().memoryWindow = Math.min(100, Math.max(4, Number($(this).val()) || 24)); persist(); });
    $('#amy-studio-auto-memory').on('change', function () {
        const state = settings();
        state.autoMemoryDraft = Boolean($(this).prop('checked'));
        chatState().lastMemoryMessageCount = getContext().chat.filter(message => !message.is_system).length;
        persist();
        persistChat();
    });
    $('#amy-studio-auto-memory-every').on('change', function () { settings().autoMemoryEvery = Math.min(100, Math.max(4, Number($(this).val()) || 12)); persist(); });
    $('#amy-studio-safe-tools').on('change', function () {
        const enabled = Boolean($(this).prop('checked'));
        settings().enableSafeTools = enabled;
        if (enabled && !oai_settings.function_calling) {
            oai_settings.function_calling = true;
            $('#openai_function_calling').prop('checked', true);
        }
        persist();
        toastr.info(enabled ? tr('studio.tools.enabled') : tr('studio.tools.disabled'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-generate', async () => {
        const state = settings();
        if (!state.idea.trim()) throw new Error(tr('studio.error.describeCharacter'));
        const raw = await codexText(creatorPrompt(state.idea));
        const result = validateCharacterDraft(raw);
        if (!result.valid) throw new Error(tr('studio.error.generatedValidation', { errors: translateStudioValidationErrors(result.errors).join('\n') }));
        state.draft = JSON.stringify(result.draft, null, 2);
        state.visualAnchor = result.draft.visual.anchor;
        state.visualStyle = result.draft.visual.style || state.visualStyle;
        persist();
        renderSettings();
        toastr.success(tr('studio.toast.draftGenerated'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-validate', async () => {
        const result = validateCharacterDraft($('#amy-studio-draft').val());
        if (!result.valid) throw new Error(translateStudioValidationErrors(result.errors).join('\n'));
        settings().draft = JSON.stringify(result.draft, null, 2);
        persist();
        renderSettings();
        toastr.success(tr('studio.toast.draftValid', { count: result.draft.lorebook.entries.length }), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-import', importDraft);
    bindAction('#amy-studio-asset-generate', () => generateAsset());
    bindAction('#amy-studio-portrait-set', generateAndSetPortrait);
    bindAction('#amy-studio-memory-extract', extractMemories);
    bindAction('#amy-studio-scene-close', closeScene);
    bindAction('#amy-studio-memory-save', savePendingMemories);
    bindAction('#amy-studio-checkpoint', createCheckpoint);
    bindAction('#amy-studio-plan-generate', generateStoryPlanDraft);
    bindAction('#amy-studio-plan-save', saveReviewedStoryPlan);
    bindAction('#amy-studio-plan-activate', activateStoryPlan);
    bindAction('#amy-studio-plan-deactivate', deactivateStoryPlan);
    writingController = bindWritingControl({
        getChatState: chatState,
        getSettings: settings,
        getPlan: () => chatState().storyPlan,
        getSelectedProgress: selectedStoryPlanProgress,
        getChatId: () => String(getCurrentChatId() ?? ''),
        isCheckpoint: () => Boolean(chat_metadata.main_chat),
        getLatestAssistantText: () => [...getContext().chat].reverse()
            .find(message => !message.is_system && !message.is_user && typeof message.mes === 'string' && message.mes.trim())
            ?.mes ?? '',
        getCompilationContext: state => currentSceneCompilationInputs(state),
        runCodexText: codexText,
        recordAudit: (tool, summary) => {
            appendAudit(settings(), { tool, status: 'approved', summary });
            persist();
            renderAudit();
        },
        persistChat,
        persistSettings: persist,
        syncWritingContext: (content, source) => syncActiveContext(content, source, WRITING_CONTEXT_ENTRY_COMMENT),
        assertSource: assertMemorySource,
        renderParent: renderSettings,
    });
    projectController = bindStoryProject({
        getSettings: settings,
        getChatState: chatState,
        getChatId: () => String(getCurrentChatId() ?? ''),
        getCurrentCharacter: () => characters[this_chid] ?? null,
        getCharacters: () => characters,
        getGroups: () => groups,
        getCurrentStory: () => ({
            title: String(getCurrentChatId() ?? ''),
            character: characters[this_chid]?.name ?? '',
            ownerId: currentStoryReference().ownerId,
        }),
        getWorldNames: () => getContext().getWorldInfoNames(),
        getWorldInfo: loadWorldInfo,
        refreshCharacters: getCharacters,
        refreshWorlds: updateWorldInfoList,
        getRequestHeaders,
        getPlan: () => chatState().storyPlan,
        setPlanDraft: plan => { chatState().pendingPlan = JSON.stringify(plan, null, 2); },
        persistSettings: persist,
        persistChat,
        prepareCurrentChat: prepareStoryProjectChat,
        getGenerationReadiness: currentGenerationReadiness,
        setExpectedSceneWords: async words => {
            chatState().expectedSceneWords = words;
            await persistChat({ immediate: true });
        },
        isWritingContextFresh: currentWritingContextIsFresh,
        applyRecommendedGenerationCapacity,
        getCurrentSceneRequest: currentSceneWritingRequest,
        stageCurrentSceneRequest: stageCurrentSceneWritingRequest,
        getCurrentModel: currentModel,
        recordAudit: (tool, summary) => {
            appendAudit(settings(), { tool, status: 'approved', summary });
            persist();
            renderAudit();
        },
        bindAction,
        renderParent: renderSettings,
    });
    $('#openai_max_context, #openai_max_tokens, #world_info_budget, #world_info_budget_cap')
        .on('input.amy-studio-readiness change.amy-studio-readiness', () => projectController?.render());
    renderSettings();
}

function markCurrentLedgerStale(reason) {
    const state = chatState();
    if (!state.narrativeLedger.acceptedMetrics.words && !state.narrativeLedger.sceneIndex) return;
    state.narrativeLedger = markNarrativeLedgerStale(state.narrativeLedger, reason);
    void persistChat();
    writingController?.render();
}

export function initCreatorStudio() {
    const state = settings();
    if (state.enableSafeTools && !oai_settings.function_calling) {
        oai_settings.function_calling = true;
        $('#openai_function_calling').prop('checked', true);
        persist();
    }
    createPanel();
    registerSafeTools();
    eventSource.on(event_types.MESSAGE_RECEIVED, maybePrepareAutomaticMemory);
    eventSource.on(event_types.CHAT_CHANGED, renderSettings);
    eventSource.on(event_types.MESSAGE_EDITED, () => markCurrentLedgerStale(tr('studio.writing.ledgerStaleEdited')));
    eventSource.on(event_types.MESSAGE_DELETED, () => markCurrentLedgerStale(tr('studio.writing.ledgerStaleDeleted')));
    eventSource.on(event_types.MESSAGE_SWIPED, () => markCurrentLedgerStale(tr('studio.writing.ledgerStaleSwiped')));
}
