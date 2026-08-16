# Codex (ChatGPT) OAuth provider

This bundled server plugin adds a `Codex (ChatGPT)` Chat Completion source and a
`Codex (ChatGPT subscription)` image-generation source to SillyTavern.

It uses the ChatGPT/Codex subscription compatibility flow, not the public
OpenAI API. It is not an official OpenAI integration, and upstream compatibility
can change.

## Credential boundary

- OAuth uses Authorization Code with PKCE and a random state value.
- The browser receives only login status. Access tokens, refresh tokens,
  authorization codes, and account IDs remain server-side.
- Credentials are encrypted with AES-256-GCM, scoped to the current
  SillyTavern user, and stored in that user's data directory as
  `.codex-oauth.credentials.enc`.
- Writes use a restrictive file mode where the operating system supports it.
- Logs contain request IDs, model IDs, timing, and safe error codes only. They
  do not contain prompts, tokens, authorization headers, or generated images.
- Model listing is bundled locally and does not contact a third-party catalog.

Keep `enableServerPluginsAutoUpdate: false` for this bundled copy so local code
cannot be silently replaced. Back up SillyTavern's cookie secret together with
the data directory; changing the secret intentionally makes the encrypted
credential file unreadable and requires signing in again.

## Use

1. Enable server plugins and restart SillyTavern.
2. In API Connections, select `Codex (ChatGPT)` and click `Sign in to ChatGPT`.
3. For images, open Image Generation and select
   `Codex (ChatGPT subscription)`.

The image source reuses the selected Codex chat model and the same encrypted
login. No OpenAI API key is required.
