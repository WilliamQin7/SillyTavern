import { describe, expect, test } from '@jest/globals';

import { getTtsPlaybackControlState, TTS_PLAYBACK_ACTION, TtsPlaybackSession } from '../public/scripts/extensions/tts/playback-session.js';

describe('TTS playback controls', () => {
    test.each([
        [{ paused: false, playing: false, processing: false }, TTS_PLAYBACK_ACTION.PLAY, false],
        [{ paused: false, playing: true, processing: false }, TTS_PLAYBACK_ACTION.PAUSE, true],
        [{ paused: false, playing: false, processing: true }, TTS_PLAYBACK_ACTION.PAUSE, true],
        [{ paused: true, playing: false, processing: true }, TTS_PLAYBACK_ACTION.RESUME, true],
    ])('derives the action for %#', (state, action, isActive) => {
        expect(getTtsPlaybackControlState(state)).toEqual({ action, isActive });
    });
});

describe('TTS playback session', () => {
    test('invalidating a run aborts its request and rejects late results', () => {
        const session = new TtsPlaybackSession();
        const runId = session.runId;
        const controller = session.createAbortController();

        expect(session.isCurrent(runId)).toBe(true);
        session.invalidate();

        expect(controller.signal.aborted).toBe(true);
        expect(session.isCurrent(runId)).toBe(false);
    });

    test('starting a replacement request defensively aborts the stale controller', () => {
        const session = new TtsPlaybackSession();
        const first = session.createAbortController();
        const second = session.createAbortController();

        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(false);
    });

    test('releasing an old controller does not clear a newer request', () => {
        const session = new TtsPlaybackSession();
        const first = session.createAbortController();
        const second = session.createAbortController();

        session.releaseAbortController(first);
        session.invalidate();

        expect(second.signal.aborted).toBe(true);
    });
});
