# pi-forge Implemented Features

This file tracks the currently implemented feature surface for the prompt-stack runtime, typed prompt state, web editor, SillyTavern importer, storage migration, payload inspector, and regex MVP.

## Package and Runtime

- Pi package manifest with `src/index.ts` exposed through `package.json` `pi.extensions`.
- Public npm package configuration for `@zihanw/pi-forge`.
- Source and examples included in the npm package tarball.
- Project trust check before loading prompt stacks.
- Footer status showing the active prompt stack.

## Prompt Stack Loading and Storage

- File-backed prompt stacks from `.pi/forge/prompt-stacks/*.json`.
- Legacy `.pi/prompt-stacks/*.json` stacks remain readable and editable for compatibility.
- Same-named files in `.pi/forge/prompt-stacks` shadow legacy stack files.
- New stacks, imports, and forks write to `.pi/forge/prompt-stacks`.
- `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` copies legacy stacks into the forge storage location.
- `default.json` auto-activation unless `autoActivate` is `false`.
- Branch-aware persisted active stack restore from session entries.
- Branch-aware prompt state restore when navigating the session tree.
- Persisted `/preset use none` / `off` opt-out.
- Invalid stacks with error diagnostics are skipped by automatic selection.
- Stack validation for duplicate item IDs, duplicate stack IDs, unsupported slots, missing chat-history slots, and ignored items.

## Prompt Compilation

- `replace`, `append`, and `prepend` system prompt modes.
- Empty replacement system prompt fallback to Pi's base system prompt.
- Enabled item ordering preserved during compilation.
- Movable `chat-history` slot in message layout.
- Optional omission of latest user message from chat history.
- Duplicate chat-history warning unless explicitly allowed.
- Synthetic `user`, `assistant`, and hidden `custom` messages.
- Context rewrite limited to the first provider request of each user-submitted turn.
- Outgoing regex transforms can run after `chat-history` insertion and after final prompt compilation.
- Finalize regex transforms can rewrite completed assistant messages at `message_end`.

## Regex Transforms

- Top-level `regex.schemaVersion` and ordered `regex.rules` stack config.
- Deterministic JavaScript `RegExp` replacements only; no embedded JavaScript, DOM access, browser automation, or CSS/HTML decoration runtime.
- `stage: "history"` transforms messages inserted by the `chat-history` slot.
- `stage: "compiled"` transforms the final compiled system prompt and/or message text before provider serialization.
- `effect: "outgoing"` is active for model-bound prompt text.
- `effect: "finalize"` is active for completed assistant messages at `stage: "compiled"` / `targets: ["messages"]`.
- `effect: "finalize"` is destructive: it replaces the finalized assistant message in Pi's stored transcript, so the original model output is not preserved.
- `effect: "display"` and `"both"` validate with warnings and are ignored until true display transforms are implemented.
- Streaming display is not transformed; raw text may be visible until the final message replacement happens.
- Message transforms support role filters, `maxMessages`, and `maxChars`.
- Compiled-stage transforms support `targets: ["system"]`, `["messages"]`, or both.
- Supported regex flags are `g`, `i`, `m`, `s`, and `u`, with duplicate/unsupported flags rejected during validation.
- Runtime diagnostics report regex match counts and changed text segment counts.

## Runtime Slots

- `chat-history`
- `tools`
- `tool-guidelines`
- `skills`
- `project-context`
- `append-system-prompt`
- `date`
- `cwd`
- `date-cwd`
- `active-model`
- `pi-docs`
- `variables`

## Macros

- Built-in macros: `{{cwd}}`, `{{date}}`, `{{time}}`, `{{lastUserMessage}}`, `{{selectedTools}}`, `{{tools}}`, `{{activeModel}}`.
- Static stack variables from `stack.variables`.
- Turn/session/static lookup through `{{getvar::name}}`, `{{var::name}}`, and bare `{{name}}`.
- Turn variable mutation through `{{setvar::name::value}}`, `{{setturnvar::name::value}}`, and `{{clearvar::name}}`.
- Session state mutation through `{{setsessionvar::name::value}}`, `{{setvar::session::name::value}}`, and `{{clearsessionvar::name}}`.
- Unknown macro diagnostics with configurable keep/warn/error policy.
- Non-string prompt state values stringify as JSON during macro substitution.

## Prompt State

- JSON-compatible session state values: string, number, boolean, null, arrays, and objects.
- Session state snapshots restore from the current session tree branch, so tree navigation rolls state back/forward with history.
- Stack-level `state.definitions` with type, scope, description, default, and write-permission metadata.
- Definition defaults render in the `variables` slot without initializing persisted session state.
- Type validation for common TypeScript-like strings such as `string`, `number`, `boolean`, `object`, `array`, `string[]`, and unions.
- Valid `<prompt_state>` rendering from the `variables` slot.
- XML state entries rendered as `<var name="..." type="...">...</var>`.
- Optional JSON-format prompt state rendering.
- Scope filtering with `includeScopes`.
- Namespace filtering with exact names and wildcard prefixes such as `agent.*`.
- Optional metadata rendering from stack state definitions.
- Metadata-enabled state slots show matching definitions as `unset` entries before values exist, so the agent can see writable state names and descriptions.
- Per-value truncation with `maxValueChars`.
- Default example stack includes visible `user.*` and `agent.*` session state.

## Agent Tools

- `forge_state_set` batch tool for agent-scoped persistent prompt state.
- Agent writes restricted to `agent.*`.
- Batch updates and clears are validated before persistence.
- `forge_set_var` retained as a compatibility alias for one string value.
- Tool guidance tells the agent to use state for concise cross-turn continuity and not for secrets or large transcripts.

## Commands

- `/preset list`
- `/preset status`
- `/preset use <id|none>`
- `/preset preview [id]`
- `/preset validate [id]`
- `/preset diagnostics`
- `/preset reload`
- `/preset ui [stop|restart]`
- `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]`
- `/preset vars [set <name> <value>|get <name>|clear [name]]`
- `/preset import-silly <path> [character_id] [--dry-run] [--overwrite]`
- `/state list`
- `/state status`
- `/state set <name> <json-or-text-value>`
- `/state get <name>`
- `/state clear [name]`
- `/intercept`
- `/payload next [save=<path>]`

## SillyTavern Import

- Import SillyTavern preset JSON into `.pi/forge/prompt-stacks/<id>.json`.
- Generate import reports under `.pi/forge/import-reports/<id>.md`.
- Select a specific `character_id` when multiple prompt orders exist.
- Protect existing generated stack/report files from accidental overwrite, with confirmation or `--overwrite`.
- Preview generated output without writing files via `--dry-run`.
- Convert prompt order into prompt stack items.
- Preserve original SillyTavern identifiers in item source metadata.
- Convert `chatHistory` marker to a movable `chat-history` slot.
- Skip unsupported SillyTavern marker items and report omissions.
- Detect `{{lastUserMessage}}` and configure chat history accordingly.
- Strip SillyTavern comments and `{{trim}}` markers.
- Report macros that need manual migration, including normalized camelCase SillyTavern macro names.
- Report supported SillyTavern-style variable macros such as `setvar` and `getvar` as handled by pi-forge.
- Report SillyTavern `extensions.regex_scripts` counts, prompt/display classification, script names, and migration notes. Runtime regex exists for manually authored deterministic prompt transforms, but SillyTavern regex scripts are not auto-converted yet.

## Debugging and Tests

- `/intercept` displays the next provider payload with redaction/truncation for secrets and large data.
- `/payload next save=<path>` displays and saves the next redacted/truncated provider payload with char/token-ish size estimates.
- The web editor can arm, poll, clear, and inspect the next redacted provider payload in a full-screen collapsible JSON inspector.
- Runtime compile diagnostics are visible through a footer status and `/preset diagnostics`.
- `/preset ui` starts a token-protected localhost web editor for stack management.
- Node built-in tests cover compiler, loader, SillyTavern importer, and a small command/event harness.
- Tests cover prompt state rendering, namespace filtering, metadata rendering, XML escaping, and typed macro stringification.
- Tests cover regex validation, history-stage transforms, compiled-stage transforms, finalize transforms, replacement syntax, role/message/char limits, and preservation of non-text message parts.
- TypeScript strict typecheck passes.
- Package dry-run verifies published tarball contents.

## Web Stack Editor

- `/preset ui`, `/preset ui restart`, and `/preset ui stop`.
- Local editor server bound to an available `127.0.0.1` port by default with a random URL token.
- Preferred editor port can be configured through `.pi/forge/config.json` using `webEditor.port`; if it is unavailable, pi-forge falls back to an available port.
- Existing same-project editor servers are reclaimed after extension reinitialization from session navigation/new-session flows, so `/preset ui` reuses the current URL instead of opening a second port.
- Stack list with active/error/warning indicators.
- Collapsible prompt-stack sidebar.
- Light/dark theme toggle, button icons, and tooltips for common actions.
- Unsaved-change badge in the top bar.
- Edit stack id, name, mode, `autoActivate`, description, and existing stack file content.
- Edit stack `context` options from a structured dialog.
- Edit stack static `variables` from a structured table.
- Edit stack `state.definitions`, including type, scope, description, defaults, and write permissions.
- Reorder items by drag-and-drop.
- Add and delete stack items.
- Toggle item enabled state from the item list.
- Inline item validation badges when diagnostics point at a specific item.
- Edit block content in a full-height text editor area.
- Edit slot kind, role, slot type, and common slot options through form controls.
- Fall back to raw JSON editing for advanced slot options.
- View, copy, and apply raw stack JSON as a recovery path for advanced stack-level fields.
- Validate and inspect edited stack state before saving.
- Full-screen structured preview inspector with collapsible system/message sections, char/token estimates, and copy controls.
- Arm and inspect the next provider payload from the web editor; captures triggered by `/payload next` are also available to the browser while the editor is open.
- Provider payload inspector shows top-level JSON sections, redacted full text, char/token estimates, and copy controls.
- View, set, and clear runtime session state from the web editor using the same validation and persistence path as `/state`.
- Session state editor shows active stack definitions next to current runtime values.
- Save existing stack JSON and immediately reload pi-forge stack state.
- Import native stack JSON or SillyTavern preset JSON into `.pi/forge/prompt-stacks`; SillyTavern uploads are converted automatically.
- Show the SillyTavern import report in the web editor after import, with copy support.
- Export the current edited stack JSON from the browser, with clipboard fallback when download is unavailable.
- Fork the current stack into a new stack file, with optional activation.
- Delete stack files, disabling prompt-stack replacement if the deleted stack was active.
- Trust and path guardrails for save/import/fork/delete writes.
- Smoke tests cover editor server token checks, bundled page/script markers, save, runtime state set/clear, payload arm/capture/clear, create/fork, SillyTavern JSON import conversion, collision handling, delete, and stop behavior.
