# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
In 0.x development, breaking changes may occur in minor releases and will be explicitly noted.

## [0.3.0] - 2026-06-28

### Breaking Changes

- **Tool/skill policy no longer allows mixed `allow` and `deny` lists.** Each resource policy (`tools`, `skills`) must use either `allow` **or** `deny`, not both. Stacks with non-empty mixed lists now produce validation errors. Previously, concrete `allow` patterns silently took priority over `deny`. Update your stack JSON to use one list per resource.
  - Before: `{ "tools": { "allow": ["read", "bash"], "deny": ["*"] } }`
  - After: `{ "tools": { "allow": ["read", "bash"] } }` or `{ "tools": { "deny": ["write"] } }`
- `PromptResourcePolicy` type changed from `{ allow?: string[]; deny?: string[] }` to a discriminated union: `{ allow?: string[]; deny?: never } | { allow?: never; deny?: string[] }`.

### Added

- **Regex transforms.** Deterministic JavaScript `RegExp` find/replace on prompt text, ordered as stack-level `regex.rules`.
  - `stage: "history"` — transforms messages inserted by the `chat-history` slot, with role filters, `maxMessages`, and `maxChars`.
  - `stage: "compiled"` — transforms final system prompt and/or message text before provider serialization, with `targets`, role filters, `maxMessages`, and `maxChars`.
  - `effect: "finalize"` — destructively rewrites completed assistant messages at `message_end`. Original model output is not preserved.
  - Supported flags: `g`, `i`, `m`, `s`, `u`. Invalid patterns, duplicate IDs, and unsupported flags are rejected during validation.
  - Runtime diagnostics report match counts and changed text segments.
- **Tool and skill policy.** Stack-level `tools.allow`/`tools.deny` and `skills.allow`/`skills.deny` with exact names and `*` wildcards. Tool policy is enforced through `pi.setActiveTools()` and restored when the stack is disabled or switched. Skill policy filters rendered `skills` slots and respects `disableModelInvocation`.
- **Web editor: Policy tab.** Structured editor for tool and skill policies with mode selector (Unrestricted / Allow / Deny), pattern textarea, duplicate detection, and live policy summaries.
- **Web editor: Payload inspector.** Arm the next provider request from the UI, display captures with collapsible JSON sections, redaction preserved, char/token estimates, and copy controls. Captures triggered by `/payload next` are also visible in the browser.
- **Web editor: Full-screen structured preview inspector.** Collapsible system/message sections, char/token estimates, and copy controls for full preview and individual sections.
- **Web editor: Structured editors** for stack `context` options, `variables`, tool/skill policy, and `regex.rules` with drag-and-drop reordering.
- **Web editor: Raw JSON recovery path.** View, copy, and apply raw stack JSON for advanced stack-level fields.
- **Compact prompt slot formats.** Opt-in `format: "plain"` for `tools`, `tool-guidelines`, `skills`, `project-context`, and `variables` slots. XML remains the default.
- **Prompt-stack storage migration.** New stacks write to `.pi/forge/prompt-stacks/`; legacy `.pi/prompt-stacks/` remains readable and is shadowed by same-named forge files. `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` copies legacy stacks into forge storage.
- **SillyTavern regex import.** Safe `promptOnly` regex scripts are converted into pi-forge outgoing `compiled` regex rules during import. Display-only, mixed, JavaScript, DOM/browser, and CSS/HTML decoration scripts remain report-only with migration notes.
- **`/preset ui` server reuse.** Existing same-project editor servers are reclaimed after extension reinitialization from session navigation or new-session flows, preventing orphaned servers.
- **`/payload next [save=<path>]` command.** Displays and optionally saves the next redacted/truncated provider payload with char/token estimates.
- **`/preset migrate-stacks` command** with `--dry-run`, `--overwrite`, and `--delete-legacy` options.

### Changed

- **Web editor architecture split.** `src/web-editor.ts` split into `src/web-editor/` module folder (`index.ts`, `types.ts`, `server.ts`, `page.ts`). `src/index.ts` split into `src/web-host.ts` (stack CRUD/web-editor host) and `src/payload-capture.ts` (provider payload redaction/capture).
- **Prompt state removed before 0.3.0 release.** pi-forge now keeps template variables and SillyTavern-style variable macros, but no longer exposes stack `state.definitions`, `/state`, `/preset vars`, `forge_state_set`, `forge_set_var`, state metadata rendering, or web runtime state editing.
- **Context rewrite** limited to the first provider request of each user-submitted turn, avoiding repeated injection after tool calls.
- **`/preset import-silly`** now detects `{{lastUserMessage}}` and configures chat history accordingly. SillyTavern `{{setvar}}`/`{{getvar}}` macros reported as handled instead of migration-needed.
- **`/preset reload`** preserves explicit disabled selection instead of reactivating `default.json`.
- SillyTavern import reports now include `extensions.regex_scripts` counts, prompt/display classification, script names, and migration notes.

### Removed

- Implicit `allow`-takes-priority-over-`deny` behavior in resource policy evaluation.
- Prompt-state memory layer: `state.definitions`, `/state`, `/preset vars`, `forge_state_set`, `forge_set_var`, metadata/namespace/JSON prompt-state rendering, and web runtime state editing.

## [0.2.0] - 2025-06-13

### Added

- File-backed prompt stacks with `replace`, `append`, and `prepend` system prompt modes.
- Movable `chat-history` slot with optional omission of latest user message.
- Runtime slots: `tools`, `tool-guidelines`, `skills`, `project-context`, `append-system-prompt`, `date`, `cwd`, `date-cwd`, `active-model`, `pi-docs`, `variables`.
- Built-in macros: `{{cwd}}`, `{{date}}`, `{{time}}`, `{{lastUserMessage}}`, `{{selectedTools}}`, `{{tools}}`, `{{activeModel}}`.
- Turn/session/static variable lookup and mutation macros.
- Branch-aware macro session variable restoration during session tree navigation.
- `/preset` commands: `list`, `status`, `use`, `preview`, `validate`, `diagnostics`, `reload`, `vars`, `ui`.
- `/intercept` command for next provider payload inspection.
- `/preset import-silly` command for SillyTavern preset import with import reports.
- `/preset ui` local web editor for prompt-stack management.
- Node built-in test suite covering compiler, loader, importer, and command/event harness.
- Chinese README (`README.zh-CN.md`).
