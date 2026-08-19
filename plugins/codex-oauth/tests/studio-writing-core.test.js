import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildCurrentSceneWritingRequest,
    compileWritingContext,
    createDefaultWritingProfile,
    markNarrativeLedgerStale,
    mergeNarrativeLedger,
    migrateLegacyStyleGuide,
    normalizeNarrativeLedger,
    normalizeWritingCriticReport,
    normalizeWritingProfile,
    parseOptionalPercentRange,
    validateWritingProfile,
    writingCriticPrompt,
    WRITING_PROFILE_SCHEMA,
} from '../../../public/scripts/extensions/third-party/codex-oauth/studio-writing-core.js';

test('current scene request is bounded, complete, and does not claim planned events are canon', () => {
    const request = buildCurrentSceneWritingRequest({
        chapterTitle: '第一章',
        sceneTitle: '初入公寓',
        language: '简体中文',
        expectedSceneWords: 4000,
    });
    assert.match(request, /第一章 \/ 初入公寓/);
    assert.match(request, /4000/);
    assert.match(request, /author intent, not as events that already happened/);
    assert.match(request, /Do not ask me to repeat the focus/);
    assert.match(request, /Output only the prose/);
});

function profile(overrides = {}) {
    const base = createDefaultWritingProfile();
    return {
        ...base,
        ...overrides,
        contract: { ...base.contract, ...(overrides.contract ?? {}) },
    };
}

function plan(scene = {}) {
    return {
        schema: 'amy_story_plan_v1',
        title: 'Atlas',
        premise: 'A future revelation that must remain hidden.',
        styleGuide: [],
        chapters: [{
            id: 'chapter-1',
            title: 'Arrival',
            summary: 'Mira reaches the port.',
            goals: ['Find a witness.'],
            constraints: ['Do not reveal the map maker.'],
            tags: ['mystery'],
            styleRuleIds: [],
            disabledStyleRuleIds: [],
            targetOverrides: {},
            portrayalTriggers: [],
            scenes: [{
                id: 'scene-1',
                title: 'Interview',
                summary: 'Mira questions Ivo.',
                goals: ['Obtain one verifiable clue.'],
                constraints: ['The antagonist must not appear.'],
                tags: ['dialogue'],
                styleRuleIds: [],
                disabledStyleRuleIds: [],
                targetOverrides: {},
                portrayalTriggers: [],
                ...scene,
            }],
        }],
    };
}

test('Writing Profile validation rejects malformed ids, duplicates, and impossible ranges', () => {
    const value = profile({
        id: 'Not Valid',
        rules: [
            { id: 'same', instruction: 'A', kind: 'soft', priority: 50 },
            { id: 'same', instruction: 'B', kind: 'soft', priority: 50 },
        ],
        targets: [{ id: 'bad-target', metric: 'dialogue_word_share', min: 0.8, max: 0.2 }],
    });
    const result = validateWritingProfile(value);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.includes('Profile id')));
    assert.ok(result.errors.some(error => error.includes('duplicate id')));
    assert.ok(result.errors.some(error => error.includes('0 <= min <= max <= 1')));
});

test('Writing Profile normalization is bounded and does not mutate input', () => {
    const value = profile();
    value.rules[0].scope = 'scene';
    value.targets[0].scope = 'chapter';
    const before = structuredClone(value);
    const normalized = normalizeWritingProfile(value);
    assert.equal(normalized.schema, WRITING_PROFILE_SCHEMA);
    assert.deepEqual(value, before);
    assert.notEqual(normalized, value);
    assert.equal(Object.hasOwn(normalized.rules[0], 'scope'), false);
    assert.equal(Object.hasOwn(normalized.targets[0], 'scope'), false);
    assert.equal(normalizeWritingProfile(JSON.stringify(normalized)).rules[1].maxApplicationsPerScene, null);
});

test('Writing Profile validation rejects content that would otherwise be silently truncated', () => {
    const value = profile();
    value.rules[0].instruction = 'x'.repeat(1001);
    const result = validateWritingProfile(value);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.includes('exceeds 1000 characters')));
});

test('optional percent ranges treat blank fields as absent instead of zero', () => {
    assert.equal(parseOptionalPercentRange('', ''), null);
    assert.equal(parseOptionalPercentRange('30', ''), null);
    assert.equal(parseOptionalPercentRange('80', '20'), null);
    assert.deepEqual(parseOptionalPercentRange('30', '50'), [0.3, 0.5]);
});

test('legacy Story Plan style guidance becomes a reviewable unsaved profile', () => {
    const migrated = migrateLegacyStyleGuide({ styleGuide: ['Short sentences.', 'Stay close to Mira.'] });
    assert.equal(migrated.schema, WRITING_PROFILE_SCHEMA);
    assert.deepEqual(migrated.rules.map(rule => rule.id), ['legacy-style-1', 'legacy-style-2']);
    assert.equal(migrateLegacyStyleGuide({ styleGuide: [] }), null);
});

test('compiler keeps hard rules and deterministically selects explicit and tag-matched rules', () => {
    const value = profile({
        rules: [
            { id: 'hard-boundary', instruction: 'Never reveal private thoughts.', kind: 'hard', priority: 0 },
            { id: 'dialogue-beats', instruction: 'Use action beats between replies.', kind: 'soft', priority: 20, includeTags: ['dialogue'] },
            { id: 'explicit-low', instruction: 'Let silence carry the turn.', kind: 'soft', priority: 0 },
            { id: 'blocked', instruction: 'Use lyrical weather.', kind: 'soft', priority: 100 },
        ],
    });
    const story = plan({ styleRuleIds: ['explicit-low'], disabledStyleRuleIds: ['blocked'] });
    const first = compileWritingContext({ profile: value, plan: story, progress: { chapterId: 'chapter-1', sceneId: 'scene-1' } });
    const second = compileWritingContext({ profile: value, plan: story, progress: { chapterId: 'chapter-1', sceneId: 'scene-1' } });
    assert.equal(first.text, second.text);
    assert.equal(first.sourceHash, second.sourceHash);
    assert.match(first.text, /Never reveal private thoughts/);
    assert.match(first.text, /Use action beats between replies/);
    assert.match(first.text, /Let silence carry the turn/);
    assert.doesNotMatch(first.text, /Use lyrical weather/);
    assert.ok(first.exclusions.some(item => item.id === 'blocked' && item.reason.includes('disabled')));
});

test('compiler caps soft rules at six with stable ordering', () => {
    const rules = Array.from({ length: 9 }, (_, index) => ({
        id: 'rule-' + (index + 1),
        instruction: 'Instruction ' + (index + 1),
        kind: 'soft',
        priority: 50,
    }));
    const result = compileWritingContext({ profile: profile({ rules }) });
    assert.deepEqual(result.selectedRuleIds, ['rule-1', 'rule-2', 'rule-3', 'rule-4', 'rule-5', 'rule-6']);
    assert.equal(result.exclusions.filter(item => item.reason.includes('soft rule limit')).length, 3);
});

test('rule cooldown and scene application limits suppress optional directions', () => {
    const value = profile({
        rules: [{
            id: 'echo',
            instruction: 'Use one echo motif.',
            kind: 'soft',
            priority: 100,
            cooldownScenes: 2,
            maxApplicationsPerScene: 1,
        }],
    });
    const cooldown = compileWritingContext({
        profile: value,
        ledger: { sceneIndex: 5, ruleApplications: { echo: { lastSceneIndex: 4, countInCurrentScene: 0 } } },
    });
    assert.doesNotMatch(cooldown.text, /Use one echo motif/);
    assert.ok(cooldown.exclusions.some(item => item.reason.includes('cooldown')));
    const limit = compileWritingContext({
        profile: value,
        ledger: { sceneIndex: 5, ruleApplications: { echo: { lastSceneIndex: 1, countInCurrentScene: 1 } } },
    });
    assert.ok(limit.exclusions.some(item => item.reason.includes('application limit')));
});

test('portrayal policy is reference-only until a reviewed scene trigger permits it', () => {
    const value = profile();
    const suppressed = compileWritingContext({ profile: value, plan: plan() });
    assert.match(suppressed.text, /reference-only/);
    assert.ok(suppressed.exclusions.some(item => item.id === 'stable-appearance'));
    const permitted = compileWritingContext({
        profile: value,
        plan: plan({ portrayalTriggers: ['stable-appearance'] }),
    });
    assert.match(permitted.text, /is permitted when it is causally relevant/i);
    assert.ok(permitted.reasons.some(item => item.id === 'stable-appearance'));
});

test('target ranges use accepted metrics but remain soft and bounded', () => {
    const lowDialogue = compileWritingContext({
        profile: profile(),
        expectedSceneWords: 1000,
        ledger: { acceptedMetrics: { words: 4000, dialogueWords: 400 } },
    });
    assert.match(lowDialogue.text, /Dialogue is a soft scene target/);
    assert.match(lowDialogue.text, /Do not add filler/);
    const noHistory = compileWritingContext({ profile: profile(), expectedSceneWords: 1000 });
    assert.match(noHistory.text, /300–500 words/);
});

test('compiler excludes future plan data and reports a stable source hash', () => {
    const value = plan();
    value.chapters.push({
        id: 'chapter-2',
        title: 'The map maker revealed',
        summary: 'Ivo is the map maker.',
        goals: [],
        constraints: [],
        scenes: [],
    });
    const result = compileWritingContext({
        profile: profile(),
        plan: value,
        progress: { chapterId: 'chapter-1', sceneId: 'scene-1' },
    });
    assert.equal(result.includesFuture, false);
    assert.doesNotMatch(result.text, /Ivo is the map maker|future revelation/);
    assert.match(result.text, /CURRENT AUTHOR INTENT — NOT CANON/);
    assert.match(result.text, /ACTIVE WRITING READINESS/);
    assert.match(result.text, /without requesting the same focus fields again/);
    assert.match(result.text, /no earlier story events have become canon yet/);
    assert.match(result.sourceHash, /^fnv1a-[0-9a-f]{8}$/);
});

test('examples are tag-selected and removed before required context exceeds the budget', () => {
    const value = profile({
        examples: [
            { id: 'dialogue-example', label: 'Dialogue', tags: ['dialogue'], text: 'A short matching example.' },
            { id: 'battle-example', label: 'Battle', tags: ['battle'], text: 'A battle example.' },
        ],
    });
    const roomy = compileWritingContext({ profile: value, plan: plan(), budgetChars: 10000 });
    assert.match(roomy.text, /A short matching example/);
    assert.doesNotMatch(roomy.text, /A battle example/);
    const tight = compileWritingContext({ profile: value, plan: plan(), budgetChars: 100 });
    assert.doesNotMatch(tight.text, /A short matching example/);
    assert.ok(tight.exclusions.some(item => item.id === 'dialogue-example' && item.reason === 'context budget'));
});

test('default compiled context stays within the designed token estimate and trims optional rules first', () => {
    const rules = Array.from({ length: 20 }, (_, index) => ({
        id: 'long-rule-' + (index + 1),
        instruction: 'Optional direction ' + (index + 1) + ': ' + 'detail '.repeat(80),
        kind: 'soft',
        priority: 100 - index,
    }));
    const result = compileWritingContext({ profile: profile({ rules }), plan: plan() });
    assert.ok(result.estimatedTokens <= 1000);
    assert.ok(result.selectedRuleIds.length < 6);
    assert.ok(result.exclusions.some(item => item.reason === 'context budget'));
    assert.match(result.text, /Do not reveal the map maker/);
});

test('Narrative Ledger merges only reviewed deltas and resets chapter-local counters', () => {
    const previous = normalizeNarrativeLedger({
        sceneIndex: 2,
        chapterId: 'chapter-1',
        acceptedMetrics: { words: 1000, dialogueWords: 300 },
        factMentions: { 'stable-appearance': { lastSceneIndex: 2, countInCurrentScene: 1, countInChapter: 2 } },
        recentMotifs: [{ text: 'rain', lastSceneIndex: 2 }],
    });
    const merged = mergeNarrativeLedger(previous, {
        sceneIndex: 3,
        chapterId: 'chapter-1',
        metrics: { words: 500, dialogueWords: 250 },
        factMentions: { 'stable-appearance': { countInCurrentScene: 1 } },
        recentMotifs: [{ text: 'cold glass' }],
    });
    assert.equal(merged.acceptedMetrics.words, 1500);
    assert.equal(merged.factMentions['stable-appearance'].countInChapter, 3);
    assert.deepEqual(merged.recentMotifs.map(item => item.text), ['rain', 'cold glass']);
    const nextChapter = mergeNarrativeLedger(merged, {
        sceneIndex: 4,
        chapterId: 'chapter-2',
        metrics: { words: 200, actionWords: 100 },
    });
    assert.equal(nextChapter.acceptedMetrics.words, 200);
    assert.equal(nextChapter.factMentions['stable-appearance'].countInChapter, 0);
});

test('accepted-history changes mark the ledger stale without deleting evidence', () => {
    const stale = markNarrativeLedgerStale({
        sceneIndex: 4,
        acceptedMetrics: { words: 900, dialogueWords: 90 },
        ruleApplications: { 'emotion-through-action': { lastSceneIndex: 4, countInCurrentScene: 3 } },
        recentMotifs: [{ text: 'stale-rain-motif', lastSceneIndex: 4 }],
    }, 'Message edited.');
    assert.equal(stale.stale, true);
    assert.equal(stale.acceptedMetrics.words, 900);
    assert.equal(stale.staleReason, 'Message edited.');
    const compiled = compileWritingContext({ profile: profile(), plan: plan(), ledger: stale });
    assert.ok(compiled.warnings.some(warning => warning.includes('stale')));
    assert.match(compiled.text, /Emotion through action|Prefer action, pauses/);
    assert.match(compiled.text, /approximately 325–550 words \(30%–50%\)/);
    assert.doesNotMatch(compiled.text, /stale-rain-motif/);
    const merged = mergeNarrativeLedger(stale, { metrics: { words: 200 } });
    assert.equal(merged.stale, true);
    assert.equal(merged.acceptedMetrics.words, 1100);
});

test('optional critic reports are bounded, advisory, and never rewrite accepted prose automatically', () => {
    const report = normalizeWritingCriticReport({
        schema: 'amy_writing_critic_v1',
        unnecessaryFactMentions: [{ policyId: 'stable-appearance', excerpt: 'silver hair again', reason: 'not relevant' }],
        repeatedMotifs: [],
        ruleViolations: [{ ruleId: 'emotion-through-action', excerpt: 'she felt sad', reason: 'explains the shown emotion' }],
        targetEstimates: { dialogue_word_share: 4, unknown: 0.5 },
        suggestedEdits: ['Remove the redundant appearance clause.'],
    });
    assert.equal(report.schema, 'amy_writing_critic_v1');
    assert.equal(report.targetEstimates.dialogue_word_share, 1);
    assert.equal(Object.hasOwn(report.targetEstimates, 'unknown'), false);
    assert.equal(normalizeWritingCriticReport({ suggestedEdits: [] }), null);
    const prompt = writingCriticPrompt('Mira touched the door.', profile(), '[WRITING CONTRACT]');
    assert.match(prompt, /advisory report/i);
    assert.match(prompt, /do not rewrite the full passage/i);
    assert.match(prompt, /Mira touched the door/);
});
