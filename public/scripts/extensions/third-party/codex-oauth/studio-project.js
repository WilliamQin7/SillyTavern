import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';
import { tr } from './i18n.js';
import {
    exportStoryProjectBundle,
    importStoryProjectBundle,
    readStoryProjectBundle,
} from './studio-project-portability.js';
import {
    assignStoryChat,
    editableSceneFromPlan,
    normalizeSceneBrief,
    normalizeStoryProject,
    normalizeStoryProjects,
    storyProjectStoryKey,
    unassignStoryChat,
    uniqueStoryProjectId,
    upsertStoryProject,
} from './studio-project-core.js';

function text(value) {
    return String(value ?? '').trim();
}

function lines(value) {
    return String(value ?? '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function sameData(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function downloadProject(project) {
    const settingsOnly = normalizeStoryProject({ ...project, stories: [] });
    const blob = new Blob([JSON.stringify(settingsOnly, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function storyProjectTabMarkup() {
    return '<button class="menu_button amy-studio-tab amy-studio-tab-primary" data-tab="scene" data-i18n="amyCreatorStudio.studio.tab.scene">Current scene</button>';
}

export function storyProjectAdvancedTabMarkup() {
    return '<button class="menu_button amy-studio-tab" data-tab="project" data-i18n="amyCreatorStudio.studio.tab.project">Projects</button>';
}

export function storyProjectMarkup() {
    return [
        '<div class="amy-studio-context-bar">',
        '<label><span data-i18n="amyCreatorStudio.studio.project.select">Project to review</span><select id="amy-studio-project-select" class="text_pole"></select></label>',
        '<small id="amy-studio-project-binding-status"></small>',
        '</div>',
        '<section data-amy-tab="scene" class="amy-studio-scene-workspace">',
        '<div class="amy-studio-scene-hero">',
        '<span class="amy-studio-eyebrow" data-i18n="amyCreatorStudio.studio.scene.eyebrow">Current scene workspace</span>',
        '<h3 id="amy-studio-scene-focus"></h3>',
        '<p id="amy-studio-scene-brief-preview" class="amy-studio-scene-brief-preview"></p>',
        '<small id="amy-studio-scene-brief-source"></small>',
        '<div class="amy-studio-primary-actions">',
        '<button id="amy-studio-scene-edit" class="menu_button amy-studio-primary-button" data-i18n="amyCreatorStudio.studio.scene.edit">Edit current scene</button>',
        '<button id="amy-studio-scene-prepare-write" class="menu_button amy-studio-primary-button" data-i18n="amyCreatorStudio.studio.scene.prepareWrite">Prepare and write</button>',
        '<button id="amy-studio-project-adjust-focus" class="menu_button" data-i18n="amyCreatorStudio.studio.project.adjustFocus">Adjust chapter / scene focus</button>',
        '</div>',
        '<small data-i18n="amyCreatorStudio.studio.scene.prepareWriteNote">Prepare and write refreshes the protected context, then places a prose request in the chat input for final review.</small>',
        '</div>',
        '<div class="amy-studio-scene-settings">',
        '<label><span data-i18n="amyCreatorStudio.studio.project.sceneTarget">Current scene target words</span><input id="amy-studio-project-scene-words" class="text_pole" type="number" min="200" max="5000"></label>',
        '<div id="amy-studio-scene-context-receipt" class="amy-studio-context-receipt"></div>',
        '</div>',
        '<small id="amy-studio-project-preparation-status"></small>',
        '<details class="amy-studio-secondary-panel"><summary data-i18n="amyCreatorStudio.studio.scene.technical">Preparation details</summary>',
        '<div class="flex-container"><button id="amy-studio-project-prepare" class="menu_button" data-i18n="amyCreatorStudio.studio.project.prepare">Prepare current chat for writing</button><button id="amy-studio-project-apply-capacity" class="menu_button" data-i18n="amyCreatorStudio.studio.project.applyCapacity">Apply recommended writing capacity</button><button id="amy-studio-project-stage-scene" class="menu_button" data-i18n="amyCreatorStudio.studio.project.stageScene">Put current scene request in the chat input</button></div>',
        '<small data-i18n="amyCreatorStudio.studio.project.prepareNote">One confirmation binds the chat, loads the project plot and Writing Profile when present, selects a valid current scene, and activates one deduplicated writing context. Character and World Info references remain reusable and are not copied.</small>',
        '<pre id="amy-studio-project-preparation-receipt" class="amy-studio-preparation-receipt"></pre>',
        '</details>',
        '</section>',
        '<section data-amy-tab="project" class="displayNone">',
        '<div class="amy-studio-section-heading"><div><span class="amy-studio-eyebrow" data-i18n="amyCreatorStudio.studio.project.eyebrow">Project assets</span><h3 data-i18n="amyCreatorStudio.studio.project.heading">Novel project settings</h3></div><div class="flex-container"><button id="amy-studio-project-bind" class="menu_button" data-i18n="amyCreatorStudio.studio.project.bind">Bind project to current chat</button><button id="amy-studio-project-unbind" class="menu_button" data-i18n="amyCreatorStudio.studio.project.unbind">Unbind current chat</button></div></div>',
        '<details open class="amy-studio-secondary-panel"><summary data-i18n="amyCreatorStudio.studio.project.basic">Basic information</summary>',
        '<div class="flex-container"><button id="amy-studio-project-new" class="menu_button" data-i18n="amyCreatorStudio.studio.project.new">New project</button><button id="amy-studio-project-duplicate" class="menu_button" data-i18n="amyCreatorStudio.studio.project.duplicate">Duplicate as draft</button><button id="amy-studio-project-save" class="menu_button amy-studio-primary-button" data-i18n="amyCreatorStudio.studio.project.save">Save reviewed project</button></div>',
        '<div class="amy-studio-writing-grid">',
        '<label><span data-i18n="amyCreatorStudio.studio.project.name">Project name</span><input id="amy-studio-project-name" class="text_pole"></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.project.tags">Tags</span><input id="amy-studio-project-tags" class="text_pole" data-i18n="[placeholder]amyCreatorStudio.studio.project.tagsPlaceholder"></label>',
        '</div>',
        '<label><span data-i18n="amyCreatorStudio.studio.project.description">Short description</span><textarea id="amy-studio-project-description" class="text_pole" rows="3"></textarea></label>',
        '<label><span data-i18n="amyCreatorStudio.studio.project.notes">Project notes</span><textarea id="amy-studio-project-notes" class="text_pole" rows="4"></textarea></label>',
        '</details>',
        '<details class="amy-studio-secondary-panel"><summary data-i18n="amyCreatorStudio.studio.project.references">Characters, worlds, and defaults</summary>',
        '<label><span data-i18n="amyCreatorStudio.studio.project.characters">Character references, one per line</span><textarea id="amy-studio-project-characters" class="text_pole" rows="5"></textarea></label>',
        '<small data-i18n="amyCreatorStudio.studio.project.charactersNote">Choose an existing character below, then save the reviewed project. Character cards remain reusable across projects.</small>',
        '<div class="flex-container"><select id="amy-studio-project-character-picker" class="text_pole"></select><button id="amy-studio-project-add-selected-character" class="menu_button" data-i18n="amyCreatorStudio.studio.project.addSelectedCharacter">Add selected character</button><button id="amy-studio-project-add-character" class="menu_button" data-i18n="amyCreatorStudio.studio.project.addCurrentCharacter">Add current character</button></div>',
        '<label><span data-i18n="amyCreatorStudio.studio.project.worlds">World Info references, one per line</span><textarea id="amy-studio-project-worlds" class="text_pole" rows="5"></textarea></label>',
        '<div class="flex-container"><select id="amy-studio-project-world-picker" class="text_pole"></select><button id="amy-studio-project-add-world" class="menu_button" data-i18n="amyCreatorStudio.studio.project.addWorld">Add selected World Info</button></div>',
        '<label><span data-i18n="amyCreatorStudio.studio.project.writingProfile">Default Writing Profile template (optional)</span><select id="amy-studio-project-writing-profile" class="text_pole"></select></label>',
        '<div class="flex-container"><button id="amy-studio-project-load-writing" class="menu_button" data-i18n="amyCreatorStudio.studio.project.loadWriting">Load template as review draft</button></div>',
        '</details>',
        '<details class="amy-studio-secondary-panel"><summary data-i18n="amyCreatorStudio.studio.project.plot">Reusable plot snapshot</summary>',
        '<div class="flex-container"><button id="amy-studio-project-capture-plan" class="menu_button" data-i18n="amyCreatorStudio.studio.project.capturePlan">Capture current Story Plan</button><button id="amy-studio-project-load-plan" class="menu_button" data-i18n="amyCreatorStudio.studio.project.loadPlan">Load project plot as review draft</button><button id="amy-studio-project-clear-plan" class="menu_button" data-i18n="amyCreatorStudio.studio.project.clearPlan">Clear plot snapshot</button></div>',
        '<small id="amy-studio-project-plan-status"></small>',
        '</details>',
        '<details class="amy-studio-secondary-panel"><summary data-i18n="amyCreatorStudio.studio.project.stories">Private generated stories</summary>',
        '<div id="amy-studio-project-stories" class="amy-studio-audit"></div>',
        '<small data-i18n="amyCreatorStudio.studio.project.storiesNote">Generated prose remains in SillyTavern native user chat files. The project stores only a private chat index; story text is not copied into extension source or Git.</small>',
        '</details>',
        '<details class="amy-studio-secondary-panel"><summary data-i18n="amyCreatorStudio.studio.project.portability">Migration and backup</summary><div class="flex-container">',
        '<button id="amy-studio-project-export" class="menu_button" data-i18n="amyCreatorStudio.studio.project.export">Export project settings</button>',
        '<button id="amy-studio-project-export-story" class="menu_button" data-i18n="amyCreatorStudio.studio.project.exportStory">Export story only</button>',
        '<button id="amy-studio-project-export-full" class="menu_button" data-i18n="amyCreatorStudio.studio.project.exportFull">Export full project</button>',
        '<label class="menu_button amy-studio-file-button"><span data-i18n="amyCreatorStudio.studio.project.import">Import project settings / portable package</span><input id="amy-studio-project-import" type="file" accept=".json,.zip,.amy-story.zip,application/json,application/zip"></label>',
        '<small data-i18n="amyCreatorStudio.studio.project.portabilityNote">Story-only packages contain native JSONL prose and minimal chapter metadata. Full packages also contain referenced character cards, World Info, groups, plot, and Writing Profile. Import creates copies and never overwrites local resources.</small>',
        '</div></details>',
        '<small data-i18n="amyCreatorStudio.studio.project.note">Projects organize reusable references and defaults; they do not own characters or World Info. The same resource may appear in several projects, and binding never injects or replaces content automatically.</small>',
        '</section>',
    ].join('');
}

export function bindStoryProject(deps) {
    let selectedId = '';
    let draftStoryPlan = null;
    let lastStoryKey = null;

    function projects() {
        return normalizeStoryProjects(deps.getSettings().storyProjects);
    }

    function selectedProject() {
        return projects().find(project => project.id === selectedId) ?? null;
    }

    function currentStory() {
        return { ...deps.getCurrentStory(), chatId: deps.getChatId() };
    }

    function currentStoryKey() {
        return storyProjectStoryKey(currentStory());
    }

    function fillFields(project = null) {
        renderWritingProfilePicker(project?.writingProfileId ?? '');
        $('#amy-studio-project-name').val(project?.name ?? '');
        $('#amy-studio-project-tags').val((project?.tags ?? []).join(', '));
        $('#amy-studio-project-description').val(project?.description ?? '');
        $('#amy-studio-project-characters').val((project?.characters ?? []).join('\n'));
        $('#amy-studio-project-worlds').val((project?.worlds ?? []).join('\n'));
        $('#amy-studio-project-writing-profile').val(project?.writingProfileId ?? '');
        $('#amy-studio-project-notes').val(project?.notes ?? '');
        draftStoryPlan = project?.storyPlan ? structuredClone(project.storyPlan) : null;
        renderPlanStatus();
    }

    function projectFromFields(existing = null) {
        const name = text($('#amy-studio-project-name').val());
        if (!name) return null;
        const characters = lines($('#amy-studio-project-characters').val()).map(ref => {
            if (deps.getCharacters().some(character => character.avatar === ref)) return ref;
            const matches = deps.getCharacters().filter(character => character.name === ref);
            return matches.length === 1 ? matches[0].avatar : ref;
        });
        return normalizeStoryProject({
            id: existing?.id || uniqueStoryProjectId(name, projects()),
            name,
            description: $('#amy-studio-project-description').val(),
            tags: String($('#amy-studio-project-tags').val() ?? '').split(/\r?\n|,/),
            characters,
            worlds: lines($('#amy-studio-project-worlds').val()),
            writingProfileId: $('#amy-studio-project-writing-profile').val(),
            stories: existing?.stories ?? [],
            notes: $('#amy-studio-project-notes').val(),
            storyPlan: draftStoryPlan,
        });
    }

    function renderSelect() {
        const select = $('#amy-studio-project-select').empty();
        select.append($('<option>').val('').text(tr('studio.project.newDraft')));
        for (const project of projects()) select.append($('<option>').val(project.id).text(project.name));
        select.val(selectedId);
    }

    function renderWorldPicker() {
        const select = $('#amy-studio-project-world-picker').empty();
        select.append($('<option>').val('').text(tr('studio.project.chooseWorld')));
        for (const name of deps.getWorldNames()) select.append($('<option>').val(name).text(name));
    }

    function renderCharacterPicker() {
        const select = $('#amy-studio-project-character-picker').empty();
        select.append($('<option>').val('').text(tr('studio.project.chooseCharacter')));
        const available = deps.getCharacters().filter(character => character?.name && character?.avatar);
        const nameCounts = new Map();
        for (const character of available) {
            nameCounts.set(character.name, (nameCounts.get(character.name) ?? 0) + 1);
        }
        for (const character of available) {
            const label = nameCounts.get(character.name) > 1
                ? `${character.name} · ${character.avatar}`
                : character.name;
            select.append($('<option>').val(character.avatar).text(label));
        }
    }

    function renderWritingProfilePicker(value = String($('#amy-studio-project-writing-profile').val() ?? '')) {
        const select = $('#amy-studio-project-writing-profile').empty();
        select.append($('<option>').val('').text(tr('studio.project.noWritingProfile')));
        const templates = deps.getSettings().writingProfileTemplates ?? [];
        for (const profile of templates) {
            select.append($('<option>').val(profile.id).text(profile.name));
        }
        if (value && !templates.some(profile => profile.id === value)) {
            select.append($('<option>').val(value).text(tr('studio.project.missingWritingProfile', { id: value })));
        }
        select.val(value);
    }

    function renderPlanStatus() {
        $('#amy-studio-project-plan-status').text(draftStoryPlan
            ? tr('studio.project.planSaved', { title: draftStoryPlan.title, count: draftStoryPlan.chapters.length })
            : tr('studio.project.planNone'));
    }

    function renderBindingStatus() {
        const state = deps.getChatState();
        const boundId = state.storyProjectId;
        const bound = projects().find(project => project.id === boundId);
        const status = !deps.getChatId()
            ? tr('studio.project.noChat')
            : bound
                ? tr('studio.project.bound', { name: bound.name })
                : boundId
                    ? tr('studio.project.boundMissing', { id: boundId })
                    : tr('studio.project.unbound');
        $('#amy-studio-project-binding-status').text(status);
    }

    function renderSceneWorkspace() {
        const project = selectedProject();
        const state = deps.getChatState();
        const chapter = state.storyPlan?.chapters.find(item => item.id === state.storyPlanProgress?.chapterId);
        const scene = chapter?.scenes.find(item => item.id === state.storyPlanProgress?.sceneId);
        const storedBrief = normalizeSceneBrief(state.sceneBrief);
        const brief = editableSceneFromPlan(chapter, scene, storedBrief);
        const hasEditedScene = Boolean(storedBrief.updatedAt)
            && storedBrief.chapterId === chapter?.id
            && storedBrief.sceneId === (scene?.id ?? '');
        $('#amy-studio-scene-focus').text(chapter
            ? `${chapter.title}${scene ? ` / ${scene.title}` : ''}`
            : tr('studio.scene.noFocus'));
        $('#amy-studio-scene-brief-preview').text(brief.summary || tr(hasEditedScene ? 'studio.scene.editedEmpty' : 'studio.scene.emptyBrief'));
        $('#amy-studio-scene-brief-source').text(chapter
            ? tr(hasEditedScene ? 'studio.scene.sourceEdited' : 'studio.scene.sourcePlan')
            : '');
        const receipt = $('#amy-studio-scene-context-receipt').empty();
        const relationships = state.storyState?.relationships ?? [];
        const items = [
            tr('studio.scene.receiptProject', { name: project?.name ?? tr('studio.project.optionalSkipped') }),
            tr('studio.scene.receiptCast', { value: brief.cast.length ? brief.cast.join(', ') : tr('studio.scene.auto') }),
            tr('studio.scene.receiptRelationships', {
                value: relationships.length
                    ? tr('studio.scene.currentCount', { count: relationships.length })
                    : tr('studio.scene.openingFallback'),
            }),
            tr('studio.scene.receiptRecent', { value: state.storyState?.scene?.summary ? tr('studio.scene.included') : tr('studio.scene.none') }),
            tr('studio.scene.receiptReferences', { count: state.sceneReferenceSnapshot?.length ?? 0 }),
        ];
        for (const item of items) $('<span>').addClass('amy-studio-context-chip').text(item).appendTo(receipt);
        const usable = Boolean(project && deps.getChatId());
        $('#amy-studio-scene-edit').prop('disabled', !usable || !chapter);
        $('#amy-studio-scene-prepare-write').prop('disabled', !usable);
    }

    function renderPreparationStatus() {
        const project = selectedProject();
        const state = deps.getChatState();
        const status = $('#amy-studio-project-preparation-status');
        if (!project || !deps.getChatId()) {
            status.attr('data-ready', 'false').text(tr('studio.project.prepareUnavailable'));
            $('#amy-studio-project-preparation-receipt').text('');
            $('#amy-studio-project-apply-capacity, #amy-studio-project-stage-scene, #amy-studio-scene-prepare-write').prop('disabled', true);
            return;
        }
        const bound = state.storyProjectId === project.id;
        const profile = (deps.getSettings().writingProfileTemplates ?? [])
            .find(item => item.id === project.writingProfileId);
        const planReady = !project.storyPlan
            || (sameData(state.storyPlan, project.storyPlan) && state.storyPlanProgress?.active === true);
        const profileReady = !project.writingProfileId
            || (state.writingControlActive === true && sameData(state.writingProfile, profile));
        const chapter = state.storyPlan?.chapters.find(item => item.id === state.storyPlanProgress?.chapterId);
        const scene = chapter?.scenes.find(item => item.id === state.storyPlanProgress?.sceneId);
        const verification = state.storyPreparationVerification ?? {};
        const expectedProofs = project.storyPlan || project.writingProfileId
            ? ['prompt-scan', 'protected-entry']
            : ['none'];
        const contextVerified = verification.projectId === project.id
            && (!project.storyPlan || (verification.chapterId === chapter?.id && verification.sceneId === (scene?.id ?? '')))
            && (!project.writingProfileId || verification.profileId === profile?.id)
            && expectedProofs.includes(verification.proof)
            && deps.isWritingContextFresh();
        const workflowReady = bound && planReady && profileReady && contextVerified;
        const capacity = deps.getGenerationReadiness();
        $('#amy-studio-project-scene-words').val(capacity.expectedSceneWords);
        const ready = workflowReady && capacity.ready;
        const statusKey = ready
            ? 'studio.project.prepareReady'
            : workflowReady
                ? 'studio.project.prepareCapacityPending'
                : 'studio.project.preparePending';
        status.attr('data-ready', ready ? 'true' : workflowReady ? 'warning' : 'false').text(tr(
            statusKey,
            {
                binding: tr(bound ? 'studio.project.readyYes' : 'studio.project.readyNo'),
                plan: tr(planReady ? 'studio.project.readyYes' : 'studio.project.readyNo'),
                profile: tr(profileReady ? 'studio.project.readyYes' : 'studio.project.readyNo'),
                context: tr(contextVerified ? 'studio.project.readyYes' : 'studio.project.readyNo'),
                focus: chapter
                    ? `${chapter.title}${scene ? ` / ${scene.title}` : ''}`
                    : tr('studio.project.optionalSkipped'),
                profileName: state.writingProfile?.name ?? tr('studio.project.optionalSkipped'),
                contextTokens: capacity.contextTokens,
                responseTokens: capacity.responseTokens,
                targetWords: capacity.expectedSceneWords,
                estimatedWords: capacity.estimatedOutputWords,
            },
        ));
        $('#amy-studio-project-preparation-receipt').text(tr('studio.project.preparationReceipt', {
            generationModel: deps.getGenerationModel(),
            assistantModel: deps.getAssistantModel(),
            focus: chapter
                ? `${chapter.title}${scene ? ` / ${scene.title}` : ''}`
                : tr('studio.project.optionalSkipped'),
            profileName: state.writingProfile?.name ?? tr('studio.project.optionalSkipped'),
            contextTokens: capacity.contextTokens,
            promptTokens: capacity.promptTokens,
            responseTokens: capacity.responseTokens,
            estimatedWords: capacity.estimatedOutputWords,
            targetWords: capacity.expectedSceneWords,
            compiledTokens: capacity.compiledContextTokens,
            worldInfoPercent: capacity.worldInfoPercent,
            worldInfoTokens: capacity.worldInfoTokens,
            characters: project.characters.length,
            worlds: project.worlds.length,
            proof: verification.proof
                ? tr(`studio.project.proof.${verification.proof}`)
                : tr('studio.project.readyNo'),
        }));
        $('#amy-studio-project-apply-capacity').prop('disabled', capacity.ready);
        $('#amy-studio-project-stage-scene').prop('disabled', !ready || !state.storyPlanProgress?.active);
        $('#amy-studio-scene-prepare-write').prop('disabled', false);
    }

    function renderStories() {
        const project = selectedProject();
        const container = $('#amy-studio-project-stories').empty();
        if (!project?.stories.length) {
            container.text(tr('studio.project.noStories'));
            return;
        }
        project.stories.forEach((story, index) => {
            const row = $('<div>').addClass('flex-container');
            $('<span>').text(`${story.title}${story.character ? ` · ${story.character}` : ''}\n${story.chatId}`).appendTo(row);
            $('<button>')
                .addClass('menu_button amy-studio-project-remove-story')
                .attr('data-story-index', index)
                .text(tr('studio.project.removeStory'))
                .appendTo(row);
            container.append(row);
        });
    }

    function render() {
        const storyKey = currentStoryKey();
        if (storyKey !== lastStoryKey) {
            lastStoryKey = storyKey;
            const boundId = deps.getChatState().storyProjectId;
            selectedId = projects().some(project => project.id === boundId) ? boundId : '';
            fillFields(selectedProject());
        } else if (selectedId && !selectedProject()) {
            selectedId = '';
            fillFields();
        }
        renderSelect();
        renderCharacterPicker();
        renderWorldPicker();
        renderWritingProfilePicker();
        renderPlanStatus();
        renderBindingStatus();
        renderSceneWorkspace();
        renderPreparationStatus();
        renderStories();
    }

    function appendUniqueLine(selector, value) {
        const current = lines($(selector).val());
        if (!current.some(item => item.toLocaleLowerCase() === value.toLocaleLowerCase())) current.push(value);
        $(selector).val(current.join('\n'));
    }

    function assertSameStory(storyKey) {
        if (storyKey !== currentStoryKey()) throw new Error(tr('studio.error.projectWrongChat'));
    }

    async function editCurrentSceneBrief() {
        const storyKey = currentStoryKey();
        const state = deps.getChatState();
        const chapter = state.storyPlan?.chapters.find(item => item.id === state.storyPlanProgress?.chapterId);
        const scene = chapter?.scenes.find(item => item.id === state.storyPlanProgress?.sceneId);
        if (!chapter) throw new Error(tr('studio.error.sceneFocusMissing'));
        const brief = editableSceneFromPlan(chapter, scene, state.sceneBrief);
        const editor = $([
            '<div class="amy-studio-scene-editor">',
            `<h3>${escapeHtml(tr('studio.scene.editorTitle', { focus: `${chapter.title}${scene ? ` / ${scene.title}` : ''}` }))}</h3>`,
            '<div class="amy-studio-scene-editor-intro">',
            `<p>${escapeHtml(tr('studio.scene.editorNote'))}</p>`,
            `<button type="button" class="menu_button amy-studio-scene-reload-plan">${escapeHtml(tr('studio.scene.reloadPlan'))}</button>`,
            '</div>',
            `<label>${escapeHtml(tr('studio.scene.summary'))}<textarea name="summary" class="text_pole" rows="6" placeholder="${escapeHtml(tr('studio.scene.summaryPlaceholder'))}"></textarea></label>`,
            '<div class="amy-studio-writing-grid">',
            `<label>${escapeHtml(tr('studio.scene.cast'))}<input name="cast" class="text_pole"></label>`,
            `<label>${escapeHtml(tr('studio.scene.time'))}<input name="time" class="text_pole"></label>`,
            `<label>${escapeHtml(tr('studio.scene.location'))}<input name="location" class="text_pole"></label>`,
            '</div>',
            `<label>${escapeHtml(tr('studio.scene.mustInclude'))}<textarea name="mustInclude" class="text_pole" rows="4"></textarea></label>`,
            `<label>${escapeHtml(tr('studio.scene.avoid'))}<textarea name="avoid" class="text_pole" rows="4"></textarea></label>`,
            `<label>${escapeHtml(tr('studio.scene.ending'))}<textarea name="ending" class="text_pole" rows="3"></textarea></label>`,
            '</div>',
        ].join(''));
        const fillEditor = value => {
            editor.find('[name="summary"]').val(value.summary);
            editor.find('[name="cast"]').val(value.cast.join(', '));
            editor.find('[name="time"]').val(value.time);
            editor.find('[name="location"]').val(value.location);
            editor.find('[name="mustInclude"]').val(value.mustInclude.join('\n'));
            editor.find('[name="avoid"]').val(value.avoid.join('\n'));
            editor.find('[name="ending"]').val(value.ending);
        };
        fillEditor(brief);
        editor.find('.amy-studio-scene-reload-plan').on('click', () => {
            fillEditor(editableSceneFromPlan(chapter, scene, null));
        });
        const popup = new Popup(editor, POPUP_TYPE.CONFIRM, '', {
            okButton: tr('studio.scene.save'),
            cancelButton: tr('studio.scene.cancel'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });
        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        assertSameStory(storyKey);
        const activeState = deps.getChatState();
        activeState.sceneBrief = normalizeSceneBrief({
            chapterId: chapter.id,
            sceneId: scene?.id ?? '',
            summary: editor.find('[name="summary"]').val(),
            cast: String(editor.find('[name="cast"]').val() ?? '').split(/\r?\n|,/),
            time: editor.find('[name="time"]').val(),
            location: editor.find('[name="location"]').val(),
            mustInclude: lines(editor.find('[name="mustInclude"]').val()),
            avoid: lines(editor.find('[name="avoid"]').val()),
            ending: editor.find('[name="ending"]').val(),
            updatedAt: new Date().toISOString(),
        });
        activeState.sceneReferenceSnapshot = [];
        activeState.storyPreparationVerification = {
            projectId: '', chapterId: '', sceneId: '', profileId: '', proof: '', verifiedAt: '',
        };
        await deps.persistChat({ immediate: true });
        assertSameStory(storyKey);
        deps.recordAudit('story_scene_brief_save', `${chapter.id}:${scene?.id ?? '-'}`);
        render();
        deps.renderParent();
        toastr.success(tr('studio.toast.sceneBriefSaved'), tr('studio.error.actionTitle'));
    }

    async function prepareSelectedProject({ stageRequest = false } = {}) {
        const project = selectedProject();
        if (!project) throw new Error(tr('studio.error.projectMissing'));
        const chatId = deps.getChatId();
        if (!chatId) throw new Error(tr('studio.error.openChatProject'));
        const storyKey = currentStoryKey();
        const profile = (deps.getSettings().writingProfileTemplates ?? [])
            .find(item => item.id === project.writingProfileId);
        if (project.writingProfileId && !profile) throw new Error(tr('studio.error.projectWritingMissing'));
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.prepareProjectTitle', { name: escapeHtml(project.name) }),
            tr('studio.popup.prepareProjectBody', {
                plan: project.storyPlan ? escapeHtml(project.storyPlan.title) : tr('studio.project.optionalSkipped'),
                profile: profile ? escapeHtml(profile.name) : tr('studio.project.optionalSkipped'),
            }),
        );
        if (!confirmed) return;
        assertSameStory(storyKey);
        const result = await deps.prepareCurrentChat(project);
        assertSameStory(storyKey);
        const settings = deps.getSettings();
        settings.storyProjects = assignStoryChat(settings.storyProjects, project.id, {
            ...currentStory(),
            chatId,
            linkedAt: new Date().toISOString(),
        });
        deps.persistSettings();
        deps.recordAudit('story_project_prepare', `${project.id}:${result.chapterId || '-'}:${result.profileId || '-'}`);
        const canStage = stageRequest && deps.getGenerationReadiness().ready && deps.isWritingContextFresh();
        if (canStage) {
            const request = deps.getCurrentSceneRequest();
            deps.stageCurrentSceneRequest(request);
            deps.recordAudit('story_scene_request_stage', text(chatId));
        }
        render();
        deps.renderParent();
        toastr.success(tr(canStage ? 'studio.toast.scenePreparedToWrite' : 'studio.toast.projectPrepared', {
            name: project.name,
            chapter: result.chapterTitle || tr('studio.project.optionalSkipped'),
        }), tr('studio.error.actionTitle'));
        if (stageRequest && !canStage) {
            toastr.warning(tr('studio.toast.scenePreparedCapacityPending'), tr('studio.error.actionTitle'));
        }
    }

    $('#amy-studio-project-select').on('change', function () {
        selectedId = String($(this).val() ?? '');
        fillFields(selectedProject());
        renderBindingStatus();
        renderSceneWorkspace();
        renderPreparationStatus();
        renderStories();
    });

    deps.bindAction('#amy-studio-project-new', async () => {
        selectedId = '';
        fillFields();
        renderSelect();
        toastr.info(tr('studio.toast.projectDraftNew'), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-duplicate', async () => {
        const project = selectedProject();
        if (!project) throw new Error(tr('studio.error.projectMissing'));
        selectedId = '';
        fillFields({ ...project, id: '', name: tr('studio.project.copyName', { name: project.name }) });
        renderSelect();
        toastr.info(tr('studio.toast.projectCopied'), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-add-character', async () => {
        const character = deps.getCurrentCharacter();
        if (!character?.name || !character.avatar) throw new Error(tr('studio.error.projectNoCharacter'));
        appendUniqueLine('#amy-studio-project-characters', character.avatar);
        toastr.info(tr('studio.toast.projectCharacterAdded', { name: character.name }), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-add-selected-character', async () => {
        const avatar = String($('#amy-studio-project-character-picker').val() ?? '');
        const character = deps.getCharacters().find(item => item?.avatar === avatar);
        if (!character?.name || !character.avatar) throw new Error(tr('studio.error.projectNoSelectedCharacter'));
        appendUniqueLine('#amy-studio-project-characters', character.avatar);
        toastr.info(tr('studio.toast.projectCharacterAdded', { name: character.name }), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-add-world', async () => {
        const name = String($('#amy-studio-project-world-picker').val() ?? '');
        if (!name) throw new Error(tr('studio.error.projectNoWorld'));
        appendUniqueLine('#amy-studio-project-worlds', name);
        toastr.info(tr('studio.toast.projectWorldAdded', { name }), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-capture-plan', async () => {
        const plan = deps.getPlan();
        if (!plan) throw new Error(tr('studio.error.projectCurrentPlanMissing'));
        draftStoryPlan = structuredClone(plan);
        renderPlanStatus();
        toastr.info(tr('studio.toast.projectPlanCaptured'), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-clear-plan', async () => {
        draftStoryPlan = null;
        renderPlanStatus();
        toastr.info(tr('studio.toast.projectPlanCleared'), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-save', async () => {
        const existing = selectedProject();
        const project = projectFromFields(existing);
        if (!project) throw new Error(tr('studio.error.projectName'));
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.saveProjectTitle', { name: escapeHtml(project.name) }),
            tr('studio.popup.saveProjectBody', { characters: project.characters.length, worlds: project.worlds.length, stories: project.stories.length }),
        );
        if (!confirmed) return;
        const settings = deps.getSettings();
        const result = upsertStoryProject(settings.storyProjects, project);
        if (!result.project) throw new Error(tr('studio.error.projectInvalid'));
        settings.storyProjects = result.projects;
        selectedId = result.project.id;
        fillFields(result.project);
        deps.persistSettings();
        deps.recordAudit('story_project_save', result.project.id);
        render();
        toastr.success(tr('studio.toast.projectSaved', { name: result.project.name }), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-bind', async () => {
        const project = selectedProject();
        if (!project) throw new Error(tr('studio.error.projectMissing'));
        const chatId = deps.getChatId();
        if (!chatId) throw new Error(tr('studio.error.openChatProject'));
        const storyKey = currentStoryKey();
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.bindProjectTitle', { name: escapeHtml(project.name) }),
            tr('studio.popup.bindProjectBody'),
        );
        if (!confirmed) return;
        assertSameStory(storyKey);
        const settings = deps.getSettings();
        settings.storyProjects = assignStoryChat(settings.storyProjects, project.id, {
            ...currentStory(),
            chatId,
            linkedAt: new Date().toISOString(),
        });
        deps.persistSettings();
        deps.getChatState().storyProjectId = project.id;
        await deps.persistChat({ immediate: true });
        assertSameStory(storyKey);
        deps.recordAudit('story_project_bind', project.id);
        render();
        toastr.success(tr('studio.toast.projectBound', { name: project.name }), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-prepare', () => prepareSelectedProject());
    deps.bindAction('#amy-studio-scene-prepare-write', () => prepareSelectedProject({ stageRequest: true }));
    deps.bindAction('#amy-studio-scene-edit', editCurrentSceneBrief);

    deps.bindAction('#amy-studio-project-adjust-focus', async () => {
        $('.amy-studio-tab[data-tab="plan"]').trigger('click');
        document.getElementById('amy-studio-plan-focus')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });

    $('#amy-studio-project-scene-words').on('change', async function () {
        const words = Math.min(5000, Math.max(200, Number($(this).val()) || 1100));
        $(this).val(words);
        try {
            await deps.setExpectedSceneWords(words);
            deps.renderParent();
        } catch (error) {
            console.error('[amy-studio] Failed to save the scene target', error);
            toastr.error(error.message, tr('studio.error.actionTitle'));
            render();
        }
    });

    deps.bindAction('#amy-studio-project-apply-capacity', async () => {
        const readiness = deps.getGenerationReadiness();
        if (readiness.ready) {
            toastr.info(tr('studio.toast.generationCapacityAlreadyReady'), tr('studio.error.actionTitle'));
            return;
        }
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.applyCapacityTitle'),
            tr('studio.popup.applyCapacityBody', {
                currentContext: readiness.contextTokens,
                currentResponse: readiness.responseTokens,
                context: Math.max(readiness.contextTokens, readiness.recommendedContextTokens),
                response: Math.max(readiness.responseTokens, readiness.recommendedResponseTokens),
                targetWords: readiness.expectedSceneWords,
            }),
        );
        if (!confirmed) return;
        const applied = deps.applyRecommendedGenerationCapacity(readiness);
        deps.recordAudit('story_generation_capacity', `${applied.contextTokens}/${applied.responseTokens}`);
        render();
        toastr.success(tr('studio.toast.generationCapacityApplied', {
            context: applied.contextTokens,
            response: applied.responseTokens,
        }), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-stage-scene', async () => {
        const request = deps.getCurrentSceneRequest();
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.stageSceneTitle'),
            tr('studio.popup.stageSceneBody', { request: escapeHtml(request) }),
        );
        if (!confirmed) return;
        deps.stageCurrentSceneRequest(request);
        deps.recordAudit('story_scene_request_stage', text(deps.getChatId()));
        toastr.success(tr('studio.toast.sceneRequestStaged'), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-unbind', async () => {
        const chatId = deps.getChatId();
        if (!chatId) throw new Error(tr('studio.error.openChatProject'));
        const storyKey = currentStoryKey();
        if (!deps.getChatState().storyProjectId) return;
        const confirmed = await Popup.show.confirm(tr('studio.popup.unbindProjectTitle'), tr('studio.popup.unbindProjectBody'));
        if (!confirmed) return;
        assertSameStory(storyKey);
        const settings = deps.getSettings();
        settings.storyProjects = unassignStoryChat(settings.storyProjects, currentStory());
        deps.persistSettings();
        deps.getChatState().storyProjectId = '';
        await deps.persistChat({ immediate: true });
        assertSameStory(storyKey);
        deps.recordAudit('story_project_unbind', chatId);
        render();
        toastr.success(tr('studio.toast.projectUnbound'), tr('studio.error.actionTitle'));
    });

    $('#amy-studio-project-stories').on('click', '.amy-studio-project-remove-story', async function () {
        const button = $(this).prop('disabled', true);
        try {
            const project = selectedProject();
            const index = Number(button.attr('data-story-index'));
            const story = project?.stories[index];
            if (!project || !story) throw new Error(tr('studio.error.projectMissing'));
            const confirmed = await Popup.show.confirm(
                tr('studio.popup.removeProjectStoryTitle'),
                tr('studio.popup.removeProjectStoryBody', { title: escapeHtml(story.title) }),
            );
            if (!confirmed) return;
            const activeStoryKey = currentStoryKey();
            const clearsCurrentBinding = storyProjectStoryKey(story) === activeStoryKey
                && deps.getChatState().storyProjectId === project.id;
            const settings = deps.getSettings();
            const result = upsertStoryProject(settings.storyProjects, {
                ...project,
                stories: project.stories.filter((_, storyIndex) => storyIndex !== index),
            });
            if (!result.project) throw new Error(tr('studio.error.projectInvalid'));
            settings.storyProjects = result.projects;
            deps.persistSettings();
            if (clearsCurrentBinding) {
                deps.getChatState().storyProjectId = '';
                await deps.persistChat({ immediate: true });
                assertSameStory(activeStoryKey);
            }
            deps.recordAudit('story_project_remove_story', `${project.id}:${story.chatId}`);
            render();
            toastr.success(tr('studio.toast.projectStoryRemoved'), tr('studio.error.actionTitle'));
        } catch (error) {
            toastr.error(error.message, tr('studio.error.actionTitle'));
        } finally {
            button.prop('disabled', false);
        }
    });

    deps.bindAction('#amy-studio-project-load-plan', async () => {
        const project = selectedProject();
        if (!project) throw new Error(tr('studio.error.projectMissing'));
        if (!project.storyPlan) throw new Error(tr('studio.error.projectPlanMissing'));
        const chatId = deps.getChatId();
        if (!chatId) throw new Error(tr('studio.error.openChatProject'));
        const storyKey = currentStoryKey();
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.loadProjectPlanTitle'),
            tr('studio.popup.loadProjectPlanBody', { title: escapeHtml(project.storyPlan.title) }),
        );
        if (!confirmed) return;
        assertSameStory(storyKey);
        deps.setPlanDraft(project.storyPlan);
        await deps.persistChat({ immediate: true });
        assertSameStory(storyKey);
        deps.recordAudit('story_project_plan_draft', project.id);
        deps.renderParent();
        toastr.success(tr('studio.toast.projectPlanLoaded'), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-load-writing', async () => {
        const project = selectedProject();
        if (!project) throw new Error(tr('studio.error.projectMissing'));
        const profile = (deps.getSettings().writingProfileTemplates ?? [])
            .find(item => item.id === project.writingProfileId);
        if (!profile) throw new Error(tr('studio.error.projectWritingMissing'));
        const chatId = deps.getChatId();
        if (!chatId) throw new Error(tr('studio.error.openChatProject'));
        const storyKey = currentStoryKey();
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.loadProjectWritingTitle'),
            tr('studio.popup.loadProjectWritingBody', { name: escapeHtml(profile.name) }),
        );
        if (!confirmed) return;
        assertSameStory(storyKey);
        const state = deps.getChatState();
        state.pendingWritingProfile = JSON.stringify(profile, null, 2);
        state.writingProfileSourceId = `project:${project.id}`;
        await deps.persistChat({ immediate: true });
        assertSameStory(storyKey);
        deps.recordAudit('story_project_writing_draft', project.id);
        deps.renderParent();
        toastr.success(tr('studio.toast.projectWritingLoaded'), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-export', async () => {
        const project = selectedProject();
        if (!project) throw new Error(tr('studio.error.projectMissing'));
        downloadProject(project);
    });

    deps.bindAction('#amy-studio-project-export-story', async () => {
        const project = selectedProject();
        if (!project) throw new Error(tr('studio.error.projectMissing'));
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.exportStoryProjectTitle', { name: escapeHtml(project.name) }),
            tr('studio.popup.exportStoryProjectBody', { stories: project.stories.length }),
        );
        if (!confirmed) return;
        await exportStoryProjectBundle(project, 'story_only', deps);
        deps.recordAudit('story_project_export_story', project.id);
        toastr.success(tr('studio.toast.projectStoryExported'), tr('studio.error.actionTitle'));
    });

    deps.bindAction('#amy-studio-project-export-full', async () => {
        const project = selectedProject();
        if (!project) throw new Error(tr('studio.error.projectMissing'));
        const confirmed = await Popup.show.confirm(
            tr('studio.popup.exportFullProjectTitle', { name: escapeHtml(project.name) }),
            tr('studio.popup.exportFullProjectBody', {
                stories: project.stories.length,
                characters: project.characters.length,
                worlds: project.worlds.length,
            }),
        );
        if (!confirmed) return;
        await exportStoryProjectBundle(project, 'full', deps);
        deps.recordAudit('story_project_export_full', project.id);
        toastr.success(tr('studio.toast.projectFullExported'), tr('studio.error.actionTitle'));
    });

    $('#amy-studio-project-import').on('change', async function () {
        try {
            const file = this.files?.[0];
            if (!file) return;
            if (/\.zip$/i.test(file.name)) {
                const bundle = await readStoryProjectBundle(file);
                const counts = bundle.manifest.assets;
                const confirmed = await Popup.show.confirm(
                    tr('studio.popup.importPortableProjectTitle', { name: escapeHtml(bundle.manifest.project.name) }),
                    tr(bundle.manifest.mode === 'full'
                        ? 'studio.popup.importPortableFullBody'
                        : 'studio.popup.importPortableStoryBody', {
                        stories: counts.stories.length,
                        characters: counts.characters.length,
                        worlds: counts.worlds.length,
                    }),
                );
                if (!confirmed) return;
                const imported = await importStoryProjectBundle(bundle, deps);
                const settings = deps.getSettings();
                const result = upsertStoryProject(settings.storyProjects, imported.project);
                if (!result.project) throw new Error(tr('studio.error.projectImportInvalid'));
                settings.storyProjects = result.projects;
                if (imported.profile) {
                    settings.writingProfileTemplates = [
                        ...(settings.writingProfileTemplates ?? []).filter(item => item.id !== imported.profile.id),
                        imported.profile,
                    ];
                }
                deps.persistSettings();
                selectedId = result.project.id;
                fillFields(result.project);
                render();
                deps.recordAudit('story_project_import_portable', result.project.id);
                toastr.success(tr('studio.toast.projectPortableImported', { name: result.project.name }), tr('studio.error.actionTitle'));
                return;
            }
            const project = normalizeStoryProject(await file.text());
            if (!project) throw new Error(tr('studio.error.projectImportInvalid'));
            selectedId = '';
            fillFields({ ...project, id: '', stories: [] });
            renderSelect();
            toastr.success(tr('studio.toast.projectImported'), tr('studio.error.actionTitle'));
        } catch (error) {
            toastr.error(error.message, tr('studio.error.actionTitle'));
        } finally {
            this.value = '';
        }
    });

    return { render };
}
