export const STUDIO_SCHEMA = 'amy_creator_studio_v1';
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

function stringArray(value) {
    return Array.isArray(value) ? value.map(string).filter(Boolean) : [];
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
    if (draft?.card?.spec !== 'chara_card_v2') errors.push('card.spec must be chara_card_v2');
    if (draft?.card?.spec_version !== '2.0') errors.push('card.spec_version must be 2.0');
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
    const entries = Array.isArray(draft?.lorebook?.entries)
        ? draft.lorebook.entries.map(normalizeLoreEntry)
        : [];
    entries.forEach((entry, index) => {
        if (!entry.content) errors.push(`lorebook.entries[${index}].content is required`);
        if (!entry.constant && entry.keys.length === 0) errors.push(`lorebook.entries[${index}] needs keys or constant=true`);
    });
    if (errors.length) return { valid: false, errors, draft: null };

    const normalized = {
        schema: STUDIO_SCHEMA,
        card: {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                ...Object.fromEntries(REQUIRED_CARD_FIELDS.map(field => [field, String(data[field] ?? '')])),
                alternate_greetings: stringArray(data.alternate_greetings),
                tags: stringArray(data.tags),
                creator: string(data.creator) || 'Amy Creator Studio',
                character_version: string(data.character_version) || '1.0',
                extensions: data.extensions && typeof data.extensions === 'object' ? data.extensions : {},
            },
        },
        lorebook: {
            name: string(draft?.lorebook?.name) || `${string(data.name)} Lore`,
            entries,
        },
        visual: {
            anchor: string(draft?.visual?.anchor),
            style: string(draft?.visual?.style),
        },
    };
    return { valid: true, errors: [], draft: normalized };
}

export function characterCreatePayload(draft, worldName = '') {
    const data = validateStudioDraft(draft).draft?.card?.data;
    if (!data) throw new Error('Character draft is invalid.');
    return {
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
        world: worldName,
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
    };
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
    return `Create one original SillyTavern character and a compact linked lorebook from this request:\n${String(idea)}\n\nReturn JSON only. Use this exact top-level shape:\n{"schema":"${STUDIO_SCHEMA}","card":{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"","description":"","personality":"","scenario":"","first_mes":"","mes_example":"","creator_notes":"","system_prompt":"","post_history_instructions":"","alternate_greetings":[],"tags":[],"creator":"Amy Creator Studio","character_version":"1.0","extensions":{}}},"lorebook":{"name":"","entries":[{"keys":[],"content":"","comment":"","constant":false,"selective":false,"secondary_keys":[],"order":100}]},"visual":{"anchor":"stable physical identity, clothing and palette","style":"consistent art direction"}}\nMake every lore entry standalone and concise. Use {{char}} and {{user}} macros where appropriate. Do not include markdown fences.`;
}

export function memoryPrompt(messages) {
    return `Extract durable roleplay memories from the transcript below. Keep atomic facts separate from events and changing state. Do not invent information. Return JSON only as {"memories":[{"title":"","content":"standalone third-person memory","keys":["trigger"],"kind":"fact|event|relationship|goal|state","importance":1}]} with at most 8 items. Omit trivial dialogue and transient wording.\n\nTRANSCRIPT\n${String(messages)}`;
}

export function sceneMemoryPrompt(messages) {
    return `Close the completed story scene in the transcript below. Return JSON only as {"memories":[{"title":"","content":"standalone third-person memory","keys":["trigger"],"kind":"fact|event|relationship|goal|state","importance":1}]}. The first item must be a concise chronological scene summary with kind=event and importance=5. Add only durable changes to character state, directional relationships, knowledge, promises, goals, inventory, location, and unresolved story threads. Keep every additional item atomic and standalone. Record only events that occurred in the transcript; never turn speculation or future plot plans into facts. Use at most 12 items and omit unchanged details.\n\nTRANSCRIPT\n${String(messages)}`;
}
