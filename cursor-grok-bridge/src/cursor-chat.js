import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from '@cursor/sdk';

let workspacePromise;

async function ensureWorkspace() {
    if (!workspacePromise) {
        workspacePromise = (async () => {
            const workspace = resolve('.state', 'workspace');
            await mkdir(workspace, { recursive: true });
            try {
                execFileSync('git', ['init', '--quiet', workspace], { stdio: 'ignore' });
            } catch {
                // Cursor only needs an isolated working directory for this tools=[] bridge.
            }
            return workspace;
        })();
    }
    return workspacePromise;
}

function delay(ms, value) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms, value));
}

export async function runCursorChat({
    prompt,
    model,
    onTextDelta,
    signal,
    timeoutMs = 240_000,
    terminalGraceMs = 5_000,
}) {
    const workspace = await ensureWorkspace();
    let deltaText = '';
    let stepText = '';
    let turnUsage;
    let resolveTurnEnded;
    const turnEnded = new Promise((resolvePromise) => {
        resolveTurnEnded = resolvePromise;
    });

    const agent = await Agent.create({
        name: 'SillyTavern Cursor Grok bridge request',
        model,
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

    let run;
    const abortRun = () => {
        if (run?.status === 'running') void run.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', abortRun, { once: true });

    try {
        run = await agent.send(prompt, {
            idempotencyKey: crypto.randomUUID(),
            onStep: ({ step }) => {
                if (step.type === 'assistantMessage') stepText = step.message.text;
            },
            onDelta: ({ update }) => {
                if (update.type === 'text-delta') {
                    deltaText += update.text;
                    onTextDelta?.(update.text);
                }
                if (update.type === 'turn-ended') {
                    turnUsage = update.usage;
                    resolveTurnEnded({ kind: 'turn-ended' });
                }
            },
        });

        const nativeTerminal = run.wait().then((result) => ({ kind: 'native-terminal', result }));
        let outcome = await Promise.race([
            nativeTerminal,
            turnEnded,
            delay(timeoutMs, { kind: 'timeout' }),
        ]);

        if (outcome.kind === 'turn-ended') {
            outcome = await Promise.race([
                nativeTerminal,
                delay(terminalGraceMs, { kind: 'turn-ended-fallback' }),
            ]);
        }

        if (outcome.kind === 'timeout') {
            throw Object.assign(new Error(`Cursor run timed out after ${timeoutMs} ms.`), { statusCode: 504 });
        }

        if (signal?.aborted) {
            throw Object.assign(new Error('Client disconnected.'), { name: 'AbortError' });
        }

        if (outcome.kind === 'native-terminal' && outcome.result.status !== 'finished') {
            const message = outcome.result.error?.message ?? `Cursor run ended with status ${outcome.result.status}.`;
            throw Object.assign(new Error(message), { statusCode: 502 });
        }

        const text = outcome.kind === 'native-terminal'
            ? outcome.result.result ?? stepText ?? deltaText
            : stepText || deltaText;

        return {
            text,
            usage: outcome.kind === 'native-terminal' ? outcome.result.usage ?? turnUsage : turnUsage ?? run.usage,
            requestId: run.requestId,
            completionMode: outcome.kind,
        };
    } finally {
        signal?.removeEventListener('abort', abortRun);
        if (run?.status === 'running') await run.cancel().catch(() => {});
        agent.close();
    }
}
