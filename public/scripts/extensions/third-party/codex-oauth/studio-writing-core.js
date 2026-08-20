export const WRITING_PROFILE_SCHEMA = 'amy_writing_profile_v1';
export const NARRATIVE_LEDGER_SCHEMA = 'amy_narrative_ledger_v1';
export const WRITING_CRITIC_SCHEMA = 'amy_writing_critic_v1';
export const WRITING_CONTEXT_ENTRY_COMMENT = 'Amy Active Writing Context v1';

const RULE_KINDS = Object.freeze(['hard', 'soft']);
const PORTRAYAL_MODES = Object.freeze(['reference_only', 'when_triggered', 'always']);
const TARGET_METRICS = Object.freeze([
    'dialogue_word_share',
    'action_word_share',
    'interiority_word_share',
]);
const METRIC_FIELDS = Object.freeze({
    dialogue_word_share: 'dialogueWords',
    action_word_share: 'actionWords',
    interiority_word_share: 'interiorityWords',
});
const METRIC_LABELS = Object.freeze({
    dialogue_word_share: 'Dialogue',
    action_word_share: 'Action',
    interiority_word_share: 'Interiority',
});

function text(value, limit = 500) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function id(value) {
    const result = typeof value === 'string' ? value.trim() : '';
    return result.length <= 80 && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(result) ? result : '';
}

function exceedsTextLimit(value, limit) {
    return typeof value === 'string' && value.trim().length > limit;
}

function validateTextArray(value, label, itemLimit, countLimit, errors) {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
        errors.push(label + ' must be an array.');
        return;
    }
    if (value.length > countLimit) errors.push(label + ' must contain at most ' + countLimit + ' items.');
    value.slice(0, countLimit).forEach((item, index) => {
        if (typeof item !== 'string') errors.push(label + ' item ' + (index + 1) + ' must be a string.');
        else if (exceedsTextLimit(item, itemLimit)) errors.push(label + ' item ' + (index + 1) + ' exceeds ' + itemLimit + ' characters.');
    });
}

function number(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function boundedNumber(value, min, max, fallback = min) {
    return Math.min(max, Math.max(min, number(value, fallback)));
}

function texts(value, itemLimit = 500, countLimit = 20) {
    return (Array.isArray(value) ? value : [])
        .map(item => text(item, itemLimit))
        .filter(Boolean)
        .slice(0, countLimit);
}

function tags(value) {
    return texts(value, 80, 30).map(item => item.toLowerCase());
}

function parseObject(value) {
    if (typeof value === 'string') {
        const raw = value.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/i, '');
        return JSON.parse(raw);
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : null;
}

function duplicateIds(items) {
    const seen = new Set();
    const duplicates = new Set();
    for (const item of items) {
        const value = text(item?.id, 80);
        if (value && seen.has(value)) duplicates.add(value);
        seen.add(value);
    }
    return [...duplicates];
}

function normalizeRule(rule) {
    return {
        id: id(rule?.id),
        label: text(rule?.label, 160),
        instruction: text(rule?.instruction, 1000),
        kind: RULE_KINDS.includes(rule?.kind) ? rule.kind : 'soft',
        priority: boundedNumber(rule?.priority, 0, 100, 50),
        includeTags: tags(rule?.includeTags),
        excludeTags: tags(rule?.excludeTags),
        maxApplicationsPerScene: rule?.maxApplicationsPerScene === undefined
            || rule?.maxApplicationsPerScene === null
            || rule?.maxApplicationsPerScene === ''
            ? null
            : Math.round(boundedNumber(rule.maxApplicationsPerScene, 0, 100, 0)),
        cooldownScenes: Math.round(boundedNumber(rule?.cooldownScenes, 0, 100, 0)),
    };
}

function normalizeTarget(target) {
    const min = boundedNumber(target?.min, 0, 1, 0);
    const max = boundedNumber(target?.max, 0, 1, min);
    return {
        id: id(target?.id),
        metric: TARGET_METRICS.includes(target?.metric) ? target.metric : '',
        min,
        max,
    };
}

function normalizePortrayalPolicy(policy) {
    return {
        id: id(policy?.id),
        label: text(policy?.label, 160),
        mode: PORTRAYAL_MODES.includes(policy?.mode) ? policy.mode : 'reference_only',
        includeTags: tags(policy?.includeTags),
        maxMentionsPerScene: Math.round(boundedNumber(policy?.maxMentionsPerScene, 0, 20, 1)),
        cooldownScenes: Math.round(boundedNumber(policy?.cooldownScenes, 0, 100, 0)),
        matchTerms: texts(policy?.matchTerms, 120, 50),
    };
}

function normalizeExample(example) {
    return {
        id: id(example?.id),
        label: text(example?.label, 160),
        tags: tags(example?.tags),
        text: text(example?.text, 2000),
        notes: text(example?.notes, 500),
    };
}

function normalizeProfileObject(input) {
    const contract = input?.contract && typeof input.contract === 'object' ? input.contract : {};
    return {
        schema: WRITING_PROFILE_SCHEMA,
        id: id(input?.id),
        name: text(input?.name, 200),
        contract: {
            language: text(contract.language, 40),
            pov: text(contract.pov, 120),
            tense: text(contract.tense, 120),
            narrativeDistance: text(contract.narrativeDistance, 120),
            hardRules: texts(contract.hardRules, 500, 20),
        },
        rules: (Array.isArray(input?.rules) ? input.rules : []).slice(0, 100).map(normalizeRule),
        targets: (Array.isArray(input?.targets) ? input.targets : []).slice(0, 20).map(normalizeTarget),
        portrayalPolicies: (Array.isArray(input?.portrayalPolicies) ? input.portrayalPolicies : [])
            .slice(0, 50).map(normalizePortrayalPolicy),
        examples: (Array.isArray(input?.examples) ? input.examples : []).slice(0, 30).map(normalizeExample),
    };
}

export function validateWritingProfile(value) {
    let input;
    try {
        input = parseObject(value);
    } catch {
        return { valid: false, errors: ['Profile must be valid JSON.'], profile: null };
    }
    const errors = [];
    if (!input) errors.push('Profile must be an object.');
    if (input?.schema !== WRITING_PROFILE_SCHEMA) errors.push('Profile schema must be ' + WRITING_PROFILE_SCHEMA + '.');
    if (!id(input?.id)) errors.push('Profile id must use lowercase ASCII letters, numbers, hyphens, or underscores.');
    if (!text(input?.name, 200)) errors.push('Profile name is required.');
    if (exceedsTextLimit(input?.name, 200)) errors.push('Profile name exceeds 200 characters.');
    const contract = input?.contract && typeof input.contract === 'object' && !Array.isArray(input.contract) ? input.contract : {};
    for (const [field, limit] of [['language', 40], ['pov', 120], ['tense', 120], ['narrativeDistance', 120]]) {
        if (exceedsTextLimit(contract[field], limit)) errors.push('contract.' + field + ' exceeds ' + limit + ' characters.');
    }
    validateTextArray(contract.hardRules, 'contract.hardRules', 500, 20, errors);
    const groupLimits = { rules: 100, targets: 20, portrayalPolicies: 50, examples: 30 };
    for (const group of Object.keys(groupLimits)) {
        if (input?.[group] !== undefined && !Array.isArray(input[group])) errors.push(group + ' must be an array.');
        if (Array.isArray(input?.[group]) && input[group].length > groupLimits[group]) {
            errors.push(group + ' must contain at most ' + groupLimits[group] + ' items.');
        }
        for (const duplicate of duplicateIds(Array.isArray(input?.[group]) ? input[group] : [])) {
            errors.push(group + ' contains duplicate id: ' + duplicate + '.');
        }
    }
    for (const [index, rule] of (Array.isArray(input?.rules) ? input.rules : []).slice(0, 100).entries()) {
        if (!id(rule?.id)) errors.push('Rule ' + (index + 1) + ' has an invalid id.');
        if (!text(rule?.instruction, 1000)) errors.push('Rule ' + (index + 1) + ' requires an instruction.');
        if (exceedsTextLimit(rule?.label, 160)) errors.push('Rule ' + (index + 1) + ' label exceeds 160 characters.');
        if (exceedsTextLimit(rule?.instruction, 1000)) errors.push('Rule ' + (index + 1) + ' instruction exceeds 1000 characters.');
        validateTextArray(rule?.includeTags, 'Rule ' + (index + 1) + ' includeTags', 80, 30, errors);
        validateTextArray(rule?.excludeTags, 'Rule ' + (index + 1) + ' excludeTags', 80, 30, errors);
        if (rule?.kind !== undefined && !RULE_KINDS.includes(rule.kind)) errors.push('Rule ' + (index + 1) + ' has an unknown kind.');
        if (rule?.priority !== undefined && (number(rule.priority, -1) < 0 || number(rule.priority, 101) > 100)) {
            errors.push('Rule ' + (index + 1) + ' priority must be between 0 and 100.');
        }
    }
    for (const [index, target] of (Array.isArray(input?.targets) ? input.targets : []).slice(0, 20).entries()) {
        if (!id(target?.id)) errors.push('Target ' + (index + 1) + ' has an invalid id.');
        if (!TARGET_METRICS.includes(target?.metric)) errors.push('Target ' + (index + 1) + ' has an unknown metric.');
        if (number(target?.min, -1) < 0 || number(target?.max, 2) > 1 || number(target?.min, 1) > number(target?.max, 0)) {
            errors.push('Target ' + (index + 1) + ' must satisfy 0 <= min <= max <= 1.');
        }
    }
    for (const [index, policy] of (Array.isArray(input?.portrayalPolicies) ? input.portrayalPolicies : []).slice(0, 50).entries()) {
        if (!id(policy?.id)) errors.push('Portrayal policy ' + (index + 1) + ' has an invalid id.');
        if (exceedsTextLimit(policy?.label, 160)) errors.push('Portrayal policy ' + (index + 1) + ' label exceeds 160 characters.');
        validateTextArray(policy?.includeTags, 'Portrayal policy ' + (index + 1) + ' includeTags', 80, 30, errors);
        validateTextArray(policy?.matchTerms, 'Portrayal policy ' + (index + 1) + ' matchTerms', 120, 50, errors);
        if (policy?.mode !== undefined && !PORTRAYAL_MODES.includes(policy.mode)) {
            errors.push('Portrayal policy ' + (index + 1) + ' has an unknown mode.');
        }
    }
    for (const [index, example] of (Array.isArray(input?.examples) ? input.examples : []).slice(0, 30).entries()) {
        if (!id(example?.id)) errors.push('Example ' + (index + 1) + ' has an invalid id.');
        if (!text(example?.text, 2000)) errors.push('Example ' + (index + 1) + ' requires text.');
        if (exceedsTextLimit(example?.label, 160)) errors.push('Example ' + (index + 1) + ' label exceeds 160 characters.');
        if (exceedsTextLimit(example?.text, 2000)) errors.push('Example ' + (index + 1) + ' text exceeds 2000 characters.');
        if (exceedsTextLimit(example?.notes, 500)) errors.push('Example ' + (index + 1) + ' notes exceed 500 characters.');
        validateTextArray(example?.tags, 'Example ' + (index + 1) + ' tags', 80, 30, errors);
    }
    if (errors.length) return { valid: false, errors, profile: null };
    return { valid: true, errors: [], profile: normalizeProfileObject(input) };
}

export function normalizeWritingProfile(value) {
    return validateWritingProfile(value).profile;
}

export function createDefaultWritingProfile() {
    return normalizeProfileObject({
        schema: WRITING_PROFILE_SCHEMA,
        id: 'restrained-narrative',
        name: 'Restrained narrative',
        contract: {
            language: 'en',
            pov: 'Third-person limited',
            tense: 'Past tense',
            narrativeDistance: 'Close',
            hardRules: [
                'Do not state information the current point-of-view character cannot know.',
                'Do not treat later Story Plan events as facts that already occurred.',
            ],
        },
        rules: [
            {
                id: 'emotion-through-action',
                label: 'Emotion through action',
                instruction: 'Prefer action, pauses, and interaction with the setting to convey emotion; do not immediately explain the same emotion.',
                kind: 'soft',
                priority: 80,
                includeTags: ['dialogue', 'conflict', 'aftermath'],
                maxApplicationsPerScene: 3,
            },
            {
                id: 'causal-sensory-detail',
                label: 'Causal sensory detail',
                instruction: 'Choose sensory details that affect judgment or action; avoid stacking decorative imagery.',
                kind: 'soft',
                priority: 65,
            },
        ],
        targets: [{
            id: 'dialogue-share',
            metric: 'dialogue_word_share',
            min: 0.3,
            max: 0.5,
        }],
        portrayalPolicies: [{
            id: 'stable-appearance',
            label: 'Stable appearance',
            mode: 'reference_only',
            includeTags: ['first-observation', 'appearance-change', 'physical-consequence'],
            maxMentionsPerScene: 1,
            cooldownScenes: 3,
            matchTerms: [],
        }],
        examples: [],
    });
}

export function migrateLegacyStyleGuide(plan) {
    const styleGuide = texts(plan?.styleGuide, 500, 50);
    if (!styleGuide.length) return null;
    return normalizeProfileObject({
        schema: WRITING_PROFILE_SCHEMA,
        id: 'legacy-story-plan-style',
        name: 'Story Plan style migration draft',
        contract: { language: 'zh-CN', hardRules: [] },
        rules: styleGuide.map((instruction, index) => ({
            id: 'legacy-style-' + (index + 1),
            label: 'Legacy style ' + (index + 1),
            instruction,
            kind: 'soft',
            priority: 50,
        })),
        targets: [],
        portrayalPolicies: [],
        examples: [],
    });
}

export function normalizeWritingTemplates(value) {
    const result = [];
    for (const item of (Array.isArray(value) ? value : []).slice(0, 30)) {
        const profile = normalizeWritingProfile(item);
        if (profile && !result.some(existing => existing.id === profile.id)) result.push(profile);
    }
    return result;
}

export function parseOptionalPercentRange(minValue, maxValue) {
    const minText = String(minValue ?? '').trim();
    const maxText = String(maxValue ?? '').trim();
    if (!minText || !maxText) return null;
    const min = Number(minText);
    const max = Number(maxText);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 100 || min > max) return null;
    return [min / 100, max / 100];
}

function normalizeMetricRecord(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        words: Math.max(0, Math.round(number(input.words))),
        dialogueWords: Math.max(0, Math.round(number(input.dialogueWords))),
        actionWords: Math.max(0, Math.round(number(input.actionWords))),
        interiorityWords: Math.max(0, Math.round(number(input.interiorityWords))),
    };
}

function normalizeUsageRecord(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
        const keyId = id(key);
        if (!keyId || !item || typeof item !== 'object') continue;
        result[keyId] = {
            lastSceneIndex: Math.max(-1, Math.round(number(item.lastSceneIndex, -1))),
            countInCurrentScene: Math.max(0, Math.round(number(item.countInCurrentScene))),
            countInChapter: Math.max(0, Math.round(number(item.countInChapter))),
        };
    }
    return result;
}

function normalizeRecent(value) {
    return (Array.isArray(value) ? value : []).map(item => ({
        text: text(item?.text, 200),
        lastSceneIndex: Math.max(-1, Math.round(number(item?.lastSceneIndex, -1))),
    })).filter(item => item.text).slice(-30);
}

export function normalizeNarrativeLedger(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        schema: NARRATIVE_LEDGER_SCHEMA,
        sceneIndex: Math.max(0, Math.round(number(input.sceneIndex))),
        chapterId: id(input.chapterId),
        acceptedMetrics: normalizeMetricRecord(input.acceptedMetrics),
        factMentions: normalizeUsageRecord(input.factMentions),
        ruleApplications: normalizeUsageRecord(input.ruleApplications),
        recentMotifs: normalizeRecent(input.recentMotifs),
        recentPhrases: normalizeRecent(input.recentPhrases),
        stale: input.stale === true,
        staleReason: text(input.staleReason, 300),
    };
}

export function normalizeNarrativeLedgerDelta(value) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const mentions = normalizeUsageRecord(input.factMentions);
    const applications = normalizeUsageRecord(input.ruleApplications);
    return {
        sceneIndex: input.sceneIndex === undefined ? null : Math.max(0, Math.round(number(input.sceneIndex))),
        chapterId: id(input.chapterId),
        metrics: normalizeMetricRecord(input.metrics ?? input.acceptedMetrics),
        factMentions: mentions,
        ruleApplications: applications,
        recentMotifs: normalizeRecent(input.recentMotifs),
        recentPhrases: normalizeRecent(input.recentPhrases),
    };
}

function mergeUsage(previous, delta, sceneIndex, chapterChanged) {
    const result = {};
    for (const [key, item] of Object.entries(previous)) {
        result[key] = {
            ...item,
            countInCurrentScene: 0,
            countInChapter: chapterChanged ? 0 : item.countInChapter,
        };
    }
    for (const [key, item] of Object.entries(delta)) {
        result[key] = {
            lastSceneIndex: item.lastSceneIndex >= 0 ? item.lastSceneIndex : sceneIndex,
            countInCurrentScene: item.countInCurrentScene,
            countInChapter: (result[key]?.countInChapter ?? 0) + item.countInCurrentScene,
        };
    }
    return result;
}

export function mergeNarrativeLedger(value, deltaValue) {
    const ledger = normalizeNarrativeLedger(value);
    const delta = normalizeNarrativeLedgerDelta(deltaValue);
    const sceneIndex = delta.sceneIndex ?? ledger.sceneIndex + 1;
    const chapterChanged = Boolean(delta.chapterId && ledger.chapterId && delta.chapterId !== ledger.chapterId);
    const acceptedMetrics = {};
    for (const key of Object.keys(ledger.acceptedMetrics)) {
        acceptedMetrics[key] = (chapterChanged ? 0 : ledger.acceptedMetrics[key]) + delta.metrics[key];
    }
    const mergeRecent = (previous, incoming) => {
        const byText = new Map((chapterChanged ? [] : previous).map(item => [item.text.toLowerCase(), item]));
        for (const item of incoming) byText.set(item.text.toLowerCase(), { ...item, lastSceneIndex: sceneIndex });
        return [...byText.values()].sort((a, b) => a.lastSceneIndex - b.lastSceneIndex).slice(-30);
    };
    return {
        schema: NARRATIVE_LEDGER_SCHEMA,
        sceneIndex,
        chapterId: delta.chapterId || ledger.chapterId,
        acceptedMetrics,
        factMentions: mergeUsage(ledger.factMentions, delta.factMentions, sceneIndex, chapterChanged),
        ruleApplications: mergeUsage(ledger.ruleApplications, delta.ruleApplications, sceneIndex, chapterChanged),
        recentMotifs: mergeRecent(ledger.recentMotifs, delta.recentMotifs),
        recentPhrases: mergeRecent(ledger.recentPhrases, delta.recentPhrases),
        stale: ledger.stale,
        staleReason: ledger.stale ? ledger.staleReason : '',
    };
}

export function markNarrativeLedgerStale(value, reason = 'Accepted chat history changed.') {
    return { ...normalizeNarrativeLedger(value), stale: true, staleReason: text(reason, 300) };
}

function intersects(left, right) {
    const set = new Set(left);
    return right.some(item => set.has(item));
}

function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

function hashValue(value) {
    const source = stableStringify(value);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return 'fnv1a-' + (hash >>> 0).toString(16).padStart(8, '0');
}

function focus(plan, progress) {
    if (!plan?.chapters?.length) return { chapter: null, scene: null };
    const chapter = plan.chapters.find(item => item.id === progress?.chapterId) ?? plan.chapters[0];
    const scene = chapter.scenes?.find(item => item.id === progress?.sceneId) ?? chapter.scenes?.[0] ?? null;
    return { chapter, scene };
}

function ratioDirection(target, ledger, expectedWords) {
    const field = METRIC_FIELDS[target.metric];
    const total = ledger.acceptedMetrics.words;
    const midpoint = (target.min + target.max) / 2;
    const correction = total >= 300
        ? Math.min(0.15, Math.max(-0.15, (midpoint - (ledger.acceptedMetrics[field] / total)) * 0.5))
        : 0;
    const min = Math.min(1, Math.max(0, target.min + correction));
    const max = Math.min(1, Math.max(min, target.max + correction));
    return {
        min,
        max,
        minWords: Math.round(expectedWords * min / 25) * 25,
        maxWords: Math.round(expectedWords * max / 25) * 25,
    };
}

function section(title, lines) {
    const filtered = lines.filter(Boolean);
    return filtered.length ? '[' + title + ']\n' + filtered.map(line => '- ' + line).join('\n') : '';
}

function boundedSection(title, lines, maxChars) {
    const filtered = lines.filter(Boolean);
    const limit = Math.max(0, Math.floor(maxChars));
    const prefix = '[' + title + ']\n';
    if (!filtered.length || limit <= prefix.length + 4) return '';
    let output = prefix;
    for (const line of filtered) {
        const separator = output === prefix ? '' : '\n';
        const available = limit - output.length - separator.length - 2;
        if (available <= 1) break;
        const value = String(line);
        const clipped = value.length > available
            ? value.slice(0, Math.max(1, available - 1)).trimEnd() + '…'
            : value;
        output += separator + '- ' + clipped;
        if (clipped.length < value.length) break;
    }
    return output === prefix ? '' : output;
}

export function compileWritingContext({
    profile: profileValue,
    plan = null,
    progress = {},
    ledger: ledgerValue = null,
    sceneBrief: sceneBriefValue = null,
    reviewedContinuity = '',
    projectReferences: projectReferenceValue = [],
    expectedSceneWords = 1100,
    budgetChars = 3000,
} = {}) {
    const profile = normalizeWritingProfile(profileValue);
    if (!profile) {
        return {
            text: '',
            reasons: [],
            exclusions: [],
            warnings: ['A valid reviewed Writing Profile is required.'],
            sourceHash: '',
            includesFuture: false,
            estimatedTokens: 0,
            selectedRuleIds: [],
        };
    }
    const ledger = normalizeNarrativeLedger(ledgerValue);
    const effectiveLedger = ledger.stale ? normalizeNarrativeLedger(null) : ledger;
    const { chapter, scene } = focus(plan, progress);
    const chapterTags = tags(chapter?.tags);
    const sceneTags = tags(scene?.tags);
    const allTags = [...new Set([...chapterTags, ...sceneTags])];
    const explicitIds = new Set([...texts(chapter?.styleRuleIds, 80, 30), ...texts(scene?.styleRuleIds, 80, 30)]);
    const disabledIds = new Set([...texts(chapter?.disabledStyleRuleIds, 80, 30), ...texts(scene?.disabledStyleRuleIds, 80, 30)]);
    const reasons = [];
    const exclusions = [];
    const warnings = [];
    const hardRules = profile.rules.filter(rule => rule.kind === 'hard');
    const softCandidates = profile.rules.filter(rule => rule.kind === 'soft');
    const knownIds = new Set(profile.rules.map(rule => rule.id));
    for (const requested of explicitIds) if (!knownIds.has(requested)) warnings.push('Unknown style rule id: ' + requested + '.');
    for (const requested of disabledIds) if (!knownIds.has(requested)) warnings.push('Unknown disabled style rule id: ' + requested + '.');
    const scored = [];
    for (const rule of softCandidates) {
        if (disabledIds.has(rule.id)) {
            exclusions.push({ id: rule.id, reason: 'explicitly disabled' });
            continue;
        }
        if (intersects(rule.excludeTags, allTags)) {
            exclusions.push({ id: rule.id, reason: 'excluded by scene tag' });
            continue;
        }
        const usage = effectiveLedger.ruleApplications[rule.id];
        if (rule.maxApplicationsPerScene !== null && (usage?.countInCurrentScene ?? 0) >= rule.maxApplicationsPerScene) {
            exclusions.push({ id: rule.id, reason: 'scene application limit reached' });
            continue;
        }
        if (rule.cooldownScenes > 0 && usage?.lastSceneIndex >= 0
            && effectiveLedger.sceneIndex - usage.lastSceneIndex <= rule.cooldownScenes) {
            exclusions.push({ id: rule.id, reason: 'scene cooldown active' });
            continue;
        }
        let score = rule.priority;
        const sources = [];
        if (explicitIds.has(rule.id)) {
            score += 1000;
            sources.push('explicit scene or chapter selection');
        }
        const sceneMatches = rule.includeTags.filter(tag => sceneTags.includes(tag)).length;
        const chapterMatches = rule.includeTags.filter(tag => chapterTags.includes(tag)).length;
        score += sceneMatches * 100 + chapterMatches * 30;
        if (sceneMatches) sources.push('scene tag');
        if (chapterMatches) sources.push('chapter tag');
        if (!rule.includeTags.length) sources.push('untagged candidate');
        if (!explicitIds.has(rule.id) && rule.includeTags.length && !sceneMatches && !chapterMatches) {
            exclusions.push({ id: rule.id, reason: 'required tags not present' });
            continue;
        }
        scored.push({ rule, score, source: sources.join(', ') || 'priority' });
    }
    const legacyRules = texts(plan?.styleGuide, 500, 50).map((instruction, index) => ({
        rule: normalizeRule({
            id: 'legacy-style-' + (index + 1),
            label: 'Legacy style ' + (index + 1),
            instruction,
            priority: 50,
        }),
        score: 50,
        source: 'legacy Story Plan styleGuide',
    }));
    scored.push(...legacyRules);
    scored.sort((left, right) => right.score - left.score
        || right.rule.priority - left.rule.priority
        || left.rule.id.localeCompare(right.rule.id));
    const selected = scored.slice(0, 6);
    for (const item of selected) reasons.push({ id: item.rule.id, source: item.source, score: item.score });
    for (const item of scored.slice(6)) exclusions.push({ id: item.rule.id, reason: 'soft rule limit or context budget' });

    const contractLines = [
        profile.contract.language && 'Language: ' + profile.contract.language + '.',
        profile.contract.pov && 'POV: ' + profile.contract.pov + '.',
        profile.contract.tense && 'Tense: ' + profile.contract.tense + '.',
        profile.contract.narrativeDistance && 'Narrative distance: ' + profile.contract.narrativeDistance + '.',
        ...profile.contract.hardRules,
        ...hardRules.map(rule => rule.instruction),
    ];
    const sceneBrief = sceneBriefValue && typeof sceneBriefValue === 'object' && !Array.isArray(sceneBriefValue)
        ? sceneBriefValue
        : {};
    const hasEditedScene = Boolean(text(sceneBrief.updatedAt, 80))
        && text(sceneBrief.chapterId, 120) === (chapter?.id ?? '')
        && text(sceneBrief.sceneId, 120) === (scene?.id ?? '');
    const effectiveSceneBrief = hasEditedScene ? sceneBrief : {};
    const intentLines = [];
    if (chapter) {
        intentLines.push('Chapter: ' + chapter.title + '.');
        if (!hasEditedScene) {
            if (chapter.summary) intentLines.push('Chapter intent: ' + chapter.summary.slice(0, 1000));
            for (const item of (chapter.goals ?? []).slice(0, 6)) intentLines.push('Chapter goal: ' + item.slice(0, 240));
            for (const item of (chapter.constraints ?? []).slice(0, 6)) intentLines.push('Chapter constraint: ' + item.slice(0, 240));
        }
    }
    if (scene) {
        intentLines.push('Scene: ' + scene.title + '.');
        if (!hasEditedScene) {
            if (scene.summary) intentLines.push('Scene intent: ' + scene.summary.slice(0, 800));
            for (const item of (scene.goals ?? []).slice(0, 6)) intentLines.push('Scene goal: ' + item.slice(0, 240));
            for (const item of (scene.constraints ?? []).slice(0, 6)) intentLines.push('Scene constraint: ' + item.slice(0, 240));
        }
    }
    if (hasEditedScene) intentLines.push('The reviewed editable scene below replaces the chapter and scene planning details for this drafting pass.');
    if (chapter || scene) intentLines.push('These are author intentions, not events that already occurred.');
    const readinessLines = chapter || scene
        ? [
            'The current chapter and scene focus below has been reviewed and enabled for drafting.',
            'When the user asks to write using the current focus, proceed from this context without requesting the same focus fields again.',
            'An empty reviewed Story State means that no earlier story events have become canon yet; it does not mean that the writing focus is missing.',
        ]
        : [];
    const hasSceneBrief = Boolean(
        text(effectiveSceneBrief.summary, 4000)
        || texts(effectiveSceneBrief.cast, 120, 30).length
        || text(effectiveSceneBrief.time, 300)
        || text(effectiveSceneBrief.location, 300)
        || texts(effectiveSceneBrief.mustInclude, 500, 30).length
        || texts(effectiveSceneBrief.avoid, 500, 30).length
        || text(effectiveSceneBrief.ending, 1000),
    );
    const briefLines = [
        text(effectiveSceneBrief.summary, 4000) && 'Scene direction: ' + text(effectiveSceneBrief.summary, 4000),
        texts(effectiveSceneBrief.cast, 120, 30).length && 'Active cast: ' + texts(effectiveSceneBrief.cast, 120, 30).join(', ') + '.',
        text(effectiveSceneBrief.time, 300) && 'Scene time: ' + text(effectiveSceneBrief.time, 300),
        text(effectiveSceneBrief.location, 300) && 'Scene location: ' + text(effectiveSceneBrief.location, 300),
        ...texts(effectiveSceneBrief.mustInclude, 500, 30).map(item => 'Must include: ' + item),
        ...texts(effectiveSceneBrief.avoid, 500, 30).map(item => 'Do not do: ' + item),
        text(effectiveSceneBrief.ending, 1000) && 'End beat: ' + text(effectiveSceneBrief.ending, 1000),
        hasEditedScene && (hasSceneBrief
            ? 'This is the reviewed effective scene instruction and is not established canon.'
            : 'The reviewed effective scene intentionally contains no additional scene instructions; it is not established canon.'),
    ];
    const continuityLines = text(reviewedContinuity, 4000)
        ? [
            'This is the latest reviewed canon and overrides older or initial relationship descriptions.',
            text(reviewedContinuity, 4000),
        ]
        : [];
    const projectReferences = (Array.isArray(projectReferenceValue) ? projectReferenceValue : [])
        .filter(item => item && typeof item === 'object' && text(item.content, 2000))
        .slice(0, 12);
    const projectReferenceLines = projectReferences.length
        ? [
            'Use these stable or opening facts only where current reviewed continuity does not supersede them.',
            ...projectReferences.map(item => (text(item.label, 200) ? text(item.label, 200) + ': ' : '') + text(item.content, 2000)),
        ]
        : [];

    const overrides = { ...(chapter?.targetOverrides ?? {}), ...(scene?.targetOverrides ?? {}) };
    const ruleDirectionLines = selected.map(item => ({ id: item.rule.id, text: item.rule.instruction }));
    const targetDirectionLines = [];
    for (const target of profile.targets) {
        const override = Array.isArray(overrides[target.metric]) ? overrides[target.metric] : null;
        const effective = override && override.length === 2
            ? { ...target, min: boundedNumber(override[0], 0, 1), max: boundedNumber(override[1], 0, 1) }
            : target;
        if (effective.min > effective.max) {
            warnings.push('Invalid target override for ' + target.metric + '.');
            continue;
        }
        const range = ratioDirection(effective, effectiveLedger, boundedNumber(expectedSceneWords, 200, 5000, 1100));
        targetDirectionLines.push(
            METRIC_LABELS[target.metric] + ' is a soft scene target: approximately '
            + range.minWords + '–' + range.maxWords + ' words (' + Math.round(range.min * 100)
            + '%–' + Math.round(range.max * 100) + '%). Do not add filler to hit the range.',
        );
    }

    const portrayalLines = [];
    const triggers = new Set([
        ...texts(chapter?.portrayalTriggers, 80, 30),
        ...texts(scene?.portrayalTriggers, 80, 30),
    ]);
    let suppressedPortrayal = false;
    for (const policy of profile.portrayalPolicies) {
        const usage = effectiveLedger.factMentions[policy.id];
        const triggered = policy.mode === 'always' || triggers.has(policy.id) || intersects(policy.includeTags, allTags);
        const atLimit = (usage?.countInCurrentScene ?? 0) >= policy.maxMentionsPerScene;
        const cooling = policy.cooldownScenes > 0 && usage?.lastSceneIndex >= 0
            && effectiveLedger.sceneIndex - usage.lastSceneIndex <= policy.cooldownScenes;
        if (triggered && !atLimit && !cooling) {
            portrayalLines.push('Portrayal related to ' + (policy.label || policy.id)
                + ' is permitted when it is causally relevant; mention it at most '
                + policy.maxMentionsPerScene + ' time(s) in this scene.');
            reasons.push({ id: policy.id, source: triggers.has(policy.id) ? 'explicit portrayal trigger' : 'matching scene tag', score: 0 });
        } else {
            suppressedPortrayal = true;
            exclusions.push({
                id: policy.id,
                reason: atLimit ? 'portrayal mention limit reached' : cooling ? 'portrayal cooldown active' : 'no portrayal trigger',
            });
        }
    }
    if (suppressedPortrayal) {
        portrayalLines.push('Stable appearance and background facts are reference-only: keep them consistent, but do not proactively restate them unless observation, change, or physical consequence makes them relevant.');
    }

    const recent = [...effectiveLedger.recentMotifs, ...effectiveLedger.recentPhrases]
        .filter(item => effectiveLedger.sceneIndex - item.lastSceneIndex <= 3)
        .sort((left, right) => right.lastSceneIndex - left.lastSceneIndex)
        .slice(0, 6);
    const repetitionLines = recent.length
        ? ['Avoid reflexively reusing these recently prominent motifs or phrases: '
            + recent.map(item => item.text).join('; ')
            + '. Choose a new detail only when it affects the scene.']
        : [];
    if (ledger.stale) warnings.push('Narrative Ledger is stale: ' + (ledger.staleReason || 'accepted history changed.'));

    const matchingExamples = profile.examples
        .filter(example => !example.tags.length || intersects(example.tags, allTags))
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, 2);
    const contractSection = section('WRITING CONTRACT', contractLines);
    const readinessSection = section('ACTIVE WRITING READINESS', readinessLines);
    const portrayalSection = section('REFERENCE REALIZATION POLICY', portrayalLines);
    const fixedRequiredSections = [contractSection, readinessSection, portrayalSection].filter(Boolean);
    const flexibleSections = [
        { title: 'CURRENT REVIEWED CONTINUITY — CANON', lines: continuityLines, weight: 0.32 },
        { title: 'CURRENT AUTHOR INTENT — NOT CANON', lines: intentLines, weight: 0.25 },
        { title: 'CURRENT EDITED SCENE — NOT CANON', lines: briefLines, weight: 0.28 },
        { title: 'STABLE PROJECT REFERENCES — FALLBACK ONLY', lines: projectReferenceLines, weight: 0.15 },
    ].filter(item => item.lines.some(Boolean));
    const optionalReserve = Math.min(1500, Math.floor(budgetChars * 0.25));
    const flexibleBudget = Math.max(0, budgetChars - fixedRequiredSections.join('\n\n').length - optionalReserve);
    const activeWeight = flexibleSections.reduce((sum, item) => sum + item.weight, 0) || 1;
    const boundedFlexibleSections = flexibleSections.map(item => boundedSection(
        item.title,
        item.lines,
        flexibleBudget * item.weight / activeWeight,
    )).filter(Boolean);
    const requiredSections = [
        contractSection,
        readinessSection,
        ...boundedFlexibleSections,
        portrayalSection,
    ].filter(Boolean);
    const requiredLength = requiredSections.join('\n\n').length;
    const includedRuleIds = [];
    const includedDirections = [];
    for (const item of ruleDirectionLines) {
        const candidate = section('ACTIVE PROSE DIRECTIONS', [...includedDirections, item.text]);
        if (requiredLength + candidate.length + 2 <= budgetChars) {
            includedDirections.push(item.text);
            includedRuleIds.push(item.id);
        } else {
            const reasonIndex = reasons.findIndex(reason => reason.id === item.id);
            if (reasonIndex >= 0) reasons.splice(reasonIndex, 1);
            exclusions.push({ id: item.id, reason: 'context budget' });
        }
    }
    for (const item of targetDirectionLines) {
        const candidate = section('ACTIVE PROSE DIRECTIONS', [...includedDirections, item]);
        if (requiredLength + candidate.length + 2 <= budgetChars) includedDirections.push(item);
        else warnings.push('A prose-ratio target was omitted from the compiled context because of the context budget.');
    }
    const baseSections = [
        contractSection,
        readinessSection,
        ...boundedFlexibleSections,
        section('ACTIVE PROSE DIRECTIONS', includedDirections),
        portrayalSection,
    ].filter(Boolean);
    let output = baseSections.join('\n\n');
    const repetitionBlock = section('RECENT REPETITION GUARD', repetitionLines);
    if (repetitionBlock && output.length + repetitionBlock.length + 2 <= budgetChars) output += '\n\n' + repetitionBlock;
    else if (repetitionBlock) warnings.push('The recent repetition guard was omitted because of the context budget.');
    for (const example of matchingExamples) {
        const block = section('STYLE EXAMPLE — REFERENCE, DO NOT COPY', [
            (example.label ? example.label + ': ' : '') + example.text,
            example.notes && 'Notes: ' + example.notes,
        ]);
        if (output.length + block.length + 2 <= budgetChars) {
            output += '\n\n' + block;
            reasons.push({ id: example.id, source: 'matching style example', score: 0 });
        } else {
            exclusions.push({ id: example.id, reason: 'context budget' });
        }
    }
    if (output.length > budgetChars) {
        warnings.push('Required context exceeds the configured character budget; optional examples were removed first.');
    }
    const sourceHash = hashValue({
        profile,
        chapter,
        scene,
        ledger,
        sceneBrief,
        reviewedContinuity: text(reviewedContinuity, 4000),
        projectReferences,
        expectedSceneWords,
        budgetChars,
    });
    return {
        text: output,
        reasons,
        exclusions,
        warnings,
        sourceHash,
        includesFuture: false,
        estimatedTokens: Math.ceil(output.length / 3),
        selectedRuleIds: includedRuleIds,
    };
}

function normalizeCriticItems(value, idField) {
    return (Array.isArray(value) ? value : []).map(item => ({
        [idField]: id(item?.[idField]),
        excerpt: text(item?.excerpt, 500),
        reason: text(item?.reason, 500),
    })).filter(item => item.excerpt && item.reason).slice(0, 20);
}

export function normalizeWritingCriticReport(value) {
    let input;
    try {
        input = parseObject(value);
    } catch {
        return null;
    }
    if (!input || input.schema !== WRITING_CRITIC_SCHEMA) return null;
    const targetEstimates = {};
    if (input.targetEstimates && typeof input.targetEstimates === 'object' && !Array.isArray(input.targetEstimates)) {
        for (const [metric, estimate] of Object.entries(input.targetEstimates).slice(0, 20)) {
            if (TARGET_METRICS.includes(metric) && Number.isFinite(Number(estimate))) {
                targetEstimates[metric] = boundedNumber(estimate, 0, 1);
            }
        }
    }
    return {
        schema: WRITING_CRITIC_SCHEMA,
        unnecessaryFactMentions: normalizeCriticItems(input.unnecessaryFactMentions, 'policyId'),
        repeatedMotifs: normalizeCriticItems(input.repeatedMotifs, 'motifId'),
        ruleViolations: normalizeCriticItems(input.ruleViolations, 'ruleId'),
        targetEstimates,
        suggestedEdits: texts(input.suggestedEdits, 1000, 20),
    };
}

export function writingCriticPrompt(prose, profileValue, compiledContext = '') {
    const profile = normalizeWritingProfile(profileValue);
    if (!profile) return '';
    const policyIds = profile.portrayalPolicies.map(item => item.id);
    const ruleIds = [
        ...profile.contract.hardRules.map((_, index) => 'contract-hard-' + (index + 1)),
        ...profile.rules.map(item => item.id),
    ];
    return 'Review the prose below against the reviewed writing controls. Return JSON only as '
        + '{"schema":"' + WRITING_CRITIC_SCHEMA + '","unnecessaryFactMentions":[{"policyId":"","excerpt":"","reason":""}],'
        + '"repeatedMotifs":[{"motifId":"","excerpt":"","reason":""}],"ruleViolations":[{"ruleId":"","excerpt":"","reason":""}],'
        + '"targetEstimates":{"dialogue_word_share":0},"suggestedEdits":[]}. '
        + 'Report only concrete issues supported by the prose. Use only the listed policy and rule IDs. '
        + 'Keep excerpts short, do not rewrite the full passage, and return empty arrays when there is no issue. '
        + 'This is an advisory report: do not claim that planned events are canon.\n\n'
        + 'POLICY IDS\n' + JSON.stringify(policyIds) + '\n\n'
        + 'RULE IDS\n' + JSON.stringify(ruleIds) + '\n\n'
        + 'COMPILED WRITING CONTEXT\n' + text(compiledContext, 6000) + '\n\n'
        + 'PROSE TO REVIEW\n' + text(prose, 20000);
}

export function buildCurrentSceneWritingRequest(value = {}) {
    const chapterTitle = text(value.chapterTitle, 300);
    const sceneTitle = text(value.sceneTitle, 300);
    const language = text(value.language, 120) || 'the language required by the active Writing Profile';
    const expectedSceneWords = Math.min(5000, Math.max(200, Math.round(number(value.expectedSceneWords)) || 1100));
    const focus = [chapterTitle, sceneTitle].filter(Boolean).join(' / ') || 'the active chapter and scene';
    const targetUnit = /(?:^zh(?:-|$)|chinese|中文)/i.test(language)
        ? `approximately ${expectedSceneWords} Chinese characters, with a preferred tolerance of ±15%`
        : `approximately ${expectedSceneWords} words, with a preferred tolerance of ±15%`;
    return [
        'Write the currently active scene as finished novel prose.',
        `Active focus: ${focus}.`,
        `Write in ${language}, targeting ${targetUnit}.`,
        'Use the active project context, Writing Profile, reviewed story state, and recent prose. Treat the current chapter and scene plan as author intent, not as events that already happened.',
        'Do not ask me to repeat the focus, POV, location, cast, or target length when they are already present in the active context.',
        'Output only the prose. Do not include planning notes, explanations, JSON, headings, or a recap.',
        'If the response limit cannot hold the whole target, stop at a natural scene beat without summarizing the unwritten remainder.',
    ].join('\n');
}
