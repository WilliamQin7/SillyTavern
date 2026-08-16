import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CodexProviderError } from './upstream/errors.js';

const CIPHER = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;
const SHARED_DISABLED_FILE_NAME = '.codex-oauth.shared-disabled';

function jwtExpiry(accessToken) {
    try {
        const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8'));
        return Number(payload?.exp ?? 0) * 1000;
    } catch {
        return 0;
    }
}

function lastRefreshExpiry(lastRefresh) {
    const refreshedAt = Date.parse(String(lastRefresh ?? ''));
    return Number.isFinite(refreshedAt) ? refreshedAt + 3_600_000 : 0;
}

/** Read-only adapter for an existing Codex Desktop/CLI sign-in. */
export class SharedCodexCredentialSource {
    constructor({ filePath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), logger = console } = {}) {
        this.filePath = filePath;
        this.logger = logger;
    }

    async read() {
        let text;
        try {
            text = await fs.readFile(this.filePath, 'utf8');
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            this.logger.warn?.('local Codex credential file could not be read');
            return null;
        }

        try {
            const document = JSON.parse(text);
            const tokens = document?.tokens && typeof document.tokens === 'object' ? document.tokens : document;
            if (!tokens?.access_token || !tokens?.refresh_token) return null;
            return {
                version: 1,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                idToken: tokens.id_token ?? '',
                expiresAt: jwtExpiry(tokens.access_token) || lastRefreshExpiry(document.last_refresh),
                accountId: tokens.account_id ?? '',
                credentialSource: 'codex-cli',
            };
        } catch {
            this.logger.warn?.('local Codex credential file has an unsupported format');
            return null;
        }
    }
}

/**
 * Encrypted server-only credential file. The key is derived from SillyTavern's
 * persistent cookie secret and a user-scoped associated-data value; OAuth
 * tokens are never saved in frontend settings or plaintext JSON.
 */
export class EncryptedCredentialStore {
    constructor({ filePath, masterSecret, identity }) {
        this.filePath = filePath;
        this.masterSecret = masterSecret;
        this.identity = identity;
        this.key = filePath;
    }

    #encryptionKey() {
        return crypto.createHash('sha256')
            .update('sillytavern-codex-oauth-v1\0')
            .update(String(this.masterSecret))
            .digest();
    }

    #aad() {
        return Buffer.from(`codex-oauth:${this.identity}`, 'utf8');
    }

    async read() {
        let text;
        try {
            text = await fs.readFile(this.filePath, 'utf8');
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw new CodexProviderError('CREDENTIAL_STORE_READ_FAILED', 'Could not read the encrypted ChatGPT credential store.', { status: 500, cause: error });
        }

        try {
            const envelope = JSON.parse(text);
            if (envelope?.version !== ENVELOPE_VERSION || envelope?.cipher !== CIPHER) throw new Error('Unsupported credential envelope');
            const decipher = crypto.createDecipheriv(CIPHER, this.#encryptionKey(), Buffer.from(envelope.iv, 'base64url'));
            decipher.setAAD(this.#aad());
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
            const clear = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]);
            const credentials = JSON.parse(clear.toString('utf8'));
            if (!credentials?.accessToken || !credentials?.refreshToken) throw new Error('Missing credential fields');
            return credentials;
        } catch (error) {
            throw new CodexProviderError('CREDENTIAL_STORE_UNREADABLE', 'Saved ChatGPT credentials could not be decrypted. Sign in again.', { status: 401, cause: error });
        }
    }

    async write(credentials) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(CIPHER, this.#encryptionKey(), iv);
        cipher.setAAD(this.#aad());
        const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const envelope = JSON.stringify({
            version: ENVELOPE_VERSION,
            cipher: CIPHER,
            iv: iv.toString('base64url'),
            tag: cipher.getAuthTag().toString('base64url'),
            ciphertext: ciphertext.toString('base64url'),
        });

        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            await fs.writeFile(temporary, envelope, { encoding: 'utf8', mode: 0o600 });
            await fs.rename(temporary, this.filePath);
            await fs.chmod(this.filePath, 0o600).catch(() => {});
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => {});
            throw new CodexProviderError('CREDENTIAL_STORE_WRITE_FAILED', 'Could not securely save ChatGPT credentials.', { status: 500, cause: error });
        }
    }

    async clear() {
        try {
            await fs.rm(this.filePath, { force: true });
        } catch (error) {
            throw new CodexProviderError('CREDENTIAL_STORE_CLEAR_FAILED', 'Could not remove saved ChatGPT credentials.', { status: 500, cause: error });
        }
    }
}

/**
 * Prefer SillyTavern's encrypted per-user copy, then read the machine owner's
 * Codex sign-in without ever modifying it. Refreshes are persisted only to the
 * encrypted primary store. A non-secret marker gives disconnect stable meaning.
 */
export class LayeredCredentialStore {
    constructor({ primary, shared = null, disabledFilePath }) {
        this.primary = primary;
        this.shared = shared;
        this.disabledFilePath = disabledFilePath ?? path.join(path.dirname(primary.filePath), SHARED_DISABLED_FILE_NAME);
        this.key = primary.key;
    }

    async #sharedDisabled() {
        if (!this.shared) return true;
        try {
            await fs.access(this.disabledFilePath);
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw new CodexProviderError('CREDENTIAL_STORE_READ_FAILED', 'Could not read the local Codex connection preference.', { status: 500, cause: error });
        }
    }

    async read() {
        const saved = await this.primary.read();
        if (saved) return { ...saved, credentialSource: saved.credentialSource || 'sillytavern' };
        if (await this.#sharedDisabled()) return null;
        return this.shared.read();
    }

    async write(credentials) {
        await this.primary.write(credentials);
        await fs.rm(this.disabledFilePath, { force: true }).catch(() => {});
    }

    async clear() {
        await this.primary.clear();
        if (!this.shared) return;
        await fs.mkdir(path.dirname(this.disabledFilePath), { recursive: true });
        await fs.writeFile(this.disabledFilePath, 'disabled\n', { encoding: 'utf8', mode: 0o600 });
        await fs.chmod(this.disabledFilePath, 0o600).catch(() => {});
    }

    async enableShared() {
        await fs.rm(this.disabledFilePath, { force: true });
        return this.read();
    }
}
