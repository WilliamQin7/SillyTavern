import { event_types, eventSource, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { registerExternalChatCompletionProvider } from '../../../chat-completion-provider-registry.js';
import { DEFAULT_PROVIDER_SETTINGS, loadProviderSettings, selectPreferredModel } from './state.js';
import { filterSafeTools, normalizeStudioSettings } from './studio-core.js';

const PROVIDER_ID = 'codex-oauth';
const API = `/api/plugins/${PROVIDER_ID}`;
let unregisterProvider = null;
let models = [];
let statusPoll = null;

function settingsFor() {
    return loadProviderSettings(extension_settings, oai_settings.codex_oauth);
}

function currentModel() {
    const provider = settingsFor();
    return provider.manualModel.trim() || provider.model;
}

function saveProviderSettings() {
    saveSettingsDebounced();
}

async function request(path, body = undefined, method = 'POST') {
    const response = await fetch(`${API}${path}`, {
        method,
        headers: getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-cache',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || response.statusText || 'Codex Provider request failed');
    return data;
}

function setStatus(status, error = '') {
    const authenticated = Boolean(status?.authenticated);
    const source = status?.credentialSource === 'codex-cli' ? ' · local Codex sign-in' : '';
    $('#codex-oauth-status').toggleClass('success', authenticated).toggleClass('failure', Boolean(error));
    $('#codex-oauth-status').text(error || (authenticated ? `● Signed in${source}` : '○ Not signed in'));
    $('#codex-oauth-login').toggle(!authenticated);
    $('#codex-oauth-logout').toggle(authenticated);
    $('#codex-oauth-refresh-auth').toggle(authenticated);
    $('#codex-oauth-test').prop('disabled', !authenticated);
}

async function refreshStatus() {
    try {
        const status = await request('/status', undefined, 'GET');
        setStatus(status);
        return status;
    } catch (error) {
        setStatus(null, '○ Server plugin inactive');
        return null;
    }
}

function modelById(id) {
    return models.find(model => model.id === id);
}

function renderReasoningOptions() {
    const provider = settingsFor();
    const selected = modelById(currentModel());
    const efforts = selected?.capabilities?.reasoningEfforts ?? [];
    const select = $('#codex-oauth-reasoning');
    select.empty().append(new Option('Auto (model default)', 'auto'));
    for (const effort of efforts) select.append(new Option(effort, effort));
    const supported = efforts.includes(provider.reasoningEffort);
    select.val(supported ? provider.reasoningEffort : 'auto');
    if (!supported) provider.reasoningEffort = 'auto';
    select.prop('disabled', efforts.length === 0);
    $('#codex-oauth-reasoning-note').text(efforts.length ? '' : 'No confirmed reasoning-effort metadata is bundled for this model. Manual values are still allowed.');
}

function renderSpeedMode() {
    const provider = settingsFor();
    const selected = modelById(currentModel());
    const supportsFast = selected?.capabilities?.fastMode === true;
    if (!supportsFast && provider.speedMode === 'fast') provider.speedMode = 'standard';
    $('#codex-oauth-speed').val(provider.speedMode).prop('disabled', !supportsFast);
    $('#codex-oauth-speed-note').text(supportsFast
        ? 'Fast uses the model priority service tier and may consume allowance more quickly.'
        : 'Fast mode is not advertised for this model.');
}

function renderModels() {
    const provider = settingsFor();
    const select = $('#codex-oauth-model');
    select.empty();
    for (const model of models) {
        const suffix = model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}k` : '';
        select.append(new Option(`${model.name}${suffix}`, model.id));
    }
    if (!provider.manualModel && (!provider.model || !models.some(model => model.id === provider.model))) {
        provider.model = selectPreferredModel(models);
    }
    select.val(provider.model);
    renderReasoningOptions();
    renderSpeedMode();
    saveProviderSettings();
}

async function refreshModels(force = true) {
    try {
        const result = await request('/models', { force });
        models = Array.isArray(result.data) ? result.data : [];
        renderModels();
    } catch (error) {
        toastr.warning(error.message, 'Codex models');
    }
}

function promptStructure(generateData) {
    if (oai_settings.chat_completion_source !== PROVIDER_ID || !settingsFor().showPromptStructure) return;
    const messages = Array.isArray(generateData?.messages) ? generateData.messages : [];
    const textLength = messages.reduce((total, message) => {
        if (typeof message?.content === 'string') return total + message.content.length;
        if (Array.isArray(message?.content)) return total + message.content.map(part => String(part?.text ?? '')).join('').length;
        return total;
    }, 0);
    const metadataFields = Object.keys(generateData ?? {}).filter(key => key !== 'messages' && key !== 'tools');
    const summary = {
        roles: messages.map(message => message.role),
        messageCount: messages.length,
        tokenEstimate: Math.ceil(textLength / 4),
        metadataFields,
        providerAddedVisibleTokens: 0,
    };
    $('#codex-oauth-prompt-debug').text(JSON.stringify(summary, null, 2)).show();
}

function createPanel() {
    if ($('#codex-oauth-form').length) return;
    const panel = $(
        `<section id="codex-oauth-form" data-source="${PROVIDER_ID}" class="codex-oauth-panel flex-container flexFlowColumn">
            <h4>Codex（ChatGPT）</h4>
            <div id="codex-oauth-status" class="codex-oauth-status">○ Not signed in</div>
            <div class="flex-container codex-oauth-actions">
                <button id="codex-oauth-login" type="button" class="menu_button">Sign in to ChatGPT</button>
                <button id="codex-oauth-logout" type="button" class="menu_button displayNone">Disconnect from SillyTavern</button>
                <button id="codex-oauth-refresh-auth" type="button" class="menu_button displayNone">Refresh sign-in</button>
            </div>
            <label>Model<select id="codex-oauth-model" class="text_pole wide100p"></select></label>
            <label>Manual model ID<input id="codex-oauth-manual-model" class="text_pole wide100p" autocomplete="off" placeholder="Optional model ID not present in the bundled list"></label>
            <label>Reasoning Effort<select id="codex-oauth-reasoning" class="text_pole wide100p"></select></label>
            <small id="codex-oauth-reasoning-note"></small>
            <label>Speed mode<select id="codex-oauth-speed" class="text_pole wide100p">
                <option value="standard">Standard</option>
                <option value="fast">Fast (higher allowance use)</option>
            </select></label>
            <small id="codex-oauth-speed-note"></small>
            <label>Log level<select id="codex-oauth-log-level" class="text_pole wide100p">
                <option value="brief">Brief (start, finish, error)</option>
                <option value="normal">Normal (major request stages)</option>
                <option value="detailed">Detailed (stream and transport stages)</option>
            </select></label>
            <div class="flex-container codex-oauth-actions">
                <button id="codex-oauth-models" type="button" class="menu_button">Reload models</button>
                <button id="codex-oauth-test" type="button" class="menu_button">Test connection</button>
            </div>
            <label class="checkbox_label"><input id="codex-oauth-debug" type="checkbox"><span>Show outgoing prompt structure</span></label>
            <small>For an admin user, an existing local Codex sign-in is reused automatically and never modified. Disconnecting affects SillyTavern only. No local agent prompt is added; prompts and generated images are never written to provider logs.</small>
            <pre id="codex-oauth-prompt-debug" class="displayNone"></pre>
        </section>`,
    );
    $('#chat_completion_source').after(panel);
    panel.toggle(oai_settings.chat_completion_source === PROVIDER_ID);

    $('#codex-oauth-login').on('click', async () => {
        try {
            const result = await request('/auth/login', {});
            if (result?.reused) {
                await refreshStatus();
                toastr.success('Reused the existing local Codex sign-in.', 'Codex');
                return;
            }
            toastr.info('The system browser is open. Status will update after ChatGPT sign-in completes.', 'Codex');
            clearInterval(statusPoll);
            let remaining = 150;
            statusPoll = setInterval(async () => {
                const status = await refreshStatus();
                if (status?.authenticated || --remaining <= 0) clearInterval(statusPoll);
            }, 2000);
        } catch (error) {
            toastr.error(error.message, 'Codex sign-in');
        }
    });
    $('#codex-oauth-logout').on('click', async () => {
        try {
            await request('/auth/logout', {});
            await refreshStatus();
        } catch (error) {
            toastr.error(error.message, 'Codex sign-out');
        }
    });
    $('#codex-oauth-refresh-auth').on('click', async () => {
        try {
            await request('/auth/refresh', {});
            await refreshStatus();
        } catch (error) {
            toastr.error(error.message, 'Codex refresh');
        }
    });
    $('#codex-oauth-models').on('click', () => refreshModels(true));
    $('#codex-oauth-model').on('change', function () {
        const provider = settingsFor();
        provider.model = String($(this).val() ?? '');
        provider.manualModel = '';
        $('#codex-oauth-manual-model').val('');
        renderReasoningOptions();
        renderSpeedMode();
        saveProviderSettings();
    });
    $('#codex-oauth-manual-model').on('input', function () {
        settingsFor().manualModel = String($(this).val() ?? '').trim();
        renderReasoningOptions();
        renderSpeedMode();
        saveProviderSettings();
    });
    $('#codex-oauth-reasoning').on('change', function () {
        settingsFor().reasoningEffort = String($(this).val() ?? 'auto');
        saveProviderSettings();
    });
    $('#codex-oauth-speed').on('change', function () {
        settingsFor().speedMode = String($(this).val() ?? 'standard');
        saveProviderSettings();
    });
    $('#codex-oauth-log-level').on('change', function () {
        settingsFor().logLevel = String($(this).val() ?? 'normal');
        saveProviderSettings();
    });
    $('#codex-oauth-debug').on('change', function () {
        settingsFor().showPromptStructure = Boolean($(this).prop('checked'));
        $('#codex-oauth-prompt-debug').toggle(settingsFor().showPromptStructure);
        saveProviderSettings();
    });
    $('#codex-oauth-test').on('click', async () => {
        try {
            const response = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    chat_completion_source: PROVIDER_ID,
                    model: currentModel(),
                    messages: [{ role: 'user', content: 'Reply exactly: OK' }],
                    stream: false,
                    codex_oauth: { logLevel: 'brief', speedMode: 'standard' },
                }),
            });
            const reply = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(reply?.error?.message || 'Connection test failed.');
            const text = reply?.choices?.[0]?.message?.content ?? '';
            if (String(text).trim() !== 'OK') throw new Error(`Unexpected response: ${String(text).slice(0, 80)}`);
            toastr.success('Codex connection test succeeded.', 'Codex');
        } catch (error) {
            toastr.error(error.message, 'Codex connection test');
        }
    });
}

function installProvider() {
    unregisterProvider?.();
    unregisterProvider = registerExternalChatCompletionProvider({
        id: PROVIDER_ID,
        capabilities: { tools: true, images: false, temperature: false },
        getModel: currentModel,
        configureRequest(generateData) {
            const provider = settingsFor();
            delete generateData.temperature;
            delete generateData.top_p;
            delete generateData.frequency_penalty;
            delete generateData.presence_penalty;
            delete generateData.logit_bias;
            const studio = normalizeStudioSettings(extension_settings.codex_oauth_studio);
            const safeTools = filterSafeTools(generateData.tools, studio.enableSafeTools, studio.safeToolNames);
            if (safeTools.length) {
                generateData.tools = safeTools;
                generateData.tool_choice = 'auto';
            } else {
                delete generateData.tools;
                delete generateData.tool_choice;
            }
            generateData.codex_oauth = {
                reasoningEffort: provider.reasoningEffort === 'auto' ? undefined : provider.reasoningEffort,
                speedMode: provider.speedMode,
                logLevel: provider.logLevel,
            };
        },
    });
}

export function initCodexOAuthProvider() {
    settingsFor();
    createPanel();
    installProvider();
    if (!$('#chat_completion_source option[value="codex-oauth"]').length) {
        const sourceGroup = $('#chat_completion_source optgroup').first();
        (sourceGroup.length ? sourceGroup : $('#chat_completion_source')).append(new Option('Codex（ChatGPT）', PROVIDER_ID));
    }
    const provider = settingsFor();
    $('#codex-oauth-manual-model').val(provider.manualModel);
    $('#codex-oauth-speed').val(provider.speedMode);
    $('#codex-oauth-log-level').val(provider.logLevel);
    $('#codex-oauth-debug').prop('checked', provider.showPromptStructure);
    saveProviderSettings();
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, promptStructure);
    refreshStatus();
    refreshModels(false);
    if (oai_settings.chat_completion_source === PROVIDER_ID) $('#chat_completion_source').val(PROVIDER_ID).trigger('change');
}

export { DEFAULT_PROVIDER_SETTINGS };
