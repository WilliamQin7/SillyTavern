/**
 * Decide whether opening a chat should bypass the duplicate-message guard and narrate its greeting.
 * @param {{ chatChanged: boolean, chatLength: number, narrateCharacterGreetings: boolean }} input
 * @returns {boolean}
 */
export function shouldForceNarrateCharacterGreeting(input) {
    return input.chatChanged === true
        && input.chatLength === 1
        && input.narrateCharacterGreetings === true;
}
