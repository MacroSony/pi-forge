# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
In 0.x development, breaking changes may occur in minor releases and will be explicitly noted.

## [Unreleased]

### Added

- **Native one-shot agent profiles.** Project profiles under `.pi/forge/agent-profiles` store an exact model, thinking level, and prompt-stack reference. `/profile use` preflights and applies once, `/profile save` captures the current runtime, and list/status/preview/validate/reload/forget commands cover diagnostics, drift, direct file editing, and branch-scoped provenance without automatic reapplication.
- **Profile resolution API.** Exported strict profile types, loading, validation, exact model/auth/thinking/stack resolution, fingerprints, provenance guards, and diagnostics for future subagent adapters without adding a runner dependency. Prompt stacks remain the single source of truth for tool policy and model-visible skill filtering.
- **Fresh-session profile auto-activation.** One profile may opt into `autoActivate: true` to apply its model, thinking level, and prompt stack once for each fresh session. Profile selection takes precedence over standalone stack autoload, restored branch state remains authoritative, and invalid or ambiguous startup profiles fail closed without producing a hybrid configuration.
- **Browser-level editor smoke coverage.** CI now launches the real localhost editor in headless Chrome and verifies load, metadata editing, validation, policy guidance, save, and browser-console behavior.

### Fixed

- **Tool policy restoration and enforcement across Pi reload.** pi-forge now restores the pre-policy active tool set during extension shutdown, waits for other extensions to finish their startup tool configuration before recapturing it, and reapplies restrictive policy before input and turns. A tool-call guard blocks disallowed execution even if another extension later calls `setActiveTools()`. This prevents both missing built-ins after `/preset use none` and late-added extension tools bypassing an active stack policy.
- **Skill-policy semantics.** Validation, documentation, and editor guidance now state that skill policy filters model-visible pi-forge skill listings; it does not disable explicit skill invocation and is not a security boundary.

### Changed

- The web editor shell, styles, and browser script are maintained as separate source modules.
- Profile commands now consume shared typed repository, application, preview, provenance, and drift-status services, establishing one behavioral core for profile UI and future subagent preparation.
- Package metadata now declares Node.js 22.19+ and support for `@earendil-works/pi-*` 0.80.6 through 0.80.x; matching development dependencies are pinned for reproducible verification against the current Pi runtime.
- The roadmap now records the implemented profile v1 contract and moves forward to profile UI and a narrow runner-independent subagent adapter.

## [0.3.2] - 2026-07-07

### Added

- **Global forge extensions.** pi-forge now loads trusted macro/slot registration modules from `~/.pi/forge/extensions` before project-local `.pi/forge/extensions`, so users can keep personal custom macros and slots available across projects without importing `@zihanw/pi-forge`.

### Changed

- `/preset list` now shows both global and project forge extension directories.
- Documentation and examples now describe global and project-local forge extension placement.
- No breaking changes.

## [0.3.1] - 2026-07-07

### Added

- **Parser-backed macro expansion.** Macros now support nested `{{...}}` expressions and split `::` arguments only at the current macro depth.
- **Macro filters and lazy conditionals.** Added `{{trim}}`, `{{upper}}`, `{{lower}}`, `{{json}}`, `{{xml}}`, plus lazy `{{ifvar}}`, `{{ifeq}}`, `{{iftools}}`, and `{{ifslot}}` conditionals. Skipped conditional branches are not expanded, so they cannot mutate variables.
- **Trusted custom macro and slot APIs.** Added `registerMacro`, `registerSlot`, `getRegisteredMacros`, `getRegisteredSlots`, shared render helpers, and process-global registries so trusted Pi extensions can add custom macros and slots without embedding executable code in stack JSON.
- **Project-local forge extensions.** Added trusted `.pi/forge/extensions` modules for project-local macro/slot registration. pi-forge loads them before stack validation, reloads them on `/preset reload`, and lists loaded files or load warnings in `/preset diagnostics`.
- **Example custom extension.** Added `examples/custom-system-status-extension`, which registers a `{{cpuLoad}}` macro and `machine-status` slot from a project-local forge extension module.
- **Slot registry and date-time option.** Built-in slots now use the public slot registry, and `date` / `date-cwd` slots support `includeTime: true`.
- **Web editor: new stack workflow.** The browser can create a stack even when no stack files exist yet. New stacks start from the default Pi prompt mirror layout so users can edit a complete working stack instead of a blank skeleton.
- **Web editor: policy resource picker.** The Policy tab now lists registered tools and loaded skills, marks active tools and hidden skills, hides exact selected names from the available list, supports removable selected-pattern chips, and includes a filter/autocomplete input for adding exact names while keeping wildcard/manual textarea editing.
- **Web editor shortcuts.** Added browser shortcuts for new stack, save, validate, preview, and closing dialogs/inspectors.
- **Web editor item actions.** Added direct Add block and Add slot actions.
- **Read-only web resource inventory API.** Added editor host support for listing known tools and skills for UI policy editing.

### Fixed

- **Package install exports.** Installs now load compiled `dist` JavaScript instead of raw `.ts` files under `node_modules`, so `import { registerMacro, registerSlot } from "@zihanw/pi-forge"` works for reusable trusted extension packages without relying on Node TypeScript stripping. Git installs include the compiled output and do not require TypeScript during Pi's `npm install --omit=dev` step.
- **Preview policy simulation.** Web preview now compiles with the edited stack's tool policy applied to selected tools, snippets, and tool guidelines. This prevents preview from showing unrelated tool guidelines from the current Pi tool state.
- **Empty-project web editor UX.** Empty stack directories now show a create/import path instead of leaving the editor in a dead-end state.

### Changed

- Documentation and feature inventory now describe the 0.3.1 web editor workflow.
- No breaking changes.

## [0.3.0] - 2026-06-30

### Breaking Changes

- **Tool/skill policy no longer allows mixed `allow` and `deny` lists.** Each resource policy (`tools`, `skills`) must use either `allow` **or** `deny`, not both. Stacks with non-empty mixed lists now produce validation errors. Previously, concrete `allow` patterns silently took priority over `deny`. Update your stack JSON to use one list per resource.
  - Before: `{ "tools": { "allow": ["read", "bash"], "deny": ["*"] } }`
  - After: `{ "tools": { "allow": ["read", "bash"] } }` or `{ "tools": { "deny": ["write"] } }`
- `PromptResourcePolicy` type changed from `{ allow?: string[]; deny?: string[] }` to a discriminated union: `{ allow?: string[]; deny?: never } | { allow?: never; deny?: string[] }`.

### Added

- **Regex transforms.** Deterministic JavaScript `RegExp` find/replace on prompt text, ordered as stack-level `regex.rules`.
	  - `stage: "history"` — transforms messages inserted by the `chat-history` slot, with role filters, depth filters, `maxMessages`, and `maxChars`.
	  - `stage: "compiled"` — transforms final system prompt and/or message text before provider serialization, with `targets`, role filters, depth filters, `maxMessages`, and `maxChars`.
	  - `trimStrings` supports deterministic SillyTavern-style Trim Out behavior for expanded replacement matches/captures.
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
- **Chat-history controls.** `chat-history` slots can opt into `stripAssistantThinking: true`, summary omission, role filters, `toolMode: "drop"`, `maxMessages`, and `maxChars`. Filtering/trimming repairs dangling tool calls/results before model-bound history is sent.
- **Prompt-stack storage migration.** New stacks write to `.pi/forge/prompt-stacks/`; legacy `.pi/prompt-stacks/` remains readable and is shadowed by same-named forge files. `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` copies legacy stacks into forge storage.
- **SillyTavern regex import.** Safe `promptOnly` regex scripts are converted into pi-forge outgoing `history` regex rules during import, including `{{match}}` / `$0` full-match conversion, trim strings, depth fields, clear user/assistant placement mapping, and preserved `source.sillytavern` metadata. Display-only, mixed, JavaScript, DOM/browser, CSS/HTML decoration, and unsupported-placement scripts remain report-only with migration notes.
- **`/preset ui` server reuse.** Existing same-project editor servers are reclaimed after extension reinitialization from session navigation or new-session flows, preventing orphaned servers.
- **`/payload next [save=<path>]` command.** Displays and optionally saves the next redacted/truncated provider payload with char/token estimates.
- **`/preset migrate-stacks` command** with `--dry-run`, `--overwrite`, and `--delete-legacy` options.

### Changed

- **Web editor architecture split.** `src/web-editor.ts` split into `src/web-editor/` module folder (`index.ts`, `types.ts`, `server.ts`, `page.ts`). `src/index.ts` split into `src/web-host.ts` (stack CRUD/web-editor host) and `src/payload-capture.ts` (provider payload redaction/capture).
- **Prompt state removed before 0.3.0 release.** pi-forge now keeps template variables and SillyTavern-style variable macros, but no longer exposes stack `state.definitions`, `/state`, `/preset vars`, `forge_state_set`, `forge_set_var`, state metadata rendering, or web runtime state editing.
- **Context rewrite** limited to the first provider request of each user-submitted turn, avoiding repeated injection after tool calls.
- **`/preset import-silly`** now detects `{{lastUserMessage}}` and configures chat history accordingly. SillyTavern `{{setvar}}`/`{{getvar}}` macros reported as handled instead of migration-needed.
- **`/preset reload`** preserves explicit disabled selection instead of reactivating `default.json`.
- SillyTavern import reports now include `extensions.regex_scripts` counts, prompt/display classification, script names, per-script conversion warnings, and migration notes.

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
