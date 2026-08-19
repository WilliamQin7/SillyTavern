import { Popup } from '../../../popup.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { escapeHtml } from '../../../utils.js';
import { tr } from './i18n.js';
import {
    compileWritingContext,
    createDefaultWritingProfile,
    migrateLegacyStyleGuide,
    normalizeNarrativeLedger,
    normalizeWritingCriticReport,
    normalizeWritingProfile,
    normalizeWritingTemplates,
    parseOptionalPercentRange,
    validateWritingProfile,
    writingCriticPrompt,
} from './studio-writing-core.js';

function text(value) {
    return String(value ?? '').trim();
}

function lines(value) {
    return String(value ?? '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function localizedDefaultWritingProfile() {
    const profile = createDefaultWritingProfile();
    profile.name = tr('studio.writing.defaultProfileName');
    profile.contract.language = tr('studio.writing.defaultLanguage');
    profile.contract.pov = tr('studio.writing.defaultPov');
    profile.contract.tense = tr('studio.writing.defaultTense');
    profile.contract.narrativeDistance = tr('studio.writing.defaultDistance');
    profile.contract.hardRules = [
        tr('studio.writing.defaultHardKnowledge'),
        tr('studio.writing.defaultHardFuture'),
    ];
    profile.rules[0].label = tr('studio.writing.defaultEmotionLabel');
    profile.rules[0].instruction = tr('studio.writing.defaultEmotionRule');
    profile.rules[1].label = tr('studio.writing.defaultSensoryLabel');
    profile.rules[1].instruction = tr('studio.writing.defaultSensoryRule');
    profile.portrayalPolicies[0].label = tr('studio.writing.defaultAppearanceLabel');
    return normalizeWritingProfile(profile);
}

export function normalizeWritingChatState(state) {
    const input = state && typeof state === 'object' ? state : {};
    const writingProfile = normalizeWritingProfile(input.writingProfile);
    return {
        ...input,
        writingProfile,
        pendingWritingProfile: typeof input.pendingWritingProfile === 'string' ? input.pendingWritingProfile : '',
        writingProfileSourceId: typeof input.writingProfileSourceId === 'string' ? input.writingProfileSourceId : '',
        writingControlActive: input.writingControlActive === true && Boolean(writingProfile),
        expectedSceneWords: Math.min(5000, Math.max(200, Number(input.expectedSceneWords) || 1100)),
        narrativeLedger: normalizeNarrativeLedger(input.narrativeLedger),
        compiledWritingContext: {
            text: typeof input.compiledWritingContext?.text === 'string' ? input.compiledWritingContext.text : '',
            reasons: Array.isArray(input.compiledWritingContext?.reasons) ? input.compiledWritingContext.reasons : [],
            exclusions: Array.isArray(input.compiledWritingContext?.exclusions) ? input.compiledWritingContext.exclusions : [],
            warnings: Array.isArray(input.compiledWritingContext?.warnings) ? input.compiledWritingContext.warnings : [],
            sourceHash: typeof input.compiledWritingContext?.sourceHash === 'string' ? input.compiledWritingContext.sourceHash : '',
            estimatedTokens: Math.max(0, Number(input.compiledWritingContext?.estimatedTokens) || 0),
            includesFuture: false,
        },
    };
}

export function normalizeWritingExtensionSettings(state) {
    const input = state && typeof state === 'object' ? state : {};
    input.writingProfileTemplates = normalizeWritingTemplates(input.writingProfileTemplates);
    return input;
}

export function writingControlTabMarkup() {
    return '<button class="menu_button amy-studio-tab" data-tab="writing" data-i18n="amyCreatorStudio.studio.tab.writing">Writing control</button>';
}

export function writingControlMarkup() {
    return [
        '<section data-amy-tab="writing" class="displayNone">',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.template">Profile template</span><select id="amy-studio-writing-template" class="text_pole"></select></label>',
        '<div class="flex-container">',
        '<button id="amy-studio-writing-default" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.default">Load restrained default</button>',
        '<button id="amy-studio-writing-migrate" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.migrate">Draft from Story Plan style</button>',
        '<button id="amy-studio-writing-save-template" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.saveTemplate">Save as reusable template</button>',
        '<button id="amy-studio-writing-export" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.export">Export</button>',
        '<label class="menu_button amy-studio-file-button"><span data-i18n="amyCreatorStudio.studio.writing.import">Import</span><input id="amy-studio-writing-import" type="file" accept=".json,application/json"></label>',
        '</div>',
        '<div class="amy-studio-writing-grid">',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.name">Profile name</span><input id="amy-studio-writing-name" class="text_pole"></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.language">Language</span><input id="amy-studio-writing-language" class="text_pole" placeholder="zh-CN"></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.pov">Point of view</span><input id="amy-studio-writing-pov" class="text_pole"></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.tense">Tense</span><input id="amy-studio-writing-tense" class="text_pole"></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.distance">Narrative distance</span><input id="amy-studio-writing-distance" class="text_pole"></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.sceneWords">Expected scene words</span><input id="amy-studio-writing-scene-words" class="text_pole" type="number" min="200" max="5000" value="1100"></label>',
        '</div>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.hardRules">Hard rules, one per line</span><textarea id="amy-studio-writing-hard-rules" class="text_pole" rows="4"></textarea></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.softRules">Quick prose preferences, one per line</span><textarea id="amy-studio-writing-soft-rules" class="text_pole" rows="5"></textarea></label>',
        '<div class="amy-studio-writing-grid">',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.dialogueMin">Dialogue minimum %</span><input id="amy-studio-writing-dialogue-min" class="text_pole" type="number" min="0" max="100"></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.dialogueMax">Dialogue maximum %</span><input id="amy-studio-writing-dialogue-max" class="text_pole" type="number" min="0" max="100"></label>',
        '<label class="checkbox_label"><input id="amy-studio-writing-appearance" type="checkbox"><span data-i18n="amyCreatorStudio.studio.writing.appearance">Describe stable appearance only when relevant</span></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.cooldown">Appearance cooldown, scenes</span><input id="amy-studio-writing-cooldown" class="text_pole" type="number" min="0" max="100"></label>',
        '</div>',
        '<label><span data-i18n="amyCreatorStudio.studio.writing.example">Optional short style example</span><textarea id="amy-studio-writing-example" class="text_pole" rows="4"></textarea></label>',
        '<details><summary data-i18n="amyCreatorStudio.studio.writing.advanced">Advanced Profile JSON</summary>',
        '<textarea id="amy-studio-writing-profile" class="text_pole monospace" rows="18"></textarea>',
        '</details>',
        '<div class="flex-container">',
        '<button id="amy-studio-writing-save" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.save">Save reviewed Profile</button>',
        '<button id="amy-studio-writing-preview" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.preview">Compile preview</button>',
        '<button id="amy-studio-writing-activate" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.activate">Activate / refresh</button>',
        '<button id="amy-studio-writing-deactivate" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.deactivate">Deactivate</button>',
        '</div>',
        '<small id="amy-studio-writing-status"></small>',
        '<details open><summary data-i18n="amyCreatorStudio.studio.writing.inspector">Context Inspector</summary>',
        '<div id="amy-studio-writing-inspector-meta" class="amy-studio-writing-meta"></div>',
        '<pre id="amy-studio-writing-preview-text" class="amy-studio-audit amy-studio-writing-preview"></pre>',
        '<pre id="amy-studio-writing-reasons" class="amy-studio-audit"></pre>',
        '</details>',
        '<details><summary data-i18n="amyCreatorStudio.studio.writing.ledger">Reviewed Narrative Ledger</summary>',
        '<button id="amy-studio-writing-reset-ledger" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.resetLedger">Reset stale Ledger</button>',
        '<pre id="amy-studio-writing-ledger" class="amy-studio-audit"></pre>',
        '</details>',
        '<details><summary data-i18n="amyCreatorStudio.studio.writing.critic">Optional prose critic</summary>',
        '<small data-i18n="amyCreatorStudio.studio.writing.criticNote">Reviews only the latest assistant prose and never edits or saves it automatically.</small>',
        '<div class="flex-container"><button id="amy-studio-writing-critic" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.runCritic">Review latest reply</button><button id="amy-studio-writing-copy-critic" class="menu_button" data-i18n="amyCreatorStudio.studio.writing.copyCritic">Copy report</button></div>',
        '<pre id="amy-studio-writing-critic-report" class="amy-studio-audit"></pre>',
        '</details>',
        '<small data-i18n="amyCreatorStudio.studio.writing.note">Only the compiled current-scene subset enters the chat lorebook. Saving a Profile, activating context, and accepting Ledger changes require review.</small>',
        '</section>',
    ].join('');
}

function currentDraft(state) {
    const raw = text($('#amy-studio-writing-profile').val())
        || state.pendingWritingProfile
        || (state.writingProfile ? JSON.stringify(state.writingProfile, null, 2) : '');
    return raw;
}

function writeDraft(state, profile, sourceId = '') {
    state.pendingWritingProfile = JSON.stringify(profile, null, 2);
    state.writingProfileSourceId = sourceId;
    $('#amy-studio-writing-profile').val(state.pendingWritingProfile);
}

function updateSimpleFields(profile) {
    $('#amy-studio-writing-name').val(profile?.name ?? '');
    $('#amy-studio-writing-language').val(profile?.contract?.language ?? '');
    $('#amy-studio-writing-pov').val(profile?.contract?.pov ?? '');
    $('#amy-studio-writing-tense').val(profile?.contract?.tense ?? '');
    $('#amy-studio-writing-distance').val(profile?.contract?.narrativeDistance ?? '');
    $('#amy-studio-writing-hard-rules').val((profile?.contract?.hardRules ?? []).join('\n'));
    $('#amy-studio-writing-soft-rules').val((profile?.rules ?? []).filter(rule => rule.kind === 'soft').map(rule => rule.instruction).join('\n'));
    const dialogue = (profile?.targets ?? []).find(target => target.metric === 'dialogue_word_share');
    $('#amy-studio-writing-dialogue-min').val(dialogue ? Math.round(dialogue.min * 100) : '');
    $('#amy-studio-writing-dialogue-max').val(dialogue ? Math.round(dialogue.max * 100) : '');
    const appearance = (profile?.portrayalPolicies ?? []).find(policy => policy.id === 'stable-appearance');
    $('#amy-studio-writing-appearance').prop('checked', Boolean(appearance));
    $('#amy-studio-writing-cooldown').val(appearance?.cooldownScenes ?? 3);
    $('#amy-studio-writing-example').val(profile?.examples?.[0]?.text ?? '');
}

function profileFromSimple(baseValue) {
    const base = normalizeWritingProfile(baseValue) ?? localizedDefaultWritingProfile();
    const name = text($('#amy-studio-writing-name').val()) || base.name;
    const softRules = lines($('#amy-studio-writing-soft-rules').val()).slice(0, 100);
    const existingSoftRules = (base.rules ?? []).filter(rule => rule.kind === 'soft');
    const hardRules = lines($('#amy-studio-writing-hard-rules').val()).slice(0, 20);
    const dialogueRange = parseOptionalPercentRange(
        $('#amy-studio-writing-dialogue-min').val(),
        $('#amy-studio-writing-dialogue-max').val(),
    );
    const targets = (base.targets ?? []).filter(target => target.metric !== 'dialogue_word_share');
    const existingDialogueTarget = (base.targets ?? []).find(target => target.metric === 'dialogue_word_share');
    if (dialogueRange) targets.push({
        ...(existingDialogueTarget ?? {}),
        id: existingDialogueTarget?.id || 'dialogue-share',
        metric: 'dialogue_word_share',
        min: dialogueRange[0],
        max: dialogueRange[1],
    });
    const portrayalPolicies = (base.portrayalPolicies ?? []).filter(policy => policy.id !== 'stable-appearance');
    const existingAppearance = (base.portrayalPolicies ?? []).find(policy => policy.id === 'stable-appearance');
    if ($('#amy-studio-writing-appearance').prop('checked')) {
        portrayalPolicies.push({
            ...(existingAppearance ?? {}),
            id: 'stable-appearance',
            label: existingAppearance?.label || tr('studio.writing.defaultAppearanceLabel'),
            mode: existingAppearance?.mode || 'reference_only',
            includeTags: existingAppearance?.includeTags?.length
                ? existingAppearance.includeTags
                : ['first-observation', 'appearance-change', 'physical-consequence'],
            maxMentionsPerScene: existingAppearance?.maxMentionsPerScene ?? 1,
            cooldownScenes: Math.min(100, Math.max(0, Number($('#amy-studio-writing-cooldown').val()) || 0)),
            matchTerms: existingAppearance?.matchTerms ?? [],
        });
    }
    const exampleText = text($('#amy-studio-writing-example').val());
    const firstExample = base.examples?.[0];
    const examples = [
        ...(exampleText ? [{
            ...(firstExample ?? {}),
            id: firstExample?.id || 'quick-style-example',
            label: firstExample?.label || tr('studio.writing.defaultExampleLabel'),
            tags: firstExample?.tags ?? [],
            text: exampleText,
            notes: firstExample?.notes || tr('studio.writing.defaultExampleNote'),
        }] : []),
        ...(base.examples ?? []).slice(1),
    ];
    const usedRuleIds = new Set();
    const allocatedRuleIds = new Set((base.rules ?? []).filter(rule => rule.kind === 'hard').map(rule => rule.id));
    const mappedSoftRules = softRules.map((instruction, index) => {
        const existing = existingSoftRules.find(rule => !usedRuleIds.has(rule.id) && rule.instruction === instruction)
            ?? (usedRuleIds.has(existingSoftRules[index]?.id) ? null : existingSoftRules[index]);
        if (existing) {
            usedRuleIds.add(existing.id);
            allocatedRuleIds.add(existing.id);
            return { ...existing, instruction };
        }
        let generatedIndex = index + 1;
        while (allocatedRuleIds.has('quick-rule-' + generatedIndex)) generatedIndex++;
        const generatedId = 'quick-rule-' + generatedIndex;
        allocatedRuleIds.add(generatedId);
        return {
            id: generatedId,
            label: tr('studio.writing.quickRuleLabel', { index: index + 1 }),
            instruction,
            kind: 'soft',
            priority: 60,
            includeTags: [],
            excludeTags: [],
            maxApplicationsPerScene: null,
            cooldownScenes: 0,
        };
    });
    return normalizeWritingProfile({
        ...base,
        id: base.id,
        name,
        contract: {
            ...base.contract,
            language: text($('#amy-studio-writing-language').val()),
            pov: text($('#amy-studio-writing-pov').val()),
            tense: text($('#amy-studio-writing-tense').val()),
            narrativeDistance: text($('#amy-studio-writing-distance').val()),
            hardRules,
        },
        rules: [
            ...(base.rules ?? []).filter(rule => rule.kind === 'hard'),
            ...mappedSoftRules,
        ],
        targets,
        portrayalPolicies,
        examples,
    });
}

function downloadProfile(profile) {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = profile.id + '.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

const inspectorSourceKeys = Object.freeze({
    'explicit scene or chapter selection': 'studio.writing.inspectorSourceExplicit',
    'scene tag': 'studio.writing.inspectorSourceSceneTag',
    'chapter tag': 'studio.writing.inspectorSourceChapterTag',
    'untagged candidate': 'studio.writing.inspectorSourceUntagged',
    priority: 'studio.writing.inspectorSourcePriority',
    'legacy Story Plan styleGuide': 'studio.writing.inspectorSourceLegacy',
    'matching style example': 'studio.writing.inspectorSourceExample',
    'explicit portrayal trigger': 'studio.writing.inspectorSourcePortrayalTrigger',
    'matching scene tag': 'studio.writing.inspectorSourceMatchingTag',
});

const inspectorExclusionKeys = Object.freeze({
    'explicitly disabled': 'studio.writing.inspectorExclusionDisabled',
    'excluded by scene tag': 'studio.writing.inspectorExclusionTag',
    'scene application limit reached': 'studio.writing.inspectorExclusionLimit',
    'scene cooldown active': 'studio.writing.inspectorExclusionCooldown',
    'required tags not present': 'studio.writing.inspectorExclusionMissingTag',
    'soft rule limit or context budget': 'studio.writing.inspectorExclusionRuleBudget',
    'context budget': 'studio.writing.inspectorExclusionBudget',
    'portrayal mention limit reached': 'studio.writing.inspectorExclusionPortrayalLimit',
    'portrayal cooldown active': 'studio.writing.inspectorExclusionPortrayalCooldown',
    'no portrayal trigger': 'studio.writing.inspectorExclusionNoTrigger',
});

function localizedInspectorSource(value) {
    return String(value ?? '').split(', ').map(item => inspectorSourceKeys[item] ? tr(inspectorSourceKeys[item]) : item).join(', ');
}

function localizedInspectorWarning(value) {
    const warning = String(value ?? '');
    let match = warning.match(/^Unknown style rule id: (.+)\.$/);
    if (match) return tr('studio.writing.inspectorWarningUnknownRule', { id: match[1] });
    match = warning.match(/^Unknown disabled style rule id: (.+)\.$/);
    if (match) return tr('studio.writing.inspectorWarningUnknownDisabledRule', { id: match[1] });
    match = warning.match(/^Invalid target override for (.+)\.$/);
    if (match) return tr('studio.writing.inspectorWarningInvalidOverride', { metric: match[1] });
    match = warning.match(/^Narrative Ledger is stale: (.+)$/);
    if (match) return tr('studio.writing.inspectorWarningLedgerStale', { reason: match[1] });
    if (warning === 'A prose-ratio target was omitted from the compiled context because of the context budget.') {
        return tr('studio.writing.inspectorWarningRatioBudget');
    }
    if (warning === 'The recent repetition guard was omitted because of the context budget.') {
        return tr('studio.writing.inspectorWarningRepetitionBudget');
    }
    if (warning === 'Required context exceeds the configured character budget; optional examples were removed first.') {
        return tr('studio.writing.inspectorWarningRequiredBudget');
    }
    return warning;
}

function inspectorDetails(compiled) {
    const reasons = compiled.reasons.map(item => '+ ' + item.id + ': ' + localizedInspectorSource(item.source)).join('\n');
    const exclusions = compiled.exclusions.map(item => '- ' + item.id + ': '
        + (inspectorExclusionKeys[item.reason] ? tr(inspectorExclusionKeys[item.reason]) : item.reason)).join('\n');
    const warnings = compiled.warnings.map(item => '! ' + localizedInspectorWarning(item)).join('\n');
    return [
        reasons && tr('studio.writing.inspectorSelected') + '\n' + reasons,
        exclusions && tr('studio.writing.inspectorExcluded') + '\n' + exclusions,
        warnings && tr('studio.writing.inspectorWarnings') + '\n' + warnings,
    ]
        .filter(Boolean).join('\n\n');
}

export function bindWritingControl(deps) {
    const {
        getChatState,
        getSettings,
        getPlan,
        getSelectedProgress,
        persistChat,
        persistSettings,
        syncWritingContext,
        assertSource,
        renderParent,
    } = deps;
    let criticChatId = '';

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
                console.error('[amy-studio-writing]', error);
                toastr.error(error.message, tr('studio.error.actionTitle'));
            } finally {
                setBusy(button, false);
            }
        });
    }

    function compile(profile = null, useSelectedFocus = true, state = getChatState()) {
        const reviewed = profile ?? normalizeWritingProfile(currentDraft(state)) ?? state.writingProfile;
        if (!reviewed) throw new Error(tr('studio.error.writingInvalid'));
        const includePlan = useSelectedFocus || state.storyPlanProgress?.active === true;
        return compileWritingContext({
            profile: reviewed,
            plan: includePlan ? state.storyPlan : null,
            progress: useSelectedFocus ? getSelectedProgress(true) : state.storyPlanProgress,
            ledger: state.narrativeLedger,
            expectedSceneWords: state.expectedSceneWords,
        });
    }

    async function saveCompiled(compiled) {
        const state = getChatState();
        state.compiledWritingContext = {
            text: compiled.text,
            reasons: compiled.reasons,
            exclusions: compiled.exclusions,
            warnings: compiled.warnings,
            sourceHash: compiled.sourceHash,
            estimatedTokens: compiled.estimatedTokens,
            includesFuture: false,
        };
        await persistChat({ immediate: true });
        await renderInspector(compiled);
    }

    async function renderInspector(compiled = null) {
        const state = getChatState();
        const result = compiled ?? state.compiledWritingContext;
        $('#amy-studio-writing-preview-text').text(result.text || tr('studio.writing.noPreview'));
        $('#amy-studio-writing-reasons').text(inspectorDetails(result));
        const meta = tr('studio.writing.inspectorMeta', {
            tokens: result.estimatedTokens || 0,
            chars: (result.text || '').length,
            future: tr('studio.writing.futureNo'),
            hash: result.sourceHash || '-',
        });
        $('#amy-studio-writing-inspector-meta').text(meta);
        if (result.text && result.sourceHash) {
            try {
                const tokens = await getTokenCountAsync(result.text);
                if (getChatState().compiledWritingContext.sourceHash === result.sourceHash) {
                    $('#amy-studio-writing-inspector-meta').text(tr('studio.writing.inspectorMeta', {
                        tokens: Math.max(0, Number(tokens) || 0),
                        chars: result.text.length,
                        future: tr('studio.writing.futureNo'),
                        hash: result.sourceHash,
                    }));
                }
            } catch {
                // The deterministic local estimate remains visible when the tokenizer is unavailable.
            }
        }
    }

    function renderTemplates() {
        const select = $('#amy-studio-writing-template').empty();
        select.append($('<option>').val('').text(tr('studio.writing.templateNone')));
        select.append($('<option>').val('__default').text(tr('studio.writing.templateDefault')));
        for (const profile of getSettings().writingProfileTemplates) {
            select.append($('<option>').val(profile.id).text(profile.name));
        }
    }

    function render() {
        const state = getChatState();
        const currentChatId = deps.getChatId();
        if (criticChatId && criticChatId !== currentChatId) {
            criticChatId = '';
            $('#amy-studio-writing-critic-report').text('');
        }
        renderTemplates();
        const raw = state.pendingWritingProfile
            || (state.writingProfile ? JSON.stringify(state.writingProfile, null, 2) : JSON.stringify(localizedDefaultWritingProfile(), null, 2));
        $('#amy-studio-writing-profile').val(raw);
        let draft = null;
        try {
            draft = normalizeWritingProfile(raw);
        } catch {
            draft = null;
        }
        updateSimpleFields(draft ?? state.writingProfile);
        $('#amy-studio-writing-scene-words').val(state.expectedSceneWords);
        let status = state.writingControlActive
            ? tr('studio.writing.active', { name: state.writingProfile?.name ?? '-' })
            : state.writingProfile
                ? tr('studio.writing.savedInactive', { name: state.writingProfile.name })
                : tr('studio.writing.unsaved');
        if (state.writingControlActive && state.compiledWritingContext.sourceHash) {
            const current = compileWritingContext({
                profile: state.writingProfile,
                plan: state.storyPlanProgress?.active ? getPlan() : null,
                progress: state.storyPlanProgress,
                ledger: state.narrativeLedger,
                expectedSceneWords: state.expectedSceneWords,
            });
            if (current.sourceHash !== state.compiledWritingContext.sourceHash) {
                status += ' ' + tr('studio.writing.contextStale');
            }
        }
        $('#amy-studio-writing-status').text(status);
        $('#amy-studio-writing-ledger').text(JSON.stringify(state.narrativeLedger, null, 2));
        void renderInspector();
    }

    function simpleChanged() {
        const state = getChatState();
        const base = normalizeWritingProfile(currentDraft(state)) ?? state.writingProfile ?? localizedDefaultWritingProfile();
        const profile = profileFromSimple(base);
        if (!profile) return;
        writeDraft(state, profile, 'simple-editor');
        persistChat();
    }

    $('#amy-studio-writing-template').on('change', function () {
        const selected = String($(this).val() ?? '');
        if (!selected) return;
        const profile = selected === '__default'
            ? localizedDefaultWritingProfile()
            : getSettings().writingProfileTemplates.find(item => item.id === selected);
        if (!profile) return;
        const state = getChatState();
        writeDraft(state, profile, selected);
        updateSimpleFields(profile);
        persistChat();
    });
    $('#amy-studio-writing-profile').on('input', function () {
        getChatState().pendingWritingProfile = String($(this).val() ?? '');
        persistChat();
    });
    $('#amy-studio-writing-name, #amy-studio-writing-language, #amy-studio-writing-pov, #amy-studio-writing-tense, #amy-studio-writing-distance, #amy-studio-writing-hard-rules, #amy-studio-writing-soft-rules, #amy-studio-writing-dialogue-min, #amy-studio-writing-dialogue-max, #amy-studio-writing-appearance, #amy-studio-writing-cooldown, #amy-studio-writing-example')
        .on('change', simpleChanged);
    $('#amy-studio-writing-scene-words').on('change', function () {
        const state = getChatState();
        state.expectedSceneWords = Math.min(5000, Math.max(200, Number($(this).val()) || 1100));
        $(this).val(state.expectedSceneWords);
        persistChat();
        deps.renderParent();
    });

    bindAction('#amy-studio-writing-default', async () => {
        const state = getChatState();
        const profile = localizedDefaultWritingProfile();
        writeDraft(state, profile, '__default');
        updateSimpleFields(profile);
        await persistChat({ immediate: true });
        toastr.success(tr('studio.toast.writingDraftLoaded'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-migrate', async () => {
        const migrated = migrateLegacyStyleGuide(getPlan());
        if (!migrated) throw new Error(tr('studio.error.writingNoLegacy'));
        migrated.name = tr('studio.writing.migrationProfileName');
        migrated.rules.forEach((rule, index) => {
            rule.label = tr('studio.writing.legacyRuleLabel', { index: index + 1 });
        });
        const state = getChatState();
        writeDraft(state, migrated, 'story-plan-style-guide');
        updateSimpleFields(migrated);
        await persistChat({ immediate: true });
        toastr.success(tr('studio.toast.writingMigrated'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-save', async () => {
        const state = getChatState();
        const result = validateWritingProfile(currentDraft(state));
        if (!result.valid) throw new Error(result.errors.join('\n'));
        const source = { chatId: deps.getChatId() };
        if (!source.chatId) throw new Error(tr('studio.error.openChatWriting'));
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.saveWritingTitle'),
            tr(deps.isCheckpoint() && state.writingControlActive
                ? 'studio.popup.saveWritingBranchBody'
                : 'studio.popup.saveWritingBody', { name: escapeHtml(result.profile.name) }),
        );
        if (!confirmed) return;
        assertSource(source);
        state.writingProfile = result.profile;
        state.pendingWritingProfile = JSON.stringify(result.profile, null, 2);
        if (state.writingControlActive) {
            const compiled = compile(result.profile, false, state);
            await syncWritingContext(compiled.text, source);
            assertSource(source);
            state.compiledWritingContext = compiled;
        }
        await persistChat({ immediate: true });
        deps.recordAudit('writing_profile_save', result.profile.id);
        renderParent();
        toastr.success(tr('studio.toast.writingSaved', { name: result.profile.name }), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-preview', async () => {
        const compiled = compile();
        await saveCompiled(compiled);
        deps.recordAudit('writing_context_compile', compiled.selectedRuleIds.length + ' rules');
        toastr.success(tr('studio.toast.writingCompiled'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-activate', async () => {
        const state = getChatState();
        if (!state.writingProfile) throw new Error(tr('studio.error.writingSaveFirst'));
        const source = { chatId: deps.getChatId() };
        if (!source.chatId) throw new Error(tr('studio.error.openChatWriting'));
        const compiled = compile(state.writingProfile, true, state);
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.activateWritingTitle'),
            tr(deps.isCheckpoint()
                ? 'studio.popup.activateWritingBranchBody'
                : 'studio.popup.activateWritingBody', { rules: compiled.selectedRuleIds.length }),
        );
        if (!confirmed) return;
        await syncWritingContext(compiled.text, source);
        assertSource(source);
        state.writingControlActive = true;
        if (state.storyPlan) state.storyPlanProgress = getSelectedProgress(true);
        state.compiledWritingContext = compiled;
        await persistChat({ immediate: true });
        deps.recordAudit('writing_context_activate', compiled.selectedRuleIds.length + ' rules');
        renderParent();
        toastr.success(tr('studio.toast.writingActivated'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-deactivate', async () => {
        const state = getChatState();
        if (!state.writingControlActive) {
            toastr.info(tr('studio.toast.writingAlreadyInactive'), tr('studio.error.actionTitle'));
            return;
        }
        const source = { chatId: deps.getChatId() };
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.deactivateWritingTitle'),
            tr(deps.isCheckpoint()
                ? 'studio.popup.deactivateWritingBranchBody'
                : 'studio.popup.deactivateWritingBody'),
        );
        if (!confirmed) return;
        await syncWritingContext('', source);
        assertSource(source);
        state.writingControlActive = false;
        if (state.storyPlanProgress) state.storyPlanProgress.active = false;
        await persistChat({ immediate: true });
        deps.recordAudit('writing_context_deactivate', 'retained reviewed data');
        renderParent();
        toastr.success(tr('studio.toast.writingDeactivated'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-reset-ledger', async () => {
        const state = getChatState();
        if (!state.narrativeLedger.stale) {
            toastr.info(tr('studio.toast.writingLedgerCurrent'), tr('studio.error.actionTitle'));
            return;
        }
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.resetWritingLedgerTitle'),
            tr('studio.popup.resetWritingLedgerBody'),
        );
        if (!confirmed) return;
        state.narrativeLedger = normalizeNarrativeLedger({
            chapterId: state.storyPlanProgress?.chapterId ?? '',
        });
        await persistChat({ immediate: true });
        deps.recordAudit('writing_ledger_reset', state.storyPlanProgress?.chapterId || '-');
        renderParent();
        toastr.success(tr('studio.toast.writingLedgerReset'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-save-template', async () => {
        const result = validateWritingProfile(currentDraft(getChatState()));
        if (!result.valid) throw new Error(result.errors.join('\n'));
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.saveWritingTemplateTitle'),
            tr('studio.popup.saveWritingTemplateBody', { name: escapeHtml(result.profile.name) }),
        );
        if (!confirmed) return;
        const settings = getSettings();
        settings.writingProfileTemplates = [
            ...settings.writingProfileTemplates.filter(item => item.id !== result.profile.id),
            result.profile,
        ].slice(-30);
        persistSettings();
        deps.recordAudit('writing_template_save', result.profile.id);
        renderTemplates();
        toastr.success(tr('studio.toast.writingTemplateSaved'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-export', async () => {
        const result = validateWritingProfile(currentDraft(getChatState()));
        if (!result.valid) throw new Error(result.errors.join('\n'));
        downloadProfile(result.profile);
    });
    bindAction('#amy-studio-writing-critic', async () => {
        const state = getChatState();
        if (!state.writingProfile) throw new Error(tr('studio.error.writingSaveFirst'));
        const prose = deps.getLatestAssistantText();
        if (!prose) throw new Error(tr('studio.error.writingNoProse'));
        const source = { chatId: deps.getChatId() };
        const prompt = writingCriticPrompt(prose, state.writingProfile, state.compiledWritingContext.text);
        const raw = await deps.runCodexText(prompt);
        assertSource(source);
        const report = normalizeWritingCriticReport(raw);
        if (!report) throw new Error(tr('studio.error.writingCriticInvalid'));
        criticChatId = source.chatId;
        $('#amy-studio-writing-critic-report').text(JSON.stringify(report, null, 2));
        deps.recordAudit(
            'writing_critic',
            (report.unnecessaryFactMentions.length + report.repeatedMotifs.length + report.ruleViolations.length) + ' findings',
        );
        toastr.success(tr('studio.toast.writingCriticReady'), tr('studio.error.actionTitle'));
    });
    bindAction('#amy-studio-writing-copy-critic', async () => {
        const report = text($('#amy-studio-writing-critic-report').text());
        if (!report) throw new Error(tr('studio.error.writingNoCritic'));
        await navigator.clipboard.writeText(report);
        toastr.success(tr('studio.toast.writingCriticCopied'), tr('studio.error.actionTitle'));
    });
    $('#amy-studio-writing-import').on('change', async function () {
        try {
            const file = this.files?.[0];
            if (!file) return;
            const raw = await file.text();
            const result = validateWritingProfile(raw);
            if (!result.valid) throw new Error(result.errors.join('\n'));
            const state = getChatState();
            writeDraft(state, result.profile, 'import:' + file.name.slice(0, 100));
            updateSimpleFields(result.profile);
            await persistChat({ immediate: true });
            deps.recordAudit('writing_profile_import', result.profile.id);
            toastr.success(tr('studio.toast.writingImported'), tr('studio.error.actionTitle'));
        } catch (error) {
            console.error('[amy-studio-writing]', error);
            toastr.error(error.message, tr('studio.error.actionTitle'));
        } finally {
            this.value = '';
        }
    });

    return { render, compile };
}
