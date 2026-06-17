# pi-forge Implemented Features

This file tracks the currently implemented feature surface for the published MVP and the typed prompt-state follow-up.

## Package and Runtime

- Pi package manifest with `src/index.ts` exposed through `package.json` `pi.extensions`.
- Public npm package configuration for `@zihanw/pi-forge`.
- Source and examples included in the npm package tarball.
- Project trust check before loading prompt stacks.
- Footer status showing the active prompt stack.

## Prompt Stack Loading

- File-backed prompt stacks from `.pi/prompt-stacks/*.json`.
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

- Import SillyTavern preset JSON into `.pi/prompt-stacks/<id>.json`.
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

## Debugging and Tests

- `/intercept` displays the next provider payload with redaction/truncation for secrets and large data.
- `/payload next save=<path>` displays and saves the next redacted/truncated provider payload with char/token-ish size estimates.
- Runtime compile diagnostics are visible through a footer status and `/preset diagnostics`.
- `/preset ui` starts a token-protected localhost web editor for stack management.
- Node built-in tests cover compiler, loader, SillyTavern importer, and a small command/event harness.
- Tests cover prompt state rendering, namespace filtering, metadata rendering, XML escaping, and typed macro stringification.
- TypeScript strict typecheck passes.
- Package dry-run verifies published tarball contents.

## Web Stack Editor

- `/preset ui`, `/preset ui restart`, and `/preset ui stop`.
- Local editor server bound to `127.0.0.1:41738` by default with a random URL token.
- Fixed editor port can be configured through `.pi/forge/config.json` using `webEditor.port`.
- Stack list with active/error/warning indicators.
- Collapsible prompt-stack sidebar.
- Edit stack id, name, mode, `autoActivate`, description, and existing stack file content.
- Reorder items by drag-and-drop.
- Add and delete stack items.
- Toggle item enabled state from the item list.
- Edit block content in a full-height text editor area.
- Edit slot kind, role, slot type, and common slot options through form controls.
- Fall back to raw JSON editing for advanced slot options.
- Validate and inspect edited stack state before saving.
- Full-screen structured preview inspector with collapsible system/message sections, char/token estimates, and copy controls.
- Save existing stack JSON and immediately reload pi-forge stack state.
- Import native stack JSON or SillyTavern preset JSON into `.pi/prompt-stacks`; SillyTavern uploads are converted automatically.
- Export the current edited stack JSON from the browser.
- Fork the current stack into a new stack file, with optional activation.
- Delete stack files, disabling prompt-stack replacement if the deleted stack was active.
- Trust and path guardrails for save/import/fork/delete writes.
- Smoke tests cover editor server token checks, save, create/fork, SillyTavern JSON import conversion, collision handling, delete, and stop behavior.
