import { Buffer } from 'node:buffer';

import { describe, expect, jest, test } from '@jest/globals';

import {
    buildMiMoTtsRequest,
    extractMiMoTtsAudio,
    fetchMiMoTtsResponse,
    getMiMoTtsContentType,
    getMiMoTtsErrorMessage,
    getMiMoTtsRetryDelay,
    MiMoTtsError,
} from '../src/mimo-tts.js';
import { splitMiMoTtsText } from '../public/scripts/extensions/tts/mimo-utils.js';

describe('Xiaomi MiMo TTS request handling', () => {
    test('builds the documented non-streaming chat-completions audio request', () => {
        expect(buildMiMoTtsRequest({
            text: ' 你好，世界。 ',
            voice: '冰糖',
            style: ' 温柔而自然地朗读。 ',
            model: 'mimo-v2.5-tts',
            format: 'mp3',
        })).toEqual({
            model: 'mimo-v2.5-tts',
            messages: [
                { role: 'user', content: '温柔而自然地朗读。' },
                { role: 'assistant', content: '你好，世界。' },
            ],
            audio: {
                format: 'mp3',
                voice: '冰糖',
            },
            stream: false,
        });
    });

    test('omits the optional style message when none is configured', () => {
        const request = buildMiMoTtsRequest({ text: 'Hello.', voice: 'Mia' });
        expect(request.messages).toEqual([{ role: 'assistant', content: 'Hello.' }]);
    });

    test('rejects empty text', () => {
        expect(() => buildMiMoTtsRequest({ text: '', voice: '冰糖' })).toThrow('Text is required.');
    });

    test('rejects unknown preset voices', () => {
        expect(() => buildMiMoTtsRequest({ text: 'hello', voice: 'unknown' })).toThrow('Unsupported MiMo preset voice.');
    });

    test('rejects unsupported models', () => {
        expect(() => buildMiMoTtsRequest({ text: 'hello', voice: 'Mia', model: 'mimo-v2-tts' })).toThrow('Unsupported MiMo TTS model.');
    });

    test('rejects unsupported formats', () => {
        expect(() => buildMiMoTtsRequest({ text: 'hello', voice: 'Mia', format: 'pcm' })).toThrow('Unsupported MiMo audio format.');
    });

    test('enforces the per-request limit by Unicode code point', () => {
        expect(() => buildMiMoTtsRequest({ text: '😀'.repeat(2_500), voice: 'Mia' })).not.toThrow();
        expect(() => buildMiMoTtsRequest({ text: '字'.repeat(2_501), voice: 'Mia' })).toThrow('Text must not exceed 2500 characters.');
    });

    test('decodes base64 audio without returning provider metadata', () => {
        const expected = Buffer.from('fake audio bytes');
        const payload = {
            choices: [{ message: { audio: { data: expected.toString('base64') } } }],
            usage: { total_tokens: 123 },
        };
        expect(extractMiMoTtsAudio(payload)).toEqual(expected);
    });

    test('rejects a response that contains no audio', () => {
        expect(() => extractMiMoTtsAudio({ choices: [] })).toThrow(MiMoTtsError);
    });

    test('maps supported formats to browser content types', () => {
        expect(getMiMoTtsContentType('mp3')).toBe('audio/mpeg');
        expect(getMiMoTtsContentType('wav')).toBe('audio/wav');
    });

    test('splits long text at natural boundaries without losing punctuation', () => {
        const input = `${'甲'.repeat(8)}。${'乙'.repeat(8)}！${'😀'.repeat(8)}`;
        const chunks = splitMiMoTtsText(input, 10);
        expect(chunks.every(chunk => Array.from(chunk).length <= 10)).toBe(true);
        expect(chunks.join('')).toBe(input);
    });

    test('uses Retry-After and bounds the retry delay', () => {
        const response = { headers: { get: () => '30' } };
        expect(getMiMoTtsRetryDelay(response, 0)).toBe(10_000);
    });

    test('retries documented transient statuses and keeps the key out of the body', async () => {
        const responses = [
            { ok: false, status: 429, headers: { get: () => null } },
            { ok: true, status: 200, headers: { get: () => null } },
        ];
        const fetchImpl = jest.fn(async (_url, options) => {
            expect(options.headers['api-key']).toBe('sk-test');
            expect(options.body).not.toContain('sk-test');
            return responses.shift();
        });
        const sleepImpl = jest.fn(async () => {});

        const response = await fetchMiMoTtsResponse({
            apiKey: 'sk-test',
            request: { model: 'mimo-v2.5-tts' },
            fetchImpl,
            sleepImpl,
        });

        expect(response.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleepImpl).toHaveBeenCalledWith(500);
    });

    test('does not retry permanent API errors', async () => {
        const response = { ok: false, status: 401, headers: { get: () => null } };
        const fetchImpl = jest.fn(async () => response);
        await expect(fetchMiMoTtsResponse({
            apiKey: 'sk-test',
            request: {},
            fetchImpl,
        })).resolves.toBe(response);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(getMiMoTtsErrorMessage(401)).toContain('invalid');
    });

    test('does not retry an ambiguous network failure', async () => {
        const fetchImpl = jest.fn(async () => {
            throw new Error('connection reset');
        });
        await expect(fetchMiMoTtsResponse({
            apiKey: 'sk-test',
            request: {},
            fetchImpl,
        })).rejects.toThrow('connection reset');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    test('passes external cancellation to the upstream request', async () => {
        const controller = new AbortController();
        let requestSignal;
        const fetchImpl = jest.fn(async (_url, options) => new Promise((_resolve, reject) => {
            requestSignal = options.signal;
            options.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        }));

        const request = fetchMiMoTtsResponse({
            apiKey: 'sk-test',
            request: {},
            fetchImpl,
            signal: controller.signal,
        });
        controller.abort();

        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        expect(requestSignal.aborted).toBe(true);
    });

    test('cancels immediately while waiting to retry', async () => {
        const controller = new AbortController();
        const response = { ok: false, status: 429, headers: { get: () => null }, body: { destroy: jest.fn() } };
        const fetchImpl = jest.fn(async () => response);
        const sleepImpl = jest.fn(async () => new Promise(() => {}));

        const request = fetchMiMoTtsResponse({
            apiKey: 'sk-test',
            request: {},
            fetchImpl,
            sleepImpl,
            signal: controller.signal,
        });
        await Promise.resolve();
        controller.abort();

        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(response.body.destroy).toHaveBeenCalledTimes(1);
    });
});
