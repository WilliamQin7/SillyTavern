import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatStudioMessage, STUDIO_LOCALES } from '../../../public/scripts/extensions/third-party/codex-oauth/locales.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('bundled Amy Studio locales have the same complete key set', async () => {
    const expected = Object.keys(STUDIO_LOCALES.en).map(key => `amyCreatorStudio.${key}`).sort();
    const zhCn = JSON.parse(await fs.readFile(path.join(root, 'public/scripts/extensions/third-party/codex-oauth/locales/zh-cn.json'), 'utf8'));
    const zhTw = JSON.parse(await fs.readFile(path.join(root, 'public/scripts/extensions/third-party/codex-oauth/locales/zh-tw.json'), 'utf8'));
    assert.ok(expected.length > 100);
    assert.deepEqual(Object.keys(zhCn).sort(), expected);
    assert.deepEqual(Object.keys(zhTw).sort(), expected);
    for (const [key, fallback] of Object.entries(STUDIO_LOCALES.en)) {
        const namespaced = `amyCreatorStudio.${key}`;
        const placeholders = value => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();
        assert.deepEqual(placeholders(zhCn[namespaced]), placeholders(fallback), `placeholder mismatch in zh-cn: ${key}`);
        assert.deepEqual(placeholders(zhTw[namespaced]), placeholders(fallback), `placeholder mismatch in zh-tw: ${key}`);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'public/scripts/extensions/third-party/codex-oauth/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.i18n, { 'zh-cn': 'locales/zh-cn.json', 'zh-tw': 'locales/zh-tw.json' });
});

test('named placeholders are deterministic', () => {
    assert.equal(formatStudioMessage('Saved {count} to {book}.', { count: 2, book: 'Lore' }), 'Saved 2 to Lore.');
});

test('every static Amy Studio data-i18n key has a bundled fallback', async () => {
    const files = [
        'public/scripts/extensions/third-party/codex-oauth/settings.js',
        'public/scripts/extensions/third-party/codex-oauth/studio.js',
    ];
    const source = (await Promise.all(files.map(file => fs.readFile(path.join(root, file), 'utf8')))).join('\n');
    const keys = [...source.matchAll(/data-i18n="(?:\[[^\]]+])?amyCreatorStudio\.([^"]+)"/g)].map(match => match[1]);
    assert.ok(keys.length > 30);
    for (const key of keys) assert.ok(Object.hasOwn(STUDIO_LOCALES.en, key), `missing English fallback for ${key}`);
    const dynamicKeys = [...source.matchAll(/\btr\('([^']+)'/g)].map(match => match[1]);
    assert.ok(dynamicKeys.length > 30);
    for (const key of dynamicKeys) assert.ok(Object.hasOwn(STUDIO_LOCALES.en, key), `missing dynamic English fallback for ${key}`);
});
