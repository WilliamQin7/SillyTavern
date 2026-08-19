/* eslint-disable playwright/expect-expect */
import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldForceNarrateCharacterGreeting } from '../public/scripts/extensions/tts/auto-narration.js';

test('forces narration only for an enabled greeting in a newly opened one-message chat', () => {
    const shouldNarrate = (chatChanged, chatLength, enabled) => shouldForceNarrateCharacterGreeting({
        chatChanged,
        chatLength,
        narrateCharacterGreetings: enabled,
    });
    assert.equal(shouldNarrate(true, 1, true), true);
    assert.equal(shouldNarrate(true, 1, false), false);
    assert.equal(shouldNarrate(false, 1, true), false);
    assert.equal(shouldNarrate(true, 2, true), false);
});
