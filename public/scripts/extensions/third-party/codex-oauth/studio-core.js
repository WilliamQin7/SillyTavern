export const STUDIO_SCHEMA = 'amy_creator_studio_v1';
export const STORY_STATE_SCHEMA = 'amy_story_state_v1';
export const STORY_STATE_ENTRY_COMMENT = 'Amy Story State v1';
export const STORY_PLAN_SCHEMA = 'amy_story_plan_v1';
export const STORY_PLAN_ENTRY_COMMENT = 'Amy Active Story Plan v1';
export const SAFE_TOOL_NAMES = Object.freeze(['AmyStudioRemember', 'AmyStudioGenerateImage']);

const REQUIRED_CARD_FIELDS = Object.freeze([
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions',
]);

const DEFAULT_STUDIO_SETTINGS = Object.freeze({
    idea: '',
    draft: '',
    visualAnchor: '',
    visualStyle: 'polished character illustration, coherent anatomy, consistent facial features and costume design',
    assetType: 'portrait',
    assetDetail: '',
    expressionLabel: 'joy',
    memoryWindow: 24,
    autoMemoryDraft: false,
    autoMemoryEvery: 12,
    enableSafeTools: false,
    safeToolNames: [...SAFE_TOOL_NAMES],
    audit: [],
});

function string(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function boundedString(value, limit = 500) {
    return string(value).slice(0, limit);
}

function stringArray(value) {
    return Array.isArray(value) ? value.map(string).filter(Boolean) : [];
}

function optionalNumber(value) {
    if (value === null || value === undefined || value === '') return undefined;
    return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function stringRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
        .map(([key, item]) => [string(key), string(item)])
        .filter(([key, item]) => key && item));
}

function normalizeAsset(asset) {
    return {
        type: string(asset?.type),
        uri: string(asset?.uri),
        name: string(asset?.name),
        ext: string(asset?.ext).replace(/^\./, '').toLowerCase() || 'unknown',
    };
}

export function normalizeStudioSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
        ...DEFAULT_STUDIO_SETTINGS,
        idea: typeof input.idea === 'string' ? input.idea : '',
        draft: typeof input.draft === 'string' ? input.draft : '',
        visualAnchor: typeof input.visualAnchor === 'string' ? input.visualAnchor : '',
        visualStyle: typeof input.visualStyle === 'string' ? input.visualStyle : DEFAULT_STUDIO_SETTINGS.visualStyle,
        assetType: ['portrait', 'expression', 'background'].includes(input.assetType) ? input.assetType : 'portrait',
        assetDetail: typeof input.assetDetail === 'string' ? input.assetDetail : '',
        expressionLabel: typeof input.expressionLabel === 'string' && /^[a-z]+$/i.test(input.expressionLabel)
            ? input.expressionLabel.toLowerCase()
            : DEFAULT_STUDIO_SETTINGS.expressionLabel,
        memoryWindow: Math.min(100, Math.max(4, Number(input.memoryWindow) || DEFAULT_STUDIO_SETTINGS.memoryWindow)),
        autoMemoryDraft: input.autoMemoryDraft === true,
        autoMemoryEvery: Math.min(100, Math.max(4, Number(input.autoMemoryEvery) || DEFAULT_STUDIO_SETTINGS.autoMemoryEvery)),
        enableSafeTools: input.enableSafeTools === true,
        safeToolNames: Array.isArray(input.safeToolNames)
            ? input.safeToolNames.filter(name => SAFE_TOOL_NAMES.includes(name))
            : [...SAFE_TOOL_NAMES],
        audit: Array.isArray(input.audit) ? input.audit.slice(-100) : [],
    };
}

export function extractJsonObject(text) {
    const raw = String(text ?? '').trim();
    const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
        return JSON.parse(unfenced);
    } catch {
        const start = unfenced.indexOf('{');
        const end = unfenced.lastIndexOf('}');
        if (start < 0 || end <= start) throw new Error('The model response did not contain a JSON object.');
        return JSON.parse(unfenced.slice(start, end + 1));
    }
}

function normalizeLoreEntry(entry, index) {
    return {
        keys: stringArray(entry?.keys),
        content: string(entry?.content),
        comment: string(entry?.comment) || `Lore ${index + 1}`,
        constant: entry?.constant === true,
        selective: entry?.selective === true,
        secondary_keys: stringArray(entry?.secondary_keys),
        order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : 100 + index,
    };
}

export function validateStudioDraft(value) {
    const draft = typeof value === 'string' ? extractJsonObject(value) : structuredClone(value);
    const errors = [];
    if (draft?.schema !== STUDIO_SCHEMA) errors.push(`schema must be ${STUDIO_SCHEMA}`);
    const inputSpec = draft?.card?.spec;
    const inputVersion = draft?.card?.spec_version;
    if (!['chara_card_v2', 'chara_card_v3'].includes(inputSpec)) {
        errors.push('card.spec must be chara_card_v2 or chara_card_v3');
    }
    if ((inputSpec === 'chara_card_v2' && inputVersion !== '2.0')
        || (inputSpec === 'chara_card_v3' && inputVersion !== '3.0')) {
        errors.push('card.spec_version must match card.spec');
    }
    const data = draft?.card?.data;
    if (!data || typeof data !== 'object') errors.push('card.data is required');
    for (const field of REQUIRED_CARD_FIELDS) {
        if (typeof data?.[field] !== 'string') errors.push(`card.data.${field} must be a string`);
    }
    if (!string(data?.name)) errors.push('card.data.name is required');
    if (!string(data?.first_mes)) errors.push('card.data.first_mes is required');
    if (data?.alternate_greetings !== undefined && !Array.isArray(data.alternate_greetings)) {
        errors.push('card.data.alternate_greetings must be an array');
    }
    if (data?.tags !== undefined && !Array.isArray(data.tags)) errors.push('card.data.tags must be an array');
    if (inputSpec === 'chara_card_v3' && !Array.isArray(data?.group_only_greetings)) {
        errors.push('card.data.group_only_greetings must be an array');
    }
    if (data?.source !== undefined && !Array.isArray(data.source)) errors.push('card.data.source must be an array');
    if (data?.assets !== undefined && !Array.isArray(data.assets)) errors.push('card.data.assets must be an array');
    if (Array.isArray(data?.assets)) {
        data.assets.forEach((asset, index) => {
            if (!asset || typeof asset !== 'object' || !string(asset.type) || !string(asset.uri) || !string(asset.name) || !string(asset.ext)) {
                errors.push(`card.data.assets[${index}] requires type, uri, name, and ext`);
            }
        });
    }
    const entries = Array.isArray(draft?.lorebook?.entries)
        ? draft.lorebook.entries.map(normalizeLoreEntry)
        : [];
    entries.forEach((entry, index) => {
        if (!entry.content) errors.push(`lorebook.entries[${index}].content is required`);
        if (!entry.constant && entry.keys.length === 0) errors.push(`lorebook.entries[${index}] needs keys or constant=true`);
    });
    if (errors.length) return { valid: false, errors, draft: null };

    const normalizedLorebook = {
        name: string(draft?.lorebook?.name) || `${string(data.name)} Lore`,
        entries,
    };
    const characterBook = {
        name: normalizedLorebook.name,
        extensions: {},
        entries: entries.map((entry, index) => ({
            keys: entry.keys,
            content: entry.content,
            extensions: {},
            enabled: true,
            insertion_order: entry.order,
            use_regex: false,
            constant: entry.constant,
            name: entry.comment,
            id: index,
            comment: entry.comment,
            selective: entry.selective,
            secondary_keys: entry.secondary_keys,
            position: 'before_char',
        })),
    };
    const normalized = {
        schema: STUDIO_SCHEMA,
        card: {
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data: {
                ...Object.fromEntries(REQUIRED_CARD_FIELDS.map(field => [field, String(data[field] ?? '')])),
                alternate_greetings: stringArray(data.alternate_greetings),
                group_only_greetings: stringArray(data.group_only_greetings),
                tags: stringArray(data.tags),
                creator: string(data.creator) || 'Amy Creator Studio',
                character_version: string(data.character_version) || '1.0',
                extensions: data.extensions && typeof data.extensions === 'object' ? data.extensions : {},
                character_book: characterBook,
                ...(string(data.nickname) ? { nickname: string(data.nickname) } : {}),
                ...(Object.keys(stringRecord(data.creator_notes_multilingual)).length
                    ? { creator_notes_multilingual: stringRecord(data.creator_notes_multilingual) }
                    : {}),
                ...(stringArray(data.source).length ? { source: stringArray(data.source) } : {}),
                ...(Array.isArray(data.assets) ? { assets: data.assets.map(normalizeAsset) } : {}),
                ...(optionalNumber(data.creation_date) !== undefined ? { creation_date: optionalNumber(data.creation_date) } : {}),
                ...(optionalNumber(data.modification_date) !== undefined ? { modification_date: optionalNumber(data.modification_date) } : {}),
            },
        },
        lorebook: normalizedLorebook,
        visual: {
            anchor: string(draft?.visual?.anchor),
            style: string(draft?.visual?.style),
        },
    };
    return { valid: true, errors: [], draft: normalized };
}

export function characterCreatePayload(draft, worldName = '') {
    const card = validateStudioDraft(draft).draft?.card;
    const data = card?.data;
    if (!card || !data) throw new Error('Character draft is invalid.');
    return {
        json_data: JSON.stringify(card),
        ch_name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        creator_notes: data.creator_notes,
        system_prompt: data.system_prompt,
        post_history_instructions: data.post_history_instructions,
        alternate_greetings: data.alternate_greetings,
        tags: data.tags,
        creator: data.creator,
        character_version: data.character_version,
        talkativeness: '0.5',
        fav: 'false',
        // Link through the standard extension without asking the create endpoint
        // to replace the already-normalized V3 character_book from json_data.
        world: '',
        depth_prompt_prompt: '',
        depth_prompt_depth: '4',
        depth_prompt_role: 'system',
        extensions: JSON.stringify({ ...data.extensions, ...(worldName ? { world: worldName } : {}) }),
    };
}

export function buildAssetPrompt({ type, characterName, visualAnchor, visualStyle, detail }) {
    const subject = string(visualAnchor) || `${string(characterName) || 'the current character'}, preserve their established appearance`;
    const style = string(visualStyle) || DEFAULT_STUDIO_SETTINGS.visualStyle;
    const extra = string(detail);
    const instructions = {
        portrait: 'waist-up character portrait, centered composition, readable silhouette, simple unobtrusive background',
        expression: 'character expression sprite, shoulders-up, transparent or plain background, preserve clothing and facial proportions',
        background: 'environment background only, no people or characters, cinematic establishing shot',
    };
    return [instructions[type] ?? instructions.portrait, `Visual identity: ${subject}.`, `Style bible: ${style}.`, extra].filter(Boolean).join(' ');
}

export function normalizeMemoryDraft(value) {
    const draft = typeof value === 'string' ? extractJsonObject(value) : value;
    const memories = Array.isArray(draft?.memories) ? draft.memories : [];
    return memories.map((memory, index) => ({
        title: string(memory?.title) || `Memory ${index + 1}`,
        content: string(memory?.content),
        keys: stringArray(memory?.keys),
        kind: ['fact', 'event', 'relationship', 'goal', 'state'].includes(memory?.kind) ? memory.kind : 'event',
        importance: Math.min(5, Math.max(1, Number(memory?.importance) || 3)),
    })).filter(memory => memory.content && memory.keys.length);
}

export function normalizeMemorySource(value) {
    const source = value && typeof value === 'object' ? value : {};
    const number = input => input === null || input === undefined || input === ''
        ? null
        : (Number.isInteger(Number(input)) ? Number(input) : null);
    return {
        chatId: string(source.chatId),
        startMessageId: number(source.startMessageId),
        endMessageId: number(source.endMessageId),
        messageCount: Math.max(0, number(source.messageCount) ?? 0),
    };
}

export function normalizeMemoryEnvelope(value, fallbackSource = {}) {
    const draft = typeof value === 'string' ? extractJsonObject(value) : value;
    return {
        source: normalizeMemorySource(draft?.source ?? fallbackSource),
        memories: normalizeMemoryDraft(draft),
        storyState: normalizeStoryState(draft?.storyState ?? draft?.story_state),
    };
}

export function normalizeStoryState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const scene = value.scene && typeof value.scene === 'object' ? value.scene : {};
    const characters = (Array.isArray(value.characters) ? value.characters : []).map(character => ({
        name: boundedString(character?.name, 120),
        status: boundedString(character?.status),
        goal: boundedString(character?.goal),
        location: boundedString(character?.location, 200),
        inventory: stringArray(character?.inventory).map(item => item.slice(0, 200)).slice(0, 50),
        knowledge: stringArray(character?.knowledge).map(item => item.slice(0, 500)).slice(0, 50),
    })).filter(character => character.name).slice(0, 50);
    const relationships = (Array.isArray(value.relationships) ? value.relationships : []).map(relationship => ({
        from: boundedString(relationship?.from, 120),
        to: boundedString(relationship?.to, 120),
        state: boundedString(relationship?.state),
        lastChange: boundedString(relationship?.lastChange ?? relationship?.last_change),
    })).filter(relationship => relationship.from && relationship.to).slice(0, 100);
    const openThreads = (Array.isArray(value.openThreads ?? value.open_threads) ? value.openThreads ?? value.open_threads : []).map(thread => ({
        title: boundedString(thread?.title, 200),
        detail: boundedString(thread?.detail, 1000),
        status: ['open', 'resolved'].includes(thread?.status) ? thread.status : 'open',
        keys: stringArray(thread?.keys).map(item => item.slice(0, 120)).slice(0, 20),
    })).filter(thread => thread.title).slice(0, 100);
    const canon = (Array.isArray(value.canon) ? value.canon : []).map(fact => ({
        content: boundedString(fact?.content, 1000),
        keys: stringArray(fact?.keys).map(item => item.slice(0, 120)).slice(0, 20),
    })).filter(fact => fact.content).slice(0, 100);
    const authorPlans = (Array.isArray(value.authorPlans ?? value.author_plans) ? value.authorPlans ?? value.author_plans : []).map(plan => ({
        content: boundedString(plan?.content, 1000),
        status: ['planned', 'discarded'].includes(plan?.status) ? plan.status : 'planned',
    })).filter(plan => plan.content).slice(0, 50);
    return {
        schema: STORY_STATE_SCHEMA,
        scene: {
            summary: boundedString(scene.summary, 2000),
            time: boundedString(scene.time, 200),
            location: boundedString(scene.location, 200),
            presentCharacters: stringArray(scene.presentCharacters ?? scene.present_characters)
                .map(item => item.slice(0, 120)).slice(0, 50),
        },
        characters,
        relationships,
        openThreads,
        canon,
        authorPlans,
    };
}

export function storyStateToLoreContent(value) {
    const state = normalizeStoryState(value);
    if (!state) return '';
    const sections = [
        state.scene.summary && `Latest scene: ${state.scene.summary}`,
        [state.scene.time && `Time: ${state.scene.time}`, state.scene.location && `Location: ${state.scene.location}`].filter(Boolean).join(' · '),
        state.scene.presentCharacters.length && `Present: ${state.scene.presentCharacters.join(', ')}`,
        ...state.characters.map(character => `${character.name}: ${[
            character.status,
            character.goal && `Goal: ${character.goal}`,
            character.location && `Location: ${character.location}`,
            character.inventory.length && `Inventory: ${character.inventory.join(', ')}`,
            character.knowledge.length && `Knows: ${character.knowledge.join('; ')}`,
        ].filter(Boolean).join(' · ')}`),
        ...state.relationships.map(relationship => `${relationship.from} → ${relationship.to}: ${[relationship.state, relationship.lastChange].filter(Boolean).join(' · ')}`),
        ...state.openThreads.filter(thread => thread.status === 'open').map(thread => `Open thread — ${thread.title}: ${thread.detail}`),
        ...state.canon.map(fact => `Canon: ${fact.content}`),
    ];
    return sections.filter(Boolean).join('\n');
}

function uniquePlanId(value, fallback, used) {
    const base = boundedString(value, 80)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || fallback;
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
    used.add(candidate);
    return candidate;
}

function planStrings(value, limit = 20) {
    const items = Array.isArray(value) ? stringArray(value) : [string(value)].filter(Boolean);
    return items.map(item => item.slice(0, 500)).slice(0, limit);
}

export function normalizeStoryPlan(value) {
    let input;
    try {
        input = typeof value === 'string' ? extractJsonObject(value) : value;
    } catch {
        return null;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const chapterIds = new Set();
    const chapters = (Array.isArray(input.chapters) ? input.chapters : [])
        .filter(chapter => chapter && typeof chapter === 'object' && !Array.isArray(chapter))
        .slice(0, 100).map((chapter, chapterIndex) => {
            const chapterId = uniquePlanId(chapter?.id, `chapter-${chapterIndex + 1}`, chapterIds);
            const sceneIds = new Set();
            const scenes = (Array.isArray(chapter?.scenes) ? chapter.scenes : [])
                .filter(scene => scene && typeof scene === 'object' && !Array.isArray(scene))
                .slice(0, 100).map((scene, sceneIndex) => ({
                    id: uniquePlanId(scene?.id, `${chapterId}-scene-${sceneIndex + 1}`, sceneIds),
                    title: boundedString(scene?.title, 200) || `Scene ${sceneIndex + 1}`,
                    summary: boundedString(scene?.summary, 2000),
                    goals: planStrings(scene?.goals),
                    constraints: planStrings(scene?.constraints),
                }));
            return {
                id: chapterId,
                title: boundedString(chapter?.title, 200) || `Chapter ${chapterIndex + 1}`,
                summary: boundedString(chapter?.summary, 3000),
                goals: planStrings(chapter?.goals, 50),
                constraints: planStrings(chapter?.constraints, 50),
                scenes,
            };
        });
    if (!chapters.length) return null;
    return {
        schema: STORY_PLAN_SCHEMA,
        title: boundedString(input.title, 300) || 'Untitled story',
        premise: boundedString(input.premise, 4000),
        styleGuide: planStrings(input.styleGuide ?? input.style_guide, 50),
        chapters,
    };
}

export function normalizeStoryPlanProgress(value, planValue) {
    const plan = normalizeStoryPlan(planValue);
    if (!plan) return { active: false, chapterId: '', sceneId: '' };
    const input = value && typeof value === 'object' ? value : {};
    const chapter = plan.chapters.find(item => item.id === string(input.chapterId)) ?? plan.chapters[0];
    const scene = chapter.scenes.find(item => item.id === string(input.sceneId)) ?? chapter.scenes[0] ?? null;
    return {
        active: input.active === true,
        chapterId: chapter.id,
        sceneId: scene?.id ?? '',
    };
}

export function activeStoryPlanContext(planValue, progressValue) {
    const plan = normalizeStoryPlan(planValue);
    if (!plan) return null;
    const progress = normalizeStoryPlanProgress(progressValue, plan);
    const chapter = plan.chapters.find(item => item.id === progress.chapterId);
    if (!chapter) return null;
    const scene = chapter.scenes.find(item => item.id === progress.sceneId) ?? null;
    return { plan, progress, chapter, scene };
}

function storyPlanFocusList(label, values) {
    const items = planStrings(values, 6).map(item => item.slice(0, 240));
    return items.length ? `${label}: ${items.join('; ')}` : '';
}

export function storyPlanToLoreContent(planValue, progressValue) {
    const context = activeStoryPlanContext(planValue, progressValue);
    if (!context?.progress.active) return '';
    const { plan, chapter, scene } = context;
    const sections = [
        'Active story plan (author guidance; not established canon):',
        `Story: ${plan.title}`,
        storyPlanFocusList('Style guidance', plan.styleGuide),
        `Current chapter — ${chapter.title}`,
        chapter.summary && `Chapter intent: ${chapter.summary.slice(0, 1500)}`,
        storyPlanFocusList('Chapter goals', chapter.goals),
        storyPlanFocusList('Chapter constraints', chapter.constraints),
        scene && `Current scene — ${scene.title}`,
        scene?.summary && `Scene intent: ${scene.summary.slice(0, 1200)}`,
        storyPlanFocusList('Scene goals', scene?.goals),
        storyPlanFocusList('Scene constraints', scene?.constraints),
        'Treat planned events as intentions, never as events that already occurred. Follow reviewed canon and current story state when they conflict.',
    ];
    return sections.filter(Boolean).join('\n');
}

export function memorySourceMatchesChat(source, chatId) {
    const expected = normalizeMemorySource(source).chatId;
    return Boolean(expected && expected === string(chatId));
}

function memoryContentKey(value) {
    const content = typeof value === 'string' ? value : value?.content;
    return String(content ?? '')
        .replace(/^\[(?:fact|event|relationship|goal|state); importance [1-5]\/5\]\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export function partitionNewMemories(memories, entries = []) {
    const seen = new Set((Array.isArray(entries) ? entries : []).map(memoryContentKey).filter(Boolean));
    const fresh = [];
    const duplicates = [];
    for (const memory of memories) {
        const key = memoryContentKey(memory);
        if (!key || seen.has(key)) {
            duplicates.push(memory);
            continue;
        }
        seen.add(key);
        fresh.push(memory);
    }
    return { fresh, duplicates };
}

export function filterSafeTools(tools, enabled, allowlist = SAFE_TOOL_NAMES) {
    if (!enabled || !Array.isArray(tools)) return [];
    const allowed = new Set(allowlist.filter(name => SAFE_TOOL_NAMES.includes(name)));
    return tools.filter(tool => allowed.has(tool?.function?.name));
}

export function appendAudit(settings, entry) {
    settings.audit = [...(Array.isArray(settings.audit) ? settings.audit : []), {
        time: new Date().toISOString(),
        ...entry,
    }].slice(-100);
}

export function creatorPrompt(idea) {
    return `Create one original SillyTavern character and a compact linked lorebook from this request:\n${String(idea)}\n\nReturn JSON only. Use this exact top-level shape:\n{"schema":"${STUDIO_SCHEMA}","card":{"spec":"chara_card_v3","spec_version":"3.0","data":{"name":"","description":"","personality":"","scenario":"","first_mes":"","mes_example":"","creator_notes":"","system_prompt":"","post_history_instructions":"","alternate_greetings":[],"group_only_greetings":[],"tags":[],"creator":"Amy Creator Studio","character_version":"1.0","extensions":{}}},"lorebook":{"name":"","entries":[{"keys":[],"content":"","comment":"","constant":false,"selective":false,"secondary_keys":[],"order":100}]},"visual":{"anchor":"stable physical identity, clothing and palette","style":"consistent art direction"}}\nMake every lore entry standalone and concise. Use {{char}} and {{user}} macros where appropriate. Do not include markdown fences.`;
}

export function memoryPrompt(messages) {
    return `Extract durable roleplay memories from the transcript below. Keep atomic facts separate from events and changing state. Do not invent information. Return JSON only as {"memories":[{"title":"","content":"standalone third-person memory","keys":["trigger"],"kind":"fact|event|relationship|goal|state","importance":1}]} with at most 8 items. Omit trivial dialogue and transient wording.\n\nTRANSCRIPT\n${String(messages)}`;
}

export function storyPlanPrompt(outline) {
    return `Convert the supplied novel outline into a compact, reviewable writing plan. Return JSON only as {"schema":"${STORY_PLAN_SCHEMA}","title":"","premise":"","styleGuide":[],"chapters":[{"id":"chapter-1","title":"","summary":"","goals":[],"constraints":[],"scenes":[{"id":"chapter-1-scene-1","title":"","summary":"","goals":[],"constraints":[]}]}]}. Preserve the author's intended chapter order and meaning. Do not invent new plot turns, resolutions, facts, or scenes. Use stable lowercase ASCII IDs. Put events that must happen in goals and events that must not happen yet in constraints. Empty scenes are allowed when the outline only specifies chapter-level direction. Do not include markdown fences.\n\nOUTLINE\n${String(outline)}`;
}

export function sceneMemoryPrompt(messages, currentStoryState = null) {
    const current = normalizeStoryState(currentStoryState);
    return `Close the completed story scene in the transcript below. Return JSON only as {"memories":[{"title":"","content":"standalone third-person memory","keys":["trigger"],"kind":"fact|event|relationship|goal|state","importance":1}],"storyState":{"schema":"${STORY_STATE_SCHEMA}","scene":{"summary":"","time":"","location":"","presentCharacters":[]},"characters":[{"name":"","status":"","goal":"","location":"","inventory":[],"knowledge":[]}],"relationships":[{"from":"","to":"","state":"","lastChange":""}],"openThreads":[{"title":"","detail":"","status":"open|resolved","keys":[]}],"canon":[{"content":"","keys":[]}],"authorPlans":[]}}. The first memory must be a concise chronological scene summary with kind=event and importance=5. Add only durable changes to character state, directional relationships, knowledge, promises, goals, inventory, location, and unresolved story threads. Keep every additional memory atomic and standalone. storyState must be the complete current snapshot: retain still-valid items from the previous reviewed state, apply only changes supported by the transcript, and keep it compact. Record only events that occurred in the transcript; never turn speculation or future plot plans into facts. Never create authorPlans from dialogue or narration; preserve existing authorPlans exactly unless the user edited them in the reviewed draft. Use at most 12 memories and omit unchanged details.\n\nPREVIOUS REVIEWED STORY STATE\n${current ? JSON.stringify(current) : 'None'}\n\nTRANSCRIPT\n${String(messages)}`;
}
