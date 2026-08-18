# Codex (ChatGPT) OAuth provider

This bundled server plugin adds a `Codex (ChatGPT)` Chat Completion source and a
`Codex (ChatGPT subscription)` image-generation source to SillyTavern.

It uses the ChatGPT/Codex subscription compatibility flow, not the public
OpenAI API. It is not an official OpenAI integration, and upstream compatibility
can change.

## Credential boundary

- OAuth uses Authorization Code with PKCE and a random state value.
- For an admin SillyTavern user, the server first checks the existing Codex
  Desktop/CLI credential cache at `$CODEX_HOME/auth.json` or `~/.codex/auth.json`.
  It reads that file only; it never rewrites or deletes the Codex cache.
- The browser receives only login status. Access tokens, refresh tokens,
  authorization codes, and account IDs remain server-side.
- Credentials are encrypted with AES-256-GCM, scoped to the current
  SillyTavern user, and stored in that user's data directory as
  `.codex-oauth.credentials.enc`.
- Refresh results derived from a shared Codex login are written only to the
  encrypted SillyTavern store. Disconnecting creates a non-secret per-user
  marker and never signs out Codex Desktop/CLI. Non-admin SillyTavern users
  cannot inherit the machine owner's Codex login.
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
2. In API Connections, select `Codex (ChatGPT)`. An administrator's existing
   Codex Desktop/CLI login is detected automatically; otherwise click
   `Sign in to ChatGPT`.
3. For images, open Image Generation and select
   `Codex (ChatGPT subscription)`, or run `/imagine-source codex` before using
   `/imagine <prompt>`.

The image source reuses the selected Codex chat model and the same encrypted
login. No OpenAI API key is required.

## Amy Creator Studio

Open **Extensions → Amy Creator Studio**. The bundled studio deliberately uses
reviewable drafts and existing SillyTavern storage formats instead of a private
database.

For the end-to-end novel workflow, JSON field semantics, Agent constraints,
branch isolation, and failure recovery, see
[`CREATOR_STUDIO_WORKFLOW.md`](./CREATOR_STUDIO_WORKFLOW.md).

The connection panel, Creator Studio controls, confirmations, validation
messages, and notifications follow SillyTavern's selected interface language.
English, Simplified Chinese, and Traditional Chinese are bundled using
SillyTavern's native extension `i18n` manifest. English remains the fallback
for any other locale. Another language can be added with one namespaced JSON
file under `public/scripts/extensions/third-party/codex-oauth/locales/` and one
manifest mapping, without changing the feature code.

### Character and lorebook

1. Describe a character and setting, then choose **Generate draft**.
2. Review or edit the generated Character Card V3 JSON.
3. Choose **Validate**, then **Import character + lorebook**.

Validation accepts Character Card V2 or V3 input and always normalizes the
reviewed draft to V3.0. V3 group greetings, nickname, multilingual creator
notes, sources, assets, timestamps, and namespaced `extensions` are preserved.
The linked lorebook is also embedded as a V3 `character_book`, while import
continues to use SillyTavern's stable character-create endpoint. Import creates
a new linked World Info file and never overwrites a lorebook with the same
name. The World Info link is stored in the standard card extension so the
create endpoint does not replace the normalized V3 embedded book. V3.1
proposals are deliberately not targeted until they become an accepted
specification.

### Visual assets

Keep the character's invariant appearance in **Visual identity anchor** and the
shared art direction in **Style bible**.

- Portrait: saved through the Image Generation gallery, or generated and set as
  the current character avatar after confirmation.
- Expression: generated as a portrait-oriented image and installed in the
  current character's expression-sprite folder under the selected label.
- Background: generated in landscape orientation, uploaded to backgrounds, and
  selected for the current chat.

### Long-term memory

Memory extraction reads a bounded recent-chat window and creates an editable
JSON draft of atomic facts, events, relationships, goals, and state. Saving is a
separate confirmed action. Approved memories become vector-enabled entries in
the chat-bound lorebook. Optional automatic mode prepares drafts only; it never
writes them without review.

Memory drafts are stored in chat metadata and include their source chat and
message range. A draft cannot be saved from another chat. Exact duplicate
memories are skipped. **Close scene** uses the same review flow to prepare a
chronological scene summary, durable state and relationship changes, and open
story threads without promoting future plot ideas to facts.

Scene close also prepares a compact `amy_story_state_v1` snapshot containing
the current scene, character state, directional relationships, open threads,
canon facts, and explicitly non-canon author plans. The previous reviewed
snapshot is supplied when the next scene is closed so still-valid state is not
silently lost. Saving remains confirmation-gated: approved state is stored in
chat metadata and mirrored to one always-on chat lorebook entry so it can guide
later generations. Author plans remain in reviewed chat metadata and are not
injected into the roleplay prompt; the model is instructed never to infer them
from dialogue or narration.

### Optional Story Plan

An existing novel premise and chapter outline can be pasted into the
**Planning** tab as Markdown, plain text, or `amy_story_plan_v1` JSON. Creator
Studio prepares a reviewable chapter/scene structure and saves the approved
full plan in chat metadata. The feature is optional: if no plan is saved or
activated, the existing character, lorebook, memory, Story State, and
checkpoint workflows behave exactly as before.

Activating a writing focus mirrors only the selected current chapter and scene,
their goals, constraints, and the shared style guide to one replaceable
chat-lorebook entry. It is explicitly labelled as non-canon author guidance.
The full premise, later chapters, and future scenes are not injected, which
reduces context cost and avoids leaking planned reveals into the prose. The
focus can be changed or deactivated without deleting the saved plan. On a
checkpoint, duplicate and rebind the chat lorebook before activating,
refreshing, or deactivating branch-specific guidance.

Branch visualization is intentionally left to SillyTavern checkpoints and the
Timelines extension. **Create checkpoint** confirms and runs SillyTavern's
native checkpoint command on the latest message; Timelines can then display
the branch. Creator Studio does not maintain a second automatic plot graph
whose nodes could drift away from edited or branched chats.

### Safe tools

Tool calling is disabled by default. When enabled, the provider filters the
SillyTavern tool list to exactly these bundled tools:

- `AmyStudioRemember`
- `AmyStudioGenerateImage`

Both show an on-screen confirmation before a lorebook write or image-generation
request. Other built-in and third-party tools are not sent to Codex through this
provider. Approved and cancelled actions are recorded in a bounded local audit
trail in extension settings; prompts, generated images, credentials, and tool
results are not added to server logs.

The Codex/ChatGPT compatibility endpoint is not a public API contract. Text,
image, and function-call event shapes may change and should be re-tested after
provider or SillyTavern upgrades.
