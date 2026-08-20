import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent, Cursor } from '@cursor/sdk';

const workspace = resolve('.state', 'smoke-workspaces', crypto.randomUUID());
await mkdir(workspace, { recursive: true });
execFileSync('git', ['init', '--quiet', workspace], { stdio: 'ignore' });

const models = await Cursor.models.list();
const model = models.find((entry) => entry.id === 'grok-4.6');
if (!model) throw new Error('grok-4.6 is not available for this Cursor account.');

let deltaText = '';
let stepText = '';
let turnUsage;
let resolveTurnEnded;
const turnEnded = new Promise((resolvePromise) => {
    resolveTurnEnded = resolvePromise;
});

await using agent = await Agent.create({
    name: 'SillyTavern Grok 4.6 turn-ended probe',
    model: {
        id: model.id,
        params: [
            { id: 'effort', value: 'high' },
            { id: 'fast', value: 'true' },
        ],
    },
    mode: 'agent',
    tools: [],
    mcpServers: {},
    agents: {},
    local: {
        cwd: workspace,
        settingSources: [],
        sandboxOptions: { enabled: false },
        enableAgentRetries: true,
    },
});

const run = await agent.send(
    'This is a synthetic connectivity probe. Reply with exactly: CURSOR_GROK_46_OK',
    {
        idempotencyKey: crypto.randomUUID(),
        onStep: ({ step }) => {
            if (step.type === 'assistantMessage') stepText = step.message.text;
        },
        onDelta: ({ update }) => {
            if (update.type === 'text-delta') deltaText += update.text;
            if (update.type === 'turn-ended') {
                turnUsage = update.usage;
                resolveTurnEnded({ kind: 'turn-ended' });
            }
        },
    },
);

console.log(`Run accepted (request_id=${run.requestId ?? 'pending'}).`);

const nativeTerminal = run.wait().then((result) => ({ kind: 'native-terminal', result }));
const firstSignal = await Promise.race([
    nativeTerminal,
    turnEnded,
    new Promise((resolvePromise) => {
        setTimeout(() => resolvePromise({ kind: 'timeout' }), 240_000);
    }),
]);

let outcome = firstSignal;
if (firstSignal.kind === 'turn-ended') {
    outcome = await Promise.race([
        nativeTerminal,
        new Promise((resolvePromise) => {
            setTimeout(() => resolvePromise({ kind: 'turn-ended-fallback' }), 5_000);
        }),
    ]);
}

const finalText = stepText || deltaText;
const statusBeforeCleanup = run.status;
if (run.status === 'running') await run.cancel();

console.log(JSON.stringify({
    outcome: outcome.kind,
    request_id: run.requestId,
    status_before_cleanup: statusBeforeCleanup,
    status_after_cleanup: run.status,
    text: finalText,
    delta_text: deltaText,
    step_text: stepText,
    usage: turnUsage ?? run.usage,
    sandbox_enabled: false,
    requested_variant: 'grok-4.6-high-fast',
}, null, 2));

if (!finalText.includes('CURSOR_GROK_46_OK')) process.exitCode = 4;
