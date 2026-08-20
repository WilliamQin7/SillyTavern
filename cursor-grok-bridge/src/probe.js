import { Cursor } from '@cursor/sdk';
import { sanitizeCatalog } from './catalog.js';

const auth = await Cursor.auth.status();
if (auth.status !== 'logged-in' && !process.env.CURSOR_API_KEY) {
    console.error('No Cursor SDK login found. Run: npm run auth:login');
    process.exit(2);
}

await Cursor.me();
const models = await Cursor.models.list();
const grokModels = sanitizeCatalog(models);

console.log(JSON.stringify({
    sdk_authenticated: true,
    target_models_found: grokModels.map((model) => model.id),
    models: grokModels,
}, null, 2));

if (!grokModels.some((model) => model.id === 'grok-4.6')) {
    console.error('grok-4.6 is not present in this account-level Cursor SDK catalog.');
    process.exitCode = 3;
}
