import { characters, chat_metadata, eventSource, event_types, getCharacters, getCurrentChatId, getRequestHeaders, saveMetadata, saveSettingsDebounced, this_chid } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { Popup } from '../../../popup.js';
import { getContext } from '../../../st-context.js';
import { escapeHtml } from '../../../utils.js';
import { createWorldInfoEntry, loadWorldInfo, saveWorldInfo, updateWorldInfoList } from '../../../world-info.js';
import { tr, translateStudioValidationErrors } from './i18n.js';
import {
    appendAudit,
    buildAssetPrompt,
    characterCreatePayload,
    creatorPrompt,
    memorySourceMatchesChat,
    memoryPrompt,
    normalizeMemoryEnvelope,
    normalizeMemoryDraft,
    normalizeStoryState,
    normalizeStudioSettings,
    partitionNewMemories,
    sceneMemoryPrompt,
    STORY_STATE_ENTRY_COMMENT,
    storyStateToLoreContent,
    validateStudioDraft,
} from './studio-core.js';

const SETTINGS_KEY = 'codex_oauth_studio';
const CHAT_STATE_KEY = 'amy_creator_studio';
const PROVIDER_ID = 'codex-oauth';
let chatSaveTimer = null;

function settings() {
    extension_settings[SETTINGS_KEY] = normalizeStudioSettings(extension_settings[SETTINGS_KEY]);
    return extension_settings[SETTINGS_KEY];
}

function persist() {
    saveSettingsDebounced();
}

function chatState() {
    const input = chat_metadata[CHAT_STATE_KEY];
    const state = input && typeof input === 'object' ? input : {};
    chat_metadata[CHAT_STATE_KEY] = {
        ...state,
        pendingMemories: typeof state.pendingMemories === 'string' ? state.pendingMemories : '',
        lastMemoryMessageCount: Math.max(0, Number(state.lastMemoryMessageCount) || 0),
        storyState: normalizeStoryState(state.storyState),
    };
    return chat_metadata[CHAT_STATE_KEY];
}

function persistChat({ immediate = false } = {}) {
    const chatId = String(getCurrentChatId() ?? '');
    if (!chatId) return Promise.resolve();
    if (chatSaveTimer) clearTimeout(chatSaveTimer);
    const save = async () => {
        chatSaveTimer = null;
        if (String(getCurrentChatId() ?? '') !== chatId) return;
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

async function prepareMemoryDraft(prompt, toastKey, { requireStoryState = false } = {}) {
    const { text, source } = transcriptWindow(settings().memoryWindow);
    if (!source.chatId || !text) throw new Error(tr('studio.error.openChatMemory'));
    const state = chatState();
    const raw = await codexText(prompt(text, state.storyState));
    assertMemorySource(source);
    const draft = normalizeMemoryEnvelope(raw, source);
    if (!draft.memories.length && !draft.storyState) throw new Error(tr('studio.error.noMemories'));
    if (requireStoryState && !storyStateToLoreContent(draft.storyState)) throw new Error(tr('studio.error.noStoryState'));
    state.pendingMemories = JSON.stringify({
        source,
        memories: draft.memories,
        ...(draft.storyState ? { storyState: draft.storyState } : {}),
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

async function saveMemoryEntries(memories, { confirm = true, source = null, storyState = null, auditSource = 'memory_review' } = {}) {
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
    await saveMemoryEntries(draft.memories, { source: draft.source, storyState: draft.storyState });
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
    renderAudit();
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
                <div class="amy-studio-tabs flex-container">
                    <button class="menu_button amy-studio-tab" data-tab="character" data-i18n="amyCreatorStudio.studio.tab.character">Character</button>
                    <button class="menu_button amy-studio-tab" data-tab="assets" data-i18n="amyCreatorStudio.studio.tab.assets">Assets</button>
                    <button class="menu_button amy-studio-tab" data-tab="memory" data-i18n="amyCreatorStudio.studio.tab.memory">Memory</button>
                    <button class="menu_button amy-studio-tab" data-tab="tools" data-i18n="amyCreatorStudio.studio.tab.tools">Safe tools</button>
                </div>
                <section data-amy-tab="character">
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

    $('.amy-studio-tab').on('click', function () {
        const tab = $(this).data('tab');
        $('[data-amy-tab]').addClass('displayNone');
        $(`[data-amy-tab="${tab}"]`).removeClass('displayNone');
        $('.amy-studio-tab').removeClass('selected');
        $(this).addClass('selected');
    });
    $('.amy-studio-tab[data-tab="character"]').addClass('selected');
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
        const result = validateStudioDraft(raw);
        if (!result.valid) throw new Error(tr('studio.error.generatedValidation', { errors: translateStudioValidationErrors(result.errors).join('\n') }));
        state.draft = JSON.stringify(result.draft, null, 2);
        state.visualAnchor = result.draft.visual.anchor;
        state.visualStyle = result.draft.visual.style || state.visualStyle;
        persist();
        renderSettings();
        toastr.success(tr('studio.toast.draftGenerated'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-validate', async () => {
        const result = validateStudioDraft($('#amy-studio-draft').val());
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
    renderSettings();
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
}
