# Implemented feature inventory

This file tracks the currently implemented feature surface for agent profiles, the prompt-stack runtime, static stack variables, web editor, storage migration, payload inspector, and regex MVP.

## Package and Runtime

- Pi package manifest with compiled `dist/index.js` exposed through `package.json` `pi.extensions`.
- Public npm package configuration for `@zihanw/pi-forge`.
- Compiled npm runtime containing JavaScript, declarations, documentation, and examples without physical `src/` files; repository source remains available for clone-based development.
- Tarball verification rejects physical `src/` entries and requires the root and subagent compiled entry points.
- The web editor's HTML page shell and static styles are maintained separately from its browser behavior modules.
- Strict typed web-editor client modules bundled into one self-contained browser script at build time, with generated-client consistency verification.
- Supported Node.js baseline is 22.19+. Published Pi SDK dependencies are host-provided wildcard peers; exact repository versions are reproducible development/test fixtures rather than runtime constraints.
- Project trust check before loading prompt stacks.
- Footer status showing the active prompt stack.

## Agent Profiles

- Strict schema-versioned project profiles from `.pi/forge/agent-profiles/*.json`.
- Profile v1 stores an exact provider/model reference, thinking level, and prompt-stack ID or `null`, with optional name, description, and fresh-session auto-activation metadata.
- Unsupported fields are errors so unimplemented generation, tool, skill, or runner settings cannot become inert configuration.
- Tool policy and model-visible skill filtering remain owned by the referenced prompt stack rather than duplicated in profiles.
- Pure profile resolution checks model existence, configured authentication, thinking-level clamping, prompt-stack validity, and unmatched tool allow patterns before application.
- `/profile use <id>` applies model, thinking level, and prompt stack once after complete preflight; later manual runtime changes are preserved.
- At most one profile may set `autoActivate: true`; it applies once for a fresh session and takes precedence over standalone prompt-stack autoload, while restored branch state takes precedence over both.
- Invalid or ambiguous profile auto-activation fails closed without applying a fallback stack or a partial profile. With no auto-activation profile, existing prompt-stack autoload remains the compatibility fallback.
- Failed application performs best-effort rollback and never records successful provenance.
- `/profile save <id> [--overwrite]` captures current runtime fields without tools, secrets, history, or provenance, preserving existing name/description metadata.
- `/profile preview <id>` reports resolved changes, prompt-stack tool policy, effective tools, and diagnostics without mutation.
- `/profile status` compares the current runtime with the last-applied resolved snapshot and reports source-definition changes separately.
- Last-applied provenance is branch-scoped session metadata used only for drift reporting; reload, resume, tree navigation, and compaction never reapply a profile.
- `/profile reload` reloads definitions without applying them, and `/profile forget` clears provenance without changing runtime state.
- Project trust gates profile loading, application, and writes.
- Shared typed profile services own capture, protected write/update/delete, application/rollback, immutable preview data, provenance changes, and runtime-drift calculation so command, web-editor, and adapter consumers do not duplicate behavior.

## Subagent Adapter Contract

- Dedicated experimental `@zihanw/pi-forge/subagent` entry point, with the existing package-root exports retained for 0.4 compatibility.
- Subagent types, canonicalization, request/preflight validation, tool negotiation, context preparation, plan construction, response validation, and diagnostics live in focused modules behind a compatibility contract barrel.
- Exported pure v1 `AgentRequest`, profile snapshot, backend preflight, execution-plan, enforcement-receipt, and discriminated response types without registering or shipping a runner.
- Backend-independent host profile resolution produces path-free declarative snapshots and does not consult the parent model registry or authentication state.
- Host dependency scanning detects custom macro and slot references, records registration source identities, and fails resolution when required registrations are missing.
- Backend tool negotiation intersects prompt-stack name policy with declared filesystem/process/network effects and per-request access.
- Optional empty-by-default backend registry validates registration and preflight identity, requires the backend to supply a complete fingerprinted prompt runtime, binds the exact host preparation to execution, routes dry-plan discard, rejects unbound or refingerprinted substitute plans, arbitrates cancellation and host timeouts, normalizes failures, and protects opaque trace routing behind authorization-scoped handles.
- Experimental `pi-subprocess-readonly` backend reuses the host Pi runtime for authenticated preparation, then runs a clean foreground Pi subprocess with the exact profile model, thinking level, and compiled prompt. Its candidate model tools are limited to `read`, `grep`, `find`, and `ls`, further filtered by prompt-stack policy; it loads no write/shell tools, skills, prompt templates, context files, or third-party extensions. Host-coupled capability mismatches fail closed during preflight.
- Delegation is an explicit per-profile opt-in under the trusted project's `.pi/forge/subagents.json` `profiles` map; ordinary profile loading/application remains independent. Global profile entries warn and are ignored so project-local profile IDs cannot silently authorize unrelated projects. Disabled and unlisted profiles are omitted from `forge_subagent_profiles` and rejected before preparation by the command, model-callable tool, and concrete runtime.
- The no-egress `forge_subagent_profiles` tool gives the main agent a live catalog of enabled profile IDs, names, descriptions, model/thinking/stack metadata, effective backend/timeout and sources, and ready/unavailable resolution status. It also reports whether the parent tool policy currently permits `forge_subagent`.
- `summaryInToolDescription` (default `false`) embeds a compact, bounded summary of enabled profiles directly in the `forge_subagent` tool description, so the main agent can pick a frequently used profile without a discovery call. Ready profiles sort first, unavailable enabled profiles include their first resolution error, and the summary is capped at 8 profiles and 1,000 characters. It refreshes whenever profiles, stacks, or configuration change and keeps `forge_subagent_profiles` as the authoritative full-detail surface.
- The model-callable `forge_subagent` tool and `/forge-agent run` prepare an immutable plan before provider transport. `/forge-agent run` and the default tool path require explicit human approval; a trusted-project `allowAgentInvocationWithoutApproval` option in `subagents.json` may authorize only the model-callable tool without a per-run prompt. The default review shows the task, profile/stack, provider/model/thinking level, effective tools, working directory, shared-user boundary, payload size, and fingerprint; the complete provider-bound prompt can be opened on demand.
- Backend selection is layered configuration rather than profile schema: `backend` in global/project `subagents.json` supplies defaults, the trusted project's `profiles.<id>.backend` supplies a per-profile override, and `/forge-agent plan|run --backend <id>` or the interactive `forge_subagent` `backend` parameter overrides one run. Both the `pi-subprocess-readonly` and `pi-rpc-readonly` backends are registered; there is no fallback when the selected backend is unavailable, and unattended tool invocation is pinned to the effective configured profile backend.
- Foreground timeout is layered host configuration rather than profile schema: `timeoutMs` in global/project `subagents.json` supplies a 60,000-millisecond default and `profiles.<id>.timeoutMs` can override it per profile; values must be from 1,000 through 3,600,000 milliseconds. Invalid values warn and preserve the preceding valid/default value; discovery, planning, and approval surfaces show the effective best-effort timeout and source.
- Foreground progress and the bounded final report enter the normal tool-call result. A dedicated child report channel retains the normalized response, complete text transcript, tool calls/results, diagnostics, usage, approval receipt, and execution report without persisting the full prompt or inline image data; omitted images retain MIME and encoded-size metadata.
- The subprocess backend is explicitly shared-user rather than OS-sandboxed: read-only is a tool policy, host timeout/cancellation are best effort, and `/tree` reverts conversation state rather than provider egress, billing, or external side effects.
- `/forge-agent backends` and `/forge-agent plan <profile> <task>` expose backend discovery and provider-free exact dry planning to a human.
- Deterministic fake-backend conformance coverage exercises accepted/rejected preflight, tool effects, access/limit refusal, exact preparation, success/failure, cancellation races, timeout, media, artifacts, and traces. An offline faux-provider test additionally executes the concrete SDK backend through a real Pi `AgentSession` without network traffic.
- Selected parent context uses explicit provenance and deterministic exact UTF-8 budgeting; required items survive, optional items are selected newest-first, and the complete delegated text/media task remains the protected final user message.
- Granular validators cover request access/depth/media/limits, backend capabilities and enforcement, prompt-runtime fidelity, plan correlation, all response terminal statuses, usage units, artifact namespaces/paths, and authorized trace handles.
- Portable profile, prompt-stack, and complete execution fingerprints use canonical `sha256:v1` serialization without changing legacy branch-provenance fingerprints.
- The opt-in internal Pi SDK spike remains available for broader live diagnostics, including media and trusted custom registrations beyond the shipped text-only walking skeleton.
- Adapter responsibilities and unsupported runner behavior are documented in the [subagent adapter contract](subagent-adapter.md).

## Prompt Stack Loading and Storage

- File-backed prompt stacks from `.pi/forge/prompt-stacks/*.json`.
- Legacy `.pi/prompt-stacks/*.json` stacks remain readable and editable for compatibility.
- Same-named files in `.pi/forge/prompt-stacks` shadow legacy stack files.
- New stacks, imports, and forks write to `.pi/forge/prompt-stacks`.
- Trusted global and project-local macro/slot registration modules load from `~/.pi/forge/extensions` and `.pi/forge/extensions` before stack validation and reload on `/preset reload`.
- Trusted registration ownership is disposed during runtime shutdown, and supported ESM/CommonJS extension entry formats reload with fresh module code.
- `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` copies legacy stacks into the forge storage location.
- `default.json` auto-activation unless `autoActivate` is `false`.
- Branch-aware persisted active stack restore from session entries.
- Persisted `/preset use none` / `off` opt-out.
- Invalid stacks with error diagnostics are skipped by automatic selection.
- Raw stack fields are shape-checked before recovery normalization, including behavior-changing booleans/enums, defaults, context, variables, and item fields.
- Stack validation for duplicate item IDs, duplicate stack IDs, unsupported slots, missing chat-history slots, and ignored items.
- Stack validation for tool and skill policy shape.

## Prompt Compilation

- `replace`, `append`, and `prepend` system prompt modes.
- Empty replacement system prompt fallback to Pi's base system prompt.
- Enabled item ordering preserved during compilation.
- Movable `chat-history` slot in message layout.
- Optional omission of latest user message from chat history.
- Optional stripping of prior assistant thinking blocks from inserted chat history while preserving visible text, tool calls, and tool results.
- Chat history can filter summaries/roles, drop prior tool history, and cap recent history by message count or approximate characters with dangling tool calls/results repaired after filtering.
- Duplicate chat-history warning unless explicitly allowed.
- Synthetic `user`, `assistant`, and hidden `custom` messages.
- Context rewrite limited to the first provider request of each user-submitted turn.
- Tool policy filters Pi's active tool list while the stack is active and restores the previous active tools when the stack no longer applies.
- Tool policy restores its pre-policy baseline during extension shutdown so Pi reload/session replacement cannot carry a restricted built-in tool set into the replacement runtime.
- Startup tool enforcement waits until extension `session_start` configuration is complete, reasserts before user input and turns, and blocks disallowed model tool calls at execution time.
- Skill policy filters skills rendered by pi-forge `skills` slots.
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
- `effect: "outgoing"` and `"finalize"` are the only valid effects; `"display"` and `"both"` are rejected during validation.
- Streaming display is not transformed; raw text may be visible until the final message replacement happens.
- Message transforms support role filters, `maxMessages`, `maxChars`, `minDepth`, `maxDepth`, and `trimStrings`. `$0` is supported as a full-match alias for `$&` in replacements.
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
- `date` and `date-cwd` slots can include `Current time: HH:MM:SS` with `includeTime: true`.
- Runtime slots are registered through the same `registerSlot` definition interface used by trusted custom slots.
- Trusted `~/.pi/forge/extensions` / `.pi/forge/extensions` modules and reusable Pi packages can register additional runtime slots through `registerSlot`, with declarative option schemas and shared render helpers.

## Tool and Skill Policy

- Stack-level `tools.allow` / `tools.deny` policy.
- Stack-level `skills.allow` / `skills.deny` policy.
- Policy entries support exact names and `*` wildcards.
- Each resource uses either `allow` or `deny`; non-empty mixed lists are validation errors.
- Tool policy is enforced with `pi.setActiveTools()` and restored when prompt stacks are disabled or switched to an unrestricted stack.
- Tool policy preserves later extension tool additions in the restorable baseline while keeping them filtered from an active restrictive stack.
- A `tool_call` guard blocks tools outside the active stack policy even if another extension later changes Pi's active tool list.
- Rendered `tools` slots, template paths such as `{{ runtime.selectedToolsText }}`, and `tool-guidelines` respect stack tool policy.
- Rendered `skills` slots respect stack skill policy and continue to hide skills marked `disableModelInvocation`.
- Skill policy controls model-visible skill listings rendered by pi-forge; it does not disable explicit skill invocation and is not a security boundary.
- Validation warns when skill policy is used with `append` or `prepend` mode because Pi's base prompt may already include unfiltered skills.

## Macros (forge-v1)

- Prompt text is compiled with the closed `forge-v1` template engine (parse → analyze → render).
- Runtime facts resolve through `{{ runtime.* }}` (cwd, date, time, lastUserMessage, selectedToolsText, activeModel, tool/slot booleans).
- Static values resolve through `{{ parameters.* }}`; schema v2 stores them in `parameters` while v1 stacks read legacy `variables`.
- Custom macros resolve through `{{ extensions.<name> }}` and are registered via the pure `registerMacro` extension port with declared dependencies and bounded output.
- Filters: `trim`, `upper`, `lower`, `json`, `xml`, composed with `|` pipelines.
- Conditionals: `{% if path %}...{% else %}...{% endif %}` with `==` / `!=` string comparisons over template paths.
- Undefined paths, unknown filters, parse errors, cycles, and output-limit breaches are compile errors; a failing block is omitted rather than re-injected.
- Legacy v1 stacks keep a bare-name compatibility fallback (`{{name}}`, `{{lastUserMessage}}`, `{{date}}`, ...) that maps to the corresponding parameter/runtime path.
- `getRegisteredMacros()` and `getRegisteredSlots()` expose active definitions for inspection.

## Parameters

- Schema v2 stacks store immutable JSON-compatible values in top-level `parameters`.
- Schema v1 / unversioned stacks read the legacy string-only `variables` field and support bare `{{name}}` fallback.
- Parameters resolve through `{{ parameters.<name> }}` and are available to trusted custom macros/slots through the frozen environment.
- Mutable turn/session stores, variable mutation macros, session variable entries, and the `variables` slot are removed in 0.5.0.

## Commands

- `/profile list`
- `/profile use <id>`
- `/profile save <id> [--overwrite]`
- `/profile status`
- `/profile preview <id>`
- `/profile validate [id]`
- `/profile reload`
- `/profile forget`
- `/forge-agent backends`
- `/forge-agent plan <profile> <task>`
- `/forge-agent run <profile> <task>`
- `/preset list`
- `/preset status`
- `/preset use <id|none>`
- `/preset preview [id]`
- `/preset validate [id]`
- `/preset diagnostics`
- `/preset reload`
- `/preset ui [stop|restart]`
- `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]`
- `/intercept`
- `/payload next [save=<path>]`

## Debugging and Tests

- `/intercept` displays the next provider payload with redaction/truncation for secrets and large data.
- `/payload next save=<path>` displays and saves the next redacted/truncated provider payload with char/token-ish size estimates.
- Payload redaction preserves known token limits, accounting counters, budgets, and tokenizer names while retaining credential-shaped token redaction.
- The web editor can arm, poll, clear, and inspect the next redacted provider payload in a full-screen collapsible JSON inspector.
- Runtime compile diagnostics are visible through a footer status and `/preset diagnostics`.
- `/preset ui` starts a token-protected localhost web editor for stack management.
- Node built-in tests cover agent-profile resolution/application/provenance, compiler, loader, regex, and the command/event harness.
- Tests cover regex validation, history-stage transforms, compiled-stage transforms, finalize transforms, replacement syntax, trim strings, depth limits, role/message/char limits, and preservation of non-text message parts.
- Tests cover subagent host resolution, custom dependency detection, all access/required-limit/terminal-status matrices, effect-aware tool negotiation, context budgeting, protected media tasks, canonical fingerprint tamper detection, and malformed external contract values.
- A real headless-Chrome smoke test covers editor load, dirty state, metadata editing, policy and regex editing, validation, save, disk persistence, export, import, and browser-console errors.
- TypeScript strict typecheck passes.
- Package dry-run verifies published tarball contents.

## Web Stack Editor

- `/preset ui`, `/preset ui restart`, and `/preset ui stop`.
- Local editor server bound to an available `127.0.0.1` port by default with a random URL token.
- Preferred editor port can be configured through `.pi/forge/config.json` using `webEditor.port`; if it is unavailable, pi-forge falls back to an available port.
- Existing same-project editor servers are reclaimed after extension reinitialization from session navigation/new-session flows, so `/preset ui` reuses the current URL instead of opening a second port.
- Resource inventory and preview remain usable when a reclaimed editor host is refreshed from lifecycle contexts that do not expose command-only prompt APIs.
- Stack list with active/error/warning indicators.
- Collapsible prompt-stack sidebar.
- Collapsible stack metadata panel and main-area tabs for Items, Regex, Policy, and Stack JSON/context/variables work.
- Light/dark theme toggle, button icons, and tooltips for common actions.
- Unsaved-change badge in the top bar.
- Create a new prompt stack from the browser, including when no stack files exist yet; new stacks start from the default Pi prompt mirror layout.
- View immutable stack ID and edit name, mode, `autoActivate`, description, and existing stack file content; use Fork to create a new ID.
- Edit stack `context` options from a structured dialog.
- Edit stack static `variables` from a structured table.
- Edit stack `regex.rules`, including order, stage, effect, targets, roles, limits, depth, trim strings, pattern, flags, replacement, and runtime warnings.
- Policy editor lists registered tools and loaded skills, hides exact selected names from the available list, and supports removable selected-pattern chips plus filter/autocomplete input.
- Reorder items by drag-and-drop.
- Add block and slot stack items directly.
- Delete stack items.
- Toggle item enabled state from the item list.
- Inline item validation badges when diagnostics point at a specific item.
- Edit block content in a full-height text editor area.
- Edit slot kind, role, slot type, and common slot options through form controls.
- Fall back to raw JSON editing for advanced slot options.
- View, copy, and apply raw stack JSON as a recovery path for advanced stack-level fields.
- Validate and inspect edited stack JSON before saving.
- Full-screen structured preview inspector with collapsible system/message sections, char/token estimates, and copy controls.
- Arm and inspect the next provider payload from the web editor; captures triggered by `/payload next` are also available to the browser while the editor is open.
- Provider payload inspector shows top-level JSON sections, redacted full text, char/token estimates, and copy controls.
- Save existing stack JSON and immediately reload pi-forge stack data.
- Save rejects attempts to change an existing stack ID before writing or changing active selection.
- Keyboard shortcuts for new stack, save, validate, preview, and closing dialogs/inspectors.
- Import native pi-forge stack JSON into `.pi/forge/prompt-stacks`.
- Export the current edited stack JSON from the browser, with clipboard fallback when download is unavailable.
- Fork the current stack into a new stack file, with optional activation.
- Delete stack files, disabling prompt-stack replacement if the deleted stack was active.
- Trust and path guardrails for save/import/fork/delete writes.
- Top-level navigation between prompt stacks and project agent profiles; stack drafts, selection, and active state survive surface switches.
- Profile list shows ID, name, model/thinking/stack targets, validation state, `autoActivate` and last-applied badges, and a `subagent` badge for delegation-enabled profiles.
- Profile create, edit, validate, save, one-shot apply, and delete reuse the shared resolver, transactional application service, and guarded repository; save rejects a second auto-activation profile and on-disk conflicts.
- Profile form populates provider/model choices from the model registry and stack choices from the shared stack repository, and shows resolution diagnostics for missing models, authentication, unsupported thinking levels, invalid stacks, and unmatched tool policy.
- A runtime/provenance card distinguishes current runtime, last-applied provenance, source-definition state, and per-field runtime drift after external model, thinking-level, or stack changes.
- The main web editor no longer ships a delegation card; delegation configuration is owned by the optional `@zihanw/pi-forge-subagents` package through `.pi/forge/subagents.json`.
- Smoke tests cover editor server token checks, bundled page/script markers, save, payload arm/capture/clear, create/fork, native JSON import, collision handling, delete, and stop behavior.
