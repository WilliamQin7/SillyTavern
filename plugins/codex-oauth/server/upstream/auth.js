import { extractAccountId } from './oauth.js';

/** Opens the user\'s configured system browser without exposing OAuth data to the frontend. */
export async function openSystemBrowser(url) {
    const { default: open } = await import('open');
    await open(url);
}

/** @param {{access_token: string, refresh_token: string, id_token?: string, expires_in?: number}} tokens */
export function credentialsFromTokenResponse(tokens, now = Date.now()) {
    return {
        version: 1,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token ?? '',
        expiresAt: now + Number(tokens.expires_in ?? 3600) * 1000,
        accountId: extractAccountId(tokens) ?? '',
    };
}
