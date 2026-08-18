import { event_types, eventSource, getRequestHeaders } from '../../../script.js';
import { t, translate } from '../../i18n.js';
import { SECRET_KEYS, secret_state } from '../../secrets.js';
import { getPreviewString, saveTtsProviderSettings } from './index.js';
import { splitMiMoTtsText } from './mimo-utils.js';

export { MiMoTtsProvider };

class MiMoTtsProvider {
    settings;
    voices = [];
    separator = ' . ';
    audioElement = document.createElement('audio');

    defaultSettings = {
        voiceMap: {},
        model: 'mimo-v2.5-tts',
        format: 'mp3',
        style: '',
    };

    static voices = [
        { name: 'MiMo Default', voice_id: 'mimo_default', lang: 'zh-CN' },
        { name: '冰糖', voice_id: '冰糖', lang: 'zh-CN' },
        { name: '茉莉', voice_id: '茉莉', lang: 'zh-CN' },
        { name: '苏打', voice_id: '苏打', lang: 'zh-CN' },
        { name: '白桦', voice_id: '白桦', lang: 'zh-CN' },
        { name: 'Mia', voice_id: 'Mia', lang: 'en-US' },
        { name: 'Chloe', voice_id: 'Chloe', lang: 'en-US' },
        { name: 'Milo', voice_id: 'Milo', lang: 'en-US' },
        { name: 'Dean', voice_id: 'Dean', lang: 'en-US' },
    ];

    get settingsHtml() {
        return `
        <div class="mimo_tts_settings">
            <div class="tts_block justifyCenter">
                <div id="mimo_tts_key" class="menu_button menu_button_icon manage-api-keys" data-key="api_key_mimo_tts">
                    <i class="fa-solid fa-key"></i>
                    <span data-i18n="Set Xiaomi MiMo API Key">Set Xiaomi MiMo API Key</span>
                </div>
                <div id="mimo_tts_test" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-volume-high"></i>
                    <span data-i18n="Test connection">Test connection</span>
                </div>
            </div>
            <div class="tts_block">
                <label for="mimo_tts_model" data-i18n="Model">Model</label>
                <select id="mimo_tts_model" class="text_pole">
                    <option value="mimo-v2.5-tts">MiMo V2.5 TTS</option>
                </select>
            </div>
            <div class="tts_block">
                <label for="mimo_tts_format" data-i18n="Output format">Output format</label>
                <select id="mimo_tts_format" class="text_pole">
                    <option value="mp3">MP3</option>
                    <option value="wav">WAV</option>
                </select>
            </div>
            <div class="tts_block">
                <label for="mimo_tts_style" data-i18n="Speaking style (optional)">Speaking style (optional)</label>
                <textarea id="mimo_tts_style" class="text_pole" rows="3" maxlength="2000"
                    data-i18n="[placeholder]For example: Speak gently, slowly, with a slight smile."
                    placeholder="For example: Speak gently, slowly, with a slight smile."></textarea>
                <small data-i18n="Applied to every utterance. Character-specific emotion can still be inferred from the text.">Applied to every utterance. Character-specific emotion can still be inferred from the text.</small>
            </div>
            <div class="tts_block">
                <small data-i18n="Use a standard MiMo API key beginning with sk-. Token Plan keys (tp-) are not supported for this non-coding integration.">Use a standard MiMo API key beginning with sk-. Token Plan keys (tp-) are not supported for this non-coding integration.</small>
                <br>
                <small data-i18n="Long messages are automatically split at natural boundaries after 2,500 characters.">Long messages are automatically split at natural boundaries after 2,500 characters.</small>
                <br>
                <small data-i18n="The API key is stored only in SillyTavern's server-side secret store.">The API key is stored only in SillyTavern's server-side secret store.</small>
                <br>
                <a href="https://mimo.mi.com/docs/zh-CN/api/audio/tts" target="_blank" rel="noopener noreferrer" data-i18n="Official MiMo TTS documentation">Official MiMo TTS documentation</a>
                <details>
                    <summary data-i18n="Preset voice guide">Preset voice guide</summary>
                    <small data-i18n="Chinese: 冰糖 is lively, 茉莉 is intellectual, 苏打 is sunny, and 白桦 is mature. English: Mia is lively, Chloe is sweet, Milo is sunny, and Dean is steady and gentle.">Chinese: 冰糖 is lively, 茉莉 is intellectual, 苏打 is sunny, and 白桦 is mature. English: Mia is lively, Chloe is sweet, Milo is sunny, and Dean is steady and gentle.</small>
                    <br>
                    <small data-i18n="MiMo Default follows the current service region. Choose an explicit voice for consistent results.">MiMo Default follows the current service region. Choose an explicit voice for consistent results.</small>
                </details>
            </div>
        </div>`;
    }

    constructor() {
        this.secretHandler = (key) => {
            if (key !== SECRET_KEYS.MIMO_TTS) {
                return;
            }
            this.updateSecretState();
        };
    }

    dispose() {
        [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED].forEach(event => {
            eventSource.removeListener(event, this.secretHandler);
        });
        this.audioElement.pause();
    }

    async loadSettings(settings) {
        this.settings = structuredClone(this.defaultSettings);
        for (const key in settings) {
            if (key in this.settings) {
                this.settings[key] = settings[key];
            }
        }

        $('#mimo_tts_model').val(this.settings.model).on('change', () => this.onSettingsChange());
        $('#mimo_tts_format').val(this.settings.format).on('change', () => this.onSettingsChange());
        $('#mimo_tts_style').val(this.settings.style).on('input', () => this.onSettingsChange());
        $('#mimo_tts_test').on('click', () => this.testConnection());

        this.updateSecretState();
        [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED].forEach(event => {
            eventSource.on(event, this.secretHandler);
        });

        await this.checkReady();
    }

    updateSecretState() {
        $('#mimo_tts_key').toggleClass('success', !!secret_state[SECRET_KEYS.MIMO_TTS]);
    }

    onSettingsChange() {
        this.settings.model = String($('#mimo_tts_model').val());
        this.settings.format = String($('#mimo_tts_format').val());
        this.settings.style = String($('#mimo_tts_style').val());
        saveTtsProviderSettings();
    }

    async checkReady() {
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        await this.checkReady();
    }

    async fetchTtsVoiceObjects() {
        return structuredClone(MiMoTtsProvider.voices);
    }

    async getVoice(voiceName) {
        if (!this.voices.length) {
            await this.checkReady();
        }
        const voice = this.voices.find(item => item.name === voiceName);
        if (!voice) {
            throw new Error(`TTS voice ${voiceName} not found`);
        }
        return voice;
    }

    async* generateTts(text, voiceId, _voiceMapKey = null, { signal } = {}) {
        const chunks = splitMiMoTtsText(text);
        for (const chunk of chunks) {
            if (signal?.aborted) {
                return;
            }
            yield await this.fetchTtsGeneration(chunk, voiceId, signal);
        }
    }

    async previewTtsVoice(voiceId) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        const voice = MiMoTtsProvider.voices.find(item => item.voice_id === voiceId);
        const response = await this.fetchTtsGeneration(getPreviewString(voice?.lang ?? 'zh-CN'), voiceId);
        const audio = await response.blob();
        const url = URL.createObjectURL(audio);
        this.audioElement.src = url;
        try {
            await new Promise((resolve, reject) => {
                this.audioElement.onended = resolve;
                this.audioElement.onerror = () => reject(new Error('Unable to play the MiMo TTS preview.'));
                this.audioElement.play().catch(reject);
            });
        } finally {
            this.audioElement.removeAttribute('src');
            this.audioElement.load();
            URL.revokeObjectURL(url);
        }
    }

    async testConnection() {
        const button = $('#mimo_tts_test');
        if (button.hasClass('disabled')) {
            return;
        }
        button.addClass('disabled');
        try {
            await this.previewTtsVoice('mimo_default');
            toastr.success(t`Xiaomi MiMo TTS connection succeeded.`);
        } catch (error) {
            // fetchTtsGeneration already presents provider errors to the user.
            console.warn('Xiaomi MiMo TTS connection test failed:', error?.message ?? error);
        } finally {
            button.removeClass('disabled');
        }
    }

    async fetchTtsGeneration(text, voiceId, signal = undefined) {
        if (!secret_state[SECRET_KEYS.MIMO_TTS]) {
            const message = t`Set a Xiaomi MiMo API key before generating speech.`;
            toastr.error(message, t`TTS Generation Failed`);
            throw new Error(message);
        }

        const response = await fetch('/api/speech/mimo/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            signal,
            body: JSON.stringify({
                text,
                voice: voiceId,
                model: this.settings.model,
                format: this.settings.format,
                style: this.settings.style,
            }),
        });

        if (!response.ok) {
            let message = response.statusText || `HTTP ${response.status}`;
            try {
                const payload = await response.json();
                message = translate(payload.error || message);
            } catch {
                // Keep the status message when the server did not return JSON.
            }
            toastr.error(message, t`TTS Generation Failed`);
            throw new Error(`HTTP ${response.status}: ${message}`);
        }

        return response;
    }
}
