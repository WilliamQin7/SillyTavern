import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CodexProviderError } from './upstream/errors.js';

const CIPHER = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;

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
