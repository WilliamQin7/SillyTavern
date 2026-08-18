export const TTS_PLAYBACK_ACTION = Object.freeze({
    PLAY: 'play',
    PAUSE: 'pause',
    RESUME: 'resume',
});

/**
 * Derives the visible controls from the TTS playback state.
 * @param {object} state Playback state
 * @param {boolean} state.paused Whether playback is explicitly paused
 * @param {boolean} state.playing Whether an audio element is playing
 * @param {boolean} state.processing Whether generation or queued audio is active
 * @returns {{action: string, isActive: boolean}} Control state
 */
export function getTtsPlaybackControlState({ paused, playing, processing }) {
    const isActive = paused || playing || processing;
    const action = paused
        ? TTS_PLAYBACK_ACTION.RESUME
        : (isActive ? TTS_PLAYBACK_ACTION.PAUSE : TTS_PLAYBACK_ACTION.PLAY);
    return { action, isActive };
}

/**
 * Tracks one logical TTS playback run and its active cancellable request.
 * Incrementing the run ID makes late results from older async providers safe to ignore.
 */
export class TtsPlaybackSession {
    #runId = 0;
    #activeController = null;

    /** @returns {number} Current playback run ID. */
    get runId() {
        return this.#runId;
    }

    /**
     * Checks whether an async result still belongs to the active playback run.
     * @param {number} runId Playback run ID
     * @returns {boolean} Whether the run is still current
     */
    isCurrent(runId) {
        return runId === this.#runId;
    }

    /**
     * Creates the AbortController for the current provider request.
     * Only one TTS job is processed at a time, so a previous controller is stale.
     * @returns {AbortController} Request controller
     */
    createAbortController() {
        this.#activeController?.abort();
        this.#activeController = new AbortController();
        return this.#activeController;
    }

    /**
     * Releases a completed controller without clearing a newer request.
     * @param {AbortController} controller Completed request controller
     * @returns {void}
     */
    releaseAbortController(controller) {
        if (controller === this.#activeController) {
            this.#activeController = null;
        }
    }

    /**
     * Invalidates all work from the current run and aborts its active request.
     * @returns {number} New playback run ID
     */
    invalidate() {
        this.#runId++;
        this.#activeController?.abort();
        this.#activeController = null;
        return this.#runId;
    }
}
