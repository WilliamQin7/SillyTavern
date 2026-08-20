import { Cursor } from '@cursor/sdk';

const current = await Cursor.auth.status();

if (current.status === 'logged-in') {
    const expiresAt = current.apiKeyExpiresAtMs
        ? new Date(current.apiKeyExpiresAtMs).toISOString()
        : 'unknown';
    console.log(`Cursor SDK login already available (expires: ${expiresAt}).`);
    process.exit(0);
}

console.log('Opening Cursor sign-in in your browser. The API key itself will not be printed.');

const result = await Cursor.auth.login({
    apiKeyName: 'SillyTavern Cursor Grok Bridge',
    onLoginUrl: (url) => console.log(`If the browser does not open, visit: ${url}`),
});

console.log(`Cursor SDK login saved (expires: ${new Date(result.apiKeyExpiresAtMs).toISOString()}).`);
