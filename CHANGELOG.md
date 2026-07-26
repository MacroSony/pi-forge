# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
In 0.x development, breaking changes may occur in minor releases and will be explicitly noted.

## [Unreleased]

### Changed

- Updated the exact supported `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui` package set from 0.80.10 to 0.82.1. The full core, browser, type, generated-client, distribution, and package verification surface passes against Pi 0.82.1.

## [0.4.0-beta.1] - 2026-07-18

### Added

- **Main-agent profile discovery.** Added the no-egress `forge_subagent_profiles` tool. It returns loaded profile IDs, names, descriptions, declared model/thinking/stack metadata, ready/unavailable resolution diagnostics, and whether parent policy currently exposes `forge_subagent`, without preparing a child prompt or contacting a provider.
- **Approval-gated foreground subagents.** Added the model-callable `forge_subagent` tool and moved `/forge-agent run` onto the same prepare-review-execute path. Every run prepares an immutable exact plan before provider transport. `/forge-agent run` and the default tool path show a compact task/profile/provider/model/thinking/tool/boundary/fingerprint summary, permit on-demand inspection of the full provider-bound prompt, and require explicit interactive human approval.
- **Explicit unattended tool authorization.** Trusted projects may set `subagents.allowAgentInvocationWithoutApproval: true` in `.pi/forge/config.json` to let the parent agent invoke only the model-callable `forge_subagent` tool without per-run UI. Profile discovery exposes the active mode, result receipts record `trusted-project-config`, and missing, malformed, or untrusted-project settings fail closed.
- **Read-only Pi subprocess backend.** Added the experimental `pi-subprocess-readonly` backend as the extension default. It runs one sequential foreground Pi subprocess with a clean conversation and only stack-filtered `read`, `grep`, `find`, and `ls` tools; write, edit, shell, skills, templates, context files, and third-party extensions are disabled.
- **Inspectable subagent reports.** Foreground progress and bounded output now return through a normal Pi tool call result. Expandable result details retain the approval receipt, plan summary, normalized response, diagnostics, usage, bounded transcript tail, and tool calls/results while the full compiled prompt remains transient unless the user explicitly opens it before approval.
- **Explicit shared-user execution boundary.** Access receipts can now distinguish isolated execution from a shared-user subprocess. The latter cannot claim mount, symlink, process, or network isolation and documents that read-only model tools do not reduce the child process's operating-system permissions.
- **Public API classification.** Added a dedicated experimental `@zihanw/pi-forge/subagent` entry point and documented stable, experimental, and internal compatibility surfaces while preserving existing package-root exports.
- **Optional subagent backend registry.** Added empty-by-default validated backend registration, accepted-preflight binding, exact/backend-assisted preparation dispatch, execution and cancellation arbitration, host-abort timeout handling, failure normalization, and authorization-scoped trace routing. Deterministic fake-backend conformance tests cover the full adapter status and enforcement matrix.
- **Experimental isolated Pi SDK backend.** Added a pi-forge-owned, text-only `pi-sdk-isolated` adapter backed by an in-memory Pi `AgentSession`. It accepts only access `none`, advertises no agent tools or stored artifacts/traces, blocks provider transport until exact host preparation and immutable-plan validation complete, and cleans up temporary runtime state after execution or discard.
- **Human subagent test commands.** Added `/forge-agent backends`, `/forge-agent plan <profile> <task>`, and `/forge-agent run <profile> <task>`. Dry planning exercises the complete request pipeline without provider transport; TUI execution requires explicit provider-egress confirmation and returns a compact normalized response.

- **Native one-shot agent profiles.** Project profiles under `.pi/forge/agent-profiles` store an exact model, thinking level, and prompt-stack reference. `/profile use` preflights and applies once, `/profile save` captures the current runtime, and list/status/preview/validate/reload/forget commands cover diagnostics, drift, direct file editing, and branch-scoped provenance without automatic reapplication.
- **Profile resolution API.** Exported strict profile types, loading, validation, exact model/auth/thinking/stack resolution, fingerprints, provenance guards, and diagnostics for future subagent adapters without adding a runner dependency. Prompt stacks remain the single source of truth for tool policy and model-visible skill filtering.
- **Fresh-session profile auto-activation.** One profile may opt into `autoActivate: true` to apply its model, thinking level, and prompt stack once for each fresh session. Profile selection takes precedence over standalone stack autoload, restored branch state remains authoritative, and invalid or ambiguous startup profiles fail closed without producing a hybrid configuration.
- **Browser-level editor smoke coverage.** CI now launches the real localhost editor in headless Chrome and verifies load, metadata editing, validation, policy guidance, save, and browser-console behavior.
- **Runner-neutral subagent adapter contract.** Exported pure request, host-resolution, backend-preflight, backend-assisted preparation, execution-plan, enforcement-receipt, and discriminated response APIs. The contract includes custom macro/slot dependency receipts, effect-aware tool negotiation, protected task/media assembly, deterministic UTF-8 context budgeting, canonical `sha256:v1` fingerprints, and access/limit/status/artifact/trace validators without registering a backend or adding parent run tools.
- **Internal Pi SDK adapter spike.** Added an opt-in dry-run/execute harness that validates real profiles, exact lifecycle prompt preparation, in-memory sessions, no-access execution, timeout abort, media transport, and trusted custom registrations against Pi 0.80.6.

### Fixed

- **Terminal subprocess cancellation.** Cancelled and timed-out registry responses now wait for backend execution to drain. The subprocess backend awaits child closure with bounded TERM-to-KILL escalation during cancellation and disposal, terminalizes pre-spawn failures, and removes temporary run data before the foreground result settles.
- **Bounded retained subagent transcripts.** Retained transcript strings are capped, base64-like text is redacted in addition to canonical image blocks, stderr is bounded, and report messages keep a 512 KiB rolling tail with explicit omission metadata. This prevents pathological textual output from recreating the TUI/session lag caused by the original inline-image transport.
- **Binary-safe subagent image reports.** The child no longer sends Pi's complete JSON lifecycle stream to the parent, where repeated inline image blocks could exceed the 8 MiB transport limit and make the TUI retain megabytes of base64. A dedicated sanitized report channel preserves images inside the child for vision-provider requests, emits only image metadata to the parent, and defensively sanitizes the retained tool details again.
- **Pi 0.80.10 subagent authentication.** Subagent preparation now reuses the parent `ModelRuntime` when creating its temporary `AgentSession`, preserving the parent's OAuth/API-key state instead of passing session options that Pi 0.80.10 ignores. An offline regression test covers the extension's real model-registry-only path.
- **Fail-closed subagent egress consent.** `/forge-agent run` and the default `forge_subagent` path refuse non-UI execution instead of treating the absence of an interactive confirmation surface as approval. Only the explicit trusted-project unattended setting bypasses the tool's per-run UI. Exact preparation remains behind a closed provider gate, and dry planning remains available without provider transport.
- **Cancellation before backend dispatch.** An external abort that wins before backend execution now discards the prepared backend state without calling `execute()`. Concrete Pi SDK cancellation and host-timeout tests verify `AgentSession` abort and temporary-runtime cleanup.
- **Web editor lifecycle refresh.** Reused editor servers now bind ordinary lifecycle contexts separately from snapshotted system-prompt options, so resource inventory and preview remain available after startup reload, tree navigation, compaction, and extension reinitialization.
- **Trusted extension disposal and reload.** Runtime shutdown unregisters owned custom macros and slots before replacement. Every ESM load receives a process-unique cache token, while CommonJS entry caches are cleared, so `.ts`, `.mjs`, CommonJS `.js`, and `.cjs` extension edits reload without duplicate registrations or stale entry code.
- **Strict prompt-stack input validation.** Behavior-changing booleans, enums, defaults, context fields, variables, and item shapes are diagnosed before recovery normalization. Malformed values can still be displayed for repair but can no longer become an automatically usable stack.
- **Immutable stack identity on save.** Existing stack IDs are read-only in the web editor, and the save API rejects body/URL ID mismatches without writing files or changing active selection. Fork remains the supported way to create a new ID.
- **Token-accounting payload visibility.** Provider payload redaction preserves known token limits, usage counters, budgets, and tokenizer metadata while continuing to hide generic and credential-shaped token fields.
- **Tool policy restoration and enforcement across Pi reload.** pi-forge now restores the pre-policy active tool set during extension shutdown, waits for other extensions to finish their startup tool configuration before recapturing it, and reapplies restrictive policy before input and turns. A tool-call guard blocks disallowed execution even if another extension later calls `setActiveTools()`. This prevents both missing built-ins after `/preset use none` and late-added extension tools bypassing an active stack policy.
- **Skill-policy semantics.** Validation, documentation, and editor guidance now state that skill policy filters model-visible pi-forge skill listings; it does not disable explicit skill invocation and is not a security boundary.

### Changed

- The npm tarball no longer includes physical `src/` files and uses compiled runtime entries. Legacy `@zihanw/pi-forge/src/*` imports continue to resolve to compiled modules, while development documentation directs source modifications through a repository clone and explicit local TypeScript extension entry.
- The extension entry point is now a small composition root; prompt-stack state, one-shot profile activation, tool-policy/preview behavior, and shared web-editor lifecycle live in focused runtime modules.
- The web editor client is authored as strict TypeScript modules for API transport, DOM access, policy editing, regex editing, preview/payload inspection, and orchestration. A build-only esbuild step produces the self-contained script used by the localhost editor, and verification rejects stale generated output.
- The subagent contract implementation is split into focused type, canonicalization, request, preflight, tool, context, plan, response, and diagnostic modules. Existing package-root and `src/subagent-contract.ts` exports remain compatibility barrels with an exact import-surface test.
- Backend-assisted preparation now makes the adapter, rather than the caller, provide the complete runtime compiler inputs. The registry fingerprints and validates that runtime, invokes the host compiler exactly once, binds the resulting prompt/messages/tools to execution, routes discard through the owning backend, and rejects adapters or callers that bypass, alter, or refingerprint a substitute host result.
- Profile commands now consume shared typed repository, application, preview, provenance, and drift-status services, establishing one behavioral core for profile UI and future subagent preparation.
- Package metadata now declares Node.js 22.19+ and pins the Pi peer/runtime/development packages to exactly 0.80.10. Pi changed session runtime wiring within 0.80.x, so this beta no longer claims compatibility with 0.80.6–0.80.9 or unverified later 0.80.x releases.
- The roadmap now records the approval-gated foreground subprocess path and moves forward to sandboxing, staged writes, profile UI, and release hardening without adding background orchestration.

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
