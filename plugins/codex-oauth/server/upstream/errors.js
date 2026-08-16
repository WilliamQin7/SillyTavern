/** Error shape used across the stable integration and volatile upstream layers. */
export class CodexProviderError extends Error {
    constructor(code, message, { status = 500, retryable = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'CodexProviderError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

export function isCodexProviderError(error) {
    return error instanceof CodexProviderError;
}

function backendCode(body) {
    return String(body?.error?.code ?? body?.error?.type ?? body?.code ?? '').toLowerCase();
}

/** Convert an upstream HTTP failure into a message that is safe to show in SillyTavern. */
export async function mapUpstreamHttpError(response) {
    let body = null;
    try {
        body = await response.clone().json();
    } catch {
        // Error responses are intentionally not logged or echoed because they can include request details.
    }

    const code = backendCode(body);
    if (response.status === 400 && /reasoning/.test(code)) {
        return new CodexProviderError('UNSUPPORTED_REASONING', 'The selected reasoning effort is not supported by this Codex model.', { status: 400 });
    }
    if (response.status === 400 && /model/.test(code)) {
        return new CodexProviderError('MODEL_UNAVAILABLE', 'The selected Codex model is unavailable for this account.', { status: 400 });
    }
    if (response.status === 401) {
        return new CodexProviderError('AUTHENTICATION_FAILED', 'ChatGPT authentication expired. Sign in again.', { status: 401 });
    }
    if (response.status === 403) {
        return new CodexProviderError('ACCESS_DENIED', 'This ChatGPT account cannot use the selected Codex capability.', { status: 403 });
    }
    if (response.status === 404) {
        return new CodexProviderError('BACKEND_INCOMPATIBLE', 'Codex Provider compatibility layer may be outdated. Please update the plugin.', { status: 502 });
    }
    if (response.status === 408 || response.status === 504) {
        return new CodexProviderError('UPSTREAM_TIMEOUT', 'Codex backend timed out. Try again.', { status: 504, retryable: true });
    }
    if (response.status === 429 || /quota|allowance|rate_limit|insufficient_quota/.test(code)) {
        return new CodexProviderError('QUOTA_EXHAUSTED', 'Codex allowance is exhausted or rate-limited. Wait before trying again.', { status: 429, retryable: true });
    }
    if (response.status >= 500) {
        return new CodexProviderError('BACKEND_UNAVAILABLE', 'Codex backend is temporarily unavailable. Try again later.', { status: 502, retryable: true });
    }
    return new CodexProviderError('BACKEND_ERROR', 'Codex backend rejected the request. Check the selected model and provider settings.', { status: 502 });
}

export function mapUnknownError(error) {
    if (isCodexProviderError(error)) return error;
    if (error?.name === 'AbortError') {
        return new CodexProviderError('REQUEST_CANCELLED', 'Generation was stopped.', { status: 499 });
    }
    if (error?.code === 'ETIMEDOUT') {
        return new CodexProviderError('UPSTREAM_TIMEOUT', 'Codex backend timed out. Try again.', { status: 504, retryable: true });
    }
    return new CodexProviderError('NETWORK_FAILURE', 'Could not reach the Codex backend. Check your network connection.', { status: 502, retryable: true, cause: error });
}

export function toPublicError(error) {
    const mapped = mapUnknownError(error);
    return {
        status: mapped.status,
        body: {
            error: {
                code: mapped.code,
                message: mapped.message,
                retryable: mapped.retryable,
            },
        },
    };
}
