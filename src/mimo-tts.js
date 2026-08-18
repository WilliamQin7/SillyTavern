import { Buffer } from 'node:buffer';

export const MIMO_TTS_MODELS = Object.freeze([
    'mimo-v2.5-tts',
]);

export const MIMO_TTS_VOICES = Object.freeze([
    'mimo_default',
    '冰糖',
    '茉莉',
    '苏打',
    '白桦',
    'Mia',
    'Chloe',
    'Milo',
    'Dean',
]);

export const MIMO_TTS_FORMATS = Object.freeze([
    'mp3',
    'wav',
]);

export const MIMO_TTS_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
export const MIMO_TTS_MAX_TEXT_LENGTH = 2_500;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_STYLE_LENGTH = 2_000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

/**
 * Error raised for invalid MiMo TTS input or output.
 */
export class MiMoTtsError extends Error {
    /**
     * @param {string} message Error message
     * @param {number} [status=400] HTTP status code
     */
    constructor(message, status = 400) {
        super(message);
        this.name = 'MiMoTtsError';
        this.status = status;
    }
}

/**
 * Builds a Xiaomi MiMo chat-completions audio request.
 * @param {object} options Request options
 * @param {string} options.text Text to synthesize
 * @param {string} options.voice Preset voice ID
 * @param {string} [options.style] Natural-language speaking direction
 * @param {string} [options.model] MiMo model ID
 * @param {string} [options.format] Audio format
 * @returns {object} Validated provider request body
 */
export function buildMiMoTtsRequest({ text, voice, style = '', model = MIMO_TTS_MODELS[0], format = 'mp3' }) {
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    const normalizedStyle = typeof style === 'string' ? style.trim() : '';

    if (!normalizedText) {
        throw new MiMoTtsError('Text is required.');
    }
    if (Array.from(normalizedText).length > MIMO_TTS_MAX_TEXT_LENGTH) {
        throw new MiMoTtsError(`Text must not exceed ${MIMO_TTS_MAX_TEXT_LENGTH} characters.`);
    }
    if (normalizedStyle.length > MAX_STYLE_LENGTH) {
        throw new MiMoTtsError(`Speaking style must not exceed ${MAX_STYLE_LENGTH} characters.`);
    }
    if (!MIMO_TTS_MODELS.includes(model)) {
        throw new MiMoTtsError('Unsupported MiMo TTS model.');
    }
    if (!MIMO_TTS_VOICES.includes(voice)) {
        throw new MiMoTtsError('Unsupported MiMo preset voice.');
    }
    if (!MIMO_TTS_FORMATS.includes(format)) {
        throw new MiMoTtsError('Unsupported MiMo audio format.');
    }

    const messages = [];
    if (normalizedStyle) {
        messages.push({ role: 'user', content: normalizedStyle });
    }
    messages.push({ role: 'assistant', content: normalizedText });

    return {
        model,
        messages,
        audio: {
            format,
            voice,
        },
        stream: false,
    };
}

/**
 * Returns a stable, localizable message for a MiMo API status code.
 * @param {number} status HTTP status code
 * @returns {string} User-facing error message
 */
export function getMiMoTtsErrorMessage(status) {
    switch (status) {
        case 400:
            return 'Xiaomi MiMo rejected the TTS request.';
        case 401:
            return 'Xiaomi MiMo API key is invalid or does not match this API.';
        case 402:
            return 'Xiaomi MiMo account balance is insufficient.';
        case 403:
            return 'Xiaomi MiMo denied this request for the account or region.';
        case 421:
            return 'Xiaomi MiMo blocked the text under its content policy.';
        case 429:
            return 'Xiaomi MiMo rate limit or quota was reached. Please try again shortly.';
        case 500:
        case 503:
            return 'Xiaomi MiMo TTS is temporarily unavailable. Please try again shortly.';
        default:
            return 'Xiaomi MiMo TTS request failed.';
    }
}

/**
 * Gets the bounded retry delay for a retryable MiMo response.
 * @param {Response} response Provider response
 * @param {number} attempt Zero-based attempt number
 * @returns {number} Delay in milliseconds
 */
export function getMiMoTtsRetryDelay(response, attempt) {
    const retryAfterHeader = response.headers?.get?.('retry-after');
    const retryAfter = Number(retryAfterHeader);
    if (retryAfterHeader !== null && retryAfterHeader !== undefined && retryAfterHeader !== '' && Number.isFinite(retryAfter) && retryAfter >= 0) {
        return Math.min(retryAfter * 1_000, MAX_RETRY_DELAY_MS);
    }
    if (retryAfterHeader) {
        const retryAt = Date.parse(retryAfterHeader);
        if (Number.isFinite(retryAt)) {
            return Math.min(Math.max(retryAt - Date.now(), 0), MAX_RETRY_DELAY_MS);
        }
    }
    return Math.min(500 * (2 ** attempt), MAX_RETRY_DELAY_MS);
}

/**
 * Waits for a retry delay while remaining responsive to external cancellation.
 * @param {number} delay Delay in milliseconds
 * @param {(delay: number) => Promise<void>} sleepImpl Delay implementation
 * @param {AbortSignal} [signal] External cancellation signal
 * @returns {Promise<void>}
 */
async function waitForMiMoTtsRetry(delay, sleepImpl, signal) {
    signal?.throwIfAborted();
    if (!signal) {
        await sleepImpl(delay);
        return;
    }

    let abortHandler;
    const abortPromise = new Promise((_, reject) => {
        abortHandler = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        signal.addEventListener('abort', abortHandler, { once: true });
    });
    try {
        await Promise.race([sleepImpl(delay), abortPromise]);
    } finally {
        signal.removeEventListener('abort', abortHandler);
    }
}

/**
 * Sends a MiMo TTS request with bounded retries for documented transient errors.
 * Network and timeout errors are not retried because the provider may already have
 * accepted the synthesis request.
 * @param {object} options Request options
 * @param {string} options.apiKey Standard MiMo API key
 * @param {object} options.request Validated request body
 * @param {typeof fetch} options.fetchImpl Fetch implementation
 * @param {(delay: number) => Promise<void>} [options.sleepImpl] Delay implementation
 * @param {number} [options.timeoutMs] Total request timeout
 * @param {number} [options.maxAttempts] Maximum number of attempts
 * @param {AbortSignal} [options.signal] External cancellation signal
 * @returns {Promise<Response>} Provider response
 */
export async function fetchMiMoTtsResponse({
    apiKey,
    request,
    fetchImpl,
    sleepImpl = delay => new Promise(resolve => setTimeout(resolve, delay)),
    timeoutMs = 120_000,
    maxAttempts = 3,
    signal = undefined,
}) {
    const startedAt = Date.now();
    let response;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
            const error = new Error('Xiaomi MiMo TTS request timed out.');
            error.name = 'TimeoutError';
            throw error;
        }

        const timeoutSignal = AbortSignal.timeout(remainingMs);
        const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        response = await fetchImpl(MIMO_TTS_ENDPOINT, {
            method: 'POST',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
            signal: requestSignal,
        });

        const hasAnotherAttempt = attempt + 1 < maxAttempts;
        if (response.ok || !RETRYABLE_STATUS_CODES.has(response.status) || !hasAnotherAttempt) {
            return response;
        }

        const delay = getMiMoTtsRetryDelay(response, attempt);
        if (delay >= timeoutMs - (Date.now() - startedAt)) {
            return response;
        }
        response.body?.destroy?.();
        await waitForMiMoTtsRetry(delay, sleepImpl, signal);
    }

    return response;
}

/**
 * Decodes a non-streaming Xiaomi MiMo TTS response.
 * @param {object} payload Provider JSON response
 * @returns {Buffer} Decoded audio
 */
export function extractMiMoTtsAudio(payload) {
    const data = payload?.choices?.[0]?.message?.audio?.data;
    if (typeof data !== 'string' || !data.length) {
        throw new MiMoTtsError('MiMo returned no audio data.', 502);
    }

    const audio = Buffer.from(data, 'base64');
    if (!audio.length) {
        throw new MiMoTtsError('MiMo returned invalid audio data.', 502);
    }
    if (audio.length > MAX_AUDIO_BYTES) {
        throw new MiMoTtsError('MiMo audio response is too large.', 502);
    }

    return audio;
}

/**
 * Gets the browser content type for a supported MiMo audio format.
 * @param {string} format Audio format
 * @returns {string} MIME type
 */
export function getMiMoTtsContentType(format) {
    if (format === 'wav') {
        return 'audio/wav';
    }
    if (format === 'mp3') {
        return 'audio/mpeg';
    }
    throw new MiMoTtsError('Unsupported MiMo audio format.');
}
