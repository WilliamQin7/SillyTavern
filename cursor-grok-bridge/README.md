# SillyTavern Cursor Grok bridge

This loopback service exposes Cursor subscription model `grok-4.6` through a small OpenAI-compatible API for SillyTavern. The default variant is `grok-4.6-high-fast`.

It uses the public `@cursor/sdk`. On Windows the local SDK sandbox is not available, so this bridge deliberately disables it. Cursor tools, MCP servers, sub-agents, and settings sources remain disabled, and every request gets a fresh Agent handle.

## Start

Requires Node.js 22.13 or later.

```powershell
npm install
npm run auth:login
npm start
```

The default base URL is `http://127.0.0.1:5111/v1`. Available endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /health`

The server binds to loopback by default. To require a bearer token, set `CURSOR_GROK_BRIDGE_TOKEN` before starting it.

## SillyTavern

Start the bridge, open **API Connection**, and click **Configure Cursor Grok bridge** under Connection Profile. The button configures and connects:

- API: Chat Completion
- Source: Custom (OpenAI-compatible)
- URL: `http://127.0.0.1:5111/v1`
- Model: `grok-4.6-high-fast`
- Streaming: enabled
- Connection profile: `Cursor Grok 4.6 high-fast`

The same values can be entered manually. Leave the Custom API key empty unless `CURSOR_GROK_BRIDGE_TOKEN` is set. OpenAI + Reverse Proxy is also supported, but its first connection requires confirming SillyTavern's proxy warning; the red missing-OpenAI-key label is not a blocker when a reverse proxy URL is present.

Supported model aliases include `grok-4.6-low`, `grok-4.6-medium`, `grok-4.6-high`, `grok-4.6-xhigh`, and the same names with `-fast` appended. The bare `grok-4.6` alias also resolves to high + fast.

## Runtime notes

Cursor SDK 1.0.28 can emit the complete assistant step and `turn-ended` while leaving the local Run in `running` state on Windows. The bridge gives the native terminal event a short grace period, then cancels and closes the stale Run while preserving the completed response. `CURSOR_GROK_TERMINAL_GRACE_MS` and `CURSOR_GROK_TIMEOUT_MS` control those limits.

Images and OpenAI tool/function calls are not supported in this first bridge. Sampling fields such as `temperature`, `top_p`, and exact `max_tokens` are accepted by the endpoint but cannot be forwarded because Cursor's SDK model selection does not expose them.
