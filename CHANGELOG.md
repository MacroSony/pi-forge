# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
In 0.x development, breaking changes may occur in minor releases and will be explicitly noted.

## [0.5.0] - 2026-08-21

### Planning

- Replaced the proposed six-phase 0.5.0 plan with the accepted [lean 0.5.0 architecture plan](docs/design/architecture-0.5.md). The original full proposal and Phase-0 evidence are archived under [docs/design/archive/0.5-full-proposal/](docs/design/archive/0.5-full-proposal/README.md) and remain the long-term target.
- Accepted lean 0.5.0 decisions: complete SillyTavern removal; mutable-variable removal; `forge-v1` with a redesigned pure trusted-extension port; regex `display`/`both` removal while `finalize` is retained under lifecycle-adapter ownership; minimal repositories/codecs with fingerprint and atomic writes deferred; minimal `ForgeWorkspace`; versioned `/subagent` host port with mandatory lifecycle semantics; optional `pi-forge-subagents` package without main-package delegation UI and with dedicated `subagents.json` files; explicit root default, root named extension API, and `/subagent` surfaces.

### Removed

- SillyTavern importer, `/preset import-silly`, its reports, guide, example, and tests are removed. 0.4 is the last supported conversion path.
- Mutable turn/session variable stores, `pi-forge-variable-state` session entries, set/get/clear variable macros, and the `variables` slot are removed. Static reusable values now live on stack `parameters` in schema v2 or legacy `variables` in v1.
- Regex `display` and `both` effects are removed and rejected as validation errors; only `outgoing` and `finalize` remain.
- **Breaking (Lane 4b): legacy package surfaces.** All `@zihanw/pi-forge/src/*` compatibility aliases and the `./examples/*` subpath export are removed. The package root now exports exactly the default Pi extension factory plus `registerMacro`/`registerSlot` and their contract types (`PromptEnvironment`, `PromptRenderHelpers`, macro/slot definition and renderer types, option-schema types, and the trusted project extension API types). `@zihanw/pi-forge/subagent` is the only other entry point. `check-package` enforces the allowlist and forbids legacy aliases.

### Changed

- Prompt compilation uses the `forge-v1` parse/analyze/render engine with a frozen `PromptEnvironment` (`runtime.*`, `parameters.*`, `extensions.*`). Preview, runtime, and subagent preparation share the same compiler entry.
- `registerMacro` and `registerSlot` move to a pure-contract extension port with immutable `env`, declared dependencies, bounded output, and strict undefined-path errors.
- Prompt-stack schema v2 introduces immutable `parameters`; unversioned/v1 stacks continue to read through the legacy `variables` field.
- `finalize` regex remains lifecycle-owned and is excluded from preview, which now reports an informational diagnostic.
- Legacy 0.4 nested macro syntax (for example `{{upper::x}}`, `{{json::...}}`, `{{iftools::...}}`) is no longer executed by the compiler and must migrate to forge-v1 syntax.
- Compiler/extension conformance (Lane 1d): custom slots share the pure `{ item, options, env, helpers }` contract with declared `dependencies` and the 16,384-character output limit; `env.extensions` is resolved for slots; a shared dependency analysis and one compilation context keep preview/runtime/subagent consistent; extension values resolve lazily per active branch; nested `{% if %}` and empty-string comparisons are supported.
- Subagent extraction (Lane 3): the `forge_subagent`/`/forge-agent` execution surface, the web-editor delegation UI, and all subagent configuration reads/writes are removed from the main package and move to the optional `@zihanw/pi-forge-subagents` package, which discovers the active host through the versioned `/subagent` port and owns its own `subagents.json`. Packed-install smoke tests cover main-only and main-plus-optional installs (`check:packed`).
- Host-neutralization (Lane 3.5): the prompt compiler's rendering and preflight contract is fully host-neutral (capability-driven, no subagent-specific branches), `ForgeWorkspace` is the single owner of resource state and compilation contexts (no second loader/registry path), and subagent documentation/configuration alignment was completed for the optional package split. The packed-install smoke was made portable across checkouts.
- Forge-native host contract (Lane 4a): the main package no longer depends on `@zihanw/pi-subagent-runtime` at all. `@zihanw/pi-forge/subagent` is now exactly the minimal Forge DTO host contract — host-port wire messages, recursive validators, transport, client/host lifecycle, and Forge-owned canonical fingerprint helpers (byte-compatible with the runtime's `sha256:v1` canonical JSON, pinned by golden vectors). The 0.4 execution contract (request, preflight, plan, response, context budgeting, tool negotiation, and validators) moves to `@zihanw/pi-forge-subagents` with names unchanged, importing portable leaves from the runtime directly. Host-owned preparation no longer synthesizes runtime request/preflight/prompt-runtime artifacts: the workspace resolves the profile and stack from its snapshot, filters the client tool catalog through stack policy, and compiles through the shared compilation context directly. **Breaking:** the package root no longer re-exports subagent contract or host-resolution names (the `/subagent` entry point is the only subagent surface); client-side snapshot validation keeps structural and fingerprint checks while deep profile schema validation remains host-owned.
- Minimum repositories and codecs (Lane 2a): prompt-stack and agent-profile parse/normalize/validate/serialize are centralized in `src/codecs/`, and reads, writes, and deletes all go through scoped repositories (`src/repositories/`) with containment and symlink checks; the loaders and profile service delegate to the repositories, so domain resources are never read or written directly at the adapter layer. Replacement semantics are unchanged and characterized by tests (no fingerprint conflict or atomic replace yet). Legacy stack migration is a documented byte-preserving exception whose raw IO lives inside the repository.
- ForgeWorkspace and host port v1 (Lane 2b): a minimal `ForgeWorkspace` snapshot owner (genuinely immutable, deep-frozen snapshots) over the repositories/codecs, plus a versioned `@zihanw/pi-forge/subagent` host-port protocol over the Pi event bus with the three minimal operations (discovery, profile listing, prepare). Mandatory lifecycle semantics are enforced and covered by tests: bounded timeouts, explicit duplicate-host failure, `hostId`+`generation`-bound request/reply so stale/foreign requests are rejected, disposal/`unavailable`, listener cleanup, host-owned prompt preparation (client sends only profile selector + task + backend facts), and recursive JSON-compatible operation validators. The host is wired into the real extension lifecycle via `pi.events` (host can only start after the first snapshot exists, so availability implies a loaded workspace; `reload` honors project trust; disposal runs before subagent teardown; the base system prompt is host-owned and empty for delegated subagents), with integration tests that discover, list, prepare, and observe disposal through the published `/subagent` surface — including that the host is not advertised before any session start. Operation validators are strict and recursive: exact nested field sets, typed enums, plain-object-only JSON compatibility, and unknown-field rejection — so `allowProcess` is the only process fact and no runtime access/limit/execution material crosses.

- Documentation and migration notes (Lane 4d): the [public API policy](docs/reference/public-api.md) was rewritten for the three intentional entry points; the 0.4 subagent adapter contract reference was replaced by the [subagent host port contract](docs/reference/subagent-host-port.md); the [0.5 migration guide](docs/guides/migrating-to-0.5.md) now covers Lanes 1–4 with a [zh-CN translation](docs/zh-CN/guides/migrating-to-0.5.md); README, setup, getting-started, web-editor, features, and configuration docs were aligned with the optional-package split (EN + zh-CN).

- Strengthened the `/subagent` host-port DTO types (code-review follow-up, no wire-behavior change): `ForgeResolveProfileResponse.snapshot`, `ForgePrepareResponse.messages`/`diagnostics`/`profileSnapshot` are no longer `unknown`. New exported types: `ForgeProfileSnapshot`, `ForgeWireAgentProfile`, `ForgeWirePromptStack`, `ForgeDelegationMessage`, `ForgeDelegationDiagnostic`, `ForgePromptDependency`/`ForgePromptDependencyKind`, `ForgeListProfilesResponse`, `ForgeHostWireMessage`, and a generic `ValidationResult<T>`; the recursive validators now return typed data. Runtime validation is byte-compatible with 0.5.0.

### Fixed

- Profile auto-activation now honors project-over-global shadowing: a global `autoActivate` profile whose ID exists in project scope no longer activates, matching `chooseAutoActivateStack` semantics (0.5.x review A1). Regression test covers explicit opt-out and implicit shadowing.
- The fresh-session startup branch now evaluates auto-activation requests with the same shadow-aware candidacy (A1 follow-up, found by dogfooding): a global `autoActivate` profile shadowed by a same-ID project profile no longer triggers the spurious "multiple agent profiles request auto-activation" error, and the auto-activate stack fallback is no longer skipped in that state.
- Extension macro/slot names may no longer contain `.` — forge-v1 uses dots as path separators, so dotted names were registerable but unreachable (0.5.x review A2). Regression test pins the rejection.
- Static prompt analysis now reports macro dependency cycles as `recursion` diagnostics instead of silently stopping traversal (0.5.x review A5). Regression test pins a single deduplicated diagnostic per cycle.
- Dev/test Pi SDK pins aligned across both repositories at `0.84.2` (0.5.x review A4); the optional package no longer mixes `0.83.0`/`0.84.2` instances in its tree.

- Web editor polish (code-review follow-up): the theme toggle moved from the legacy stacks topbar into the shared surface navigation, so it stays visible and functional on the Agent profiles surface; theme state now lives in a shared `theme.ts` module consumed by both the Vue shell and the legacy bridge. Policy editor rows no longer repeat the column labels on wide layouts (labels return when the grid stacks on narrow screens). Item/main action buttons no longer wrap their own text mid-label, and the item toolbar wraps whole buttons instead of clipping.

## [0.4.1] - 2026-08-17

### Added

- **Scoped global agent profiles and prompt stacks.** Profiles and stacks can now live in the user-owned global forge directory or the trusted project, with project resources shadowing same-ID global resources for bare selectors. Qualified `global:<id>` and `project:<id>` selectors provide exact addressing across commands, saved session state, profile stack references, delegation policy, subagent plans, and the browser editor. Global profiles resolve only global stacks, while project profiles may explicitly reuse global stacks; untrusted projects remain browse-only and cannot auto-activate or delegate resources. The browser editor shows scope and shadow badges, edits/deletes global resources only through explicit `global:<id>` routes, and provides project-default scope selectors for creating profiles and creating, forking, or importing prompt stacks. The zh-CN documentation now covers the scoped model.
- **Parallel foreground subagent invocation.** `forge_subagent` now registers as a parallel-execution tool, so the parent model can issue several calls in one turn and they prepare, approve, and execute concurrently. Pi's single-slot select/editor UI cannot host two dialogs at once, so interactive approval dialogs (including View full prompt) are serialized through a shared gate inside `requestForgeSubagentApproval` — the same gate covers `/forge-agent run` — while approved runs still overlap; unattended trusted-project invocation never enters the gate and is fully concurrent. Each run remains an independent subprocess and provider request, so a burst of parallel calls multiplies provider cost and process load.
- **Embedded subagent profile summary in the tool description.** `subagents.summaryInToolDescription` (default `false`, settable in global or trusted-project config) embeds a compact summary of enabled subagent profiles directly in the `forge_subagent` tool description—id, name, model/thinking level, stack, backend, and timeout—so the parent model can pick a frequently used profile without a `forge_subagent_profiles` discovery call. Unavailable enabled profiles stay visible with their first error so the model does not attempt them, ready profiles sort first, and the block is capped at 8 profiles and 1,000 characters. The description re-registers only when the rendered summary changes (profiles, stacks, or configuration), so per-turn lifecycle refreshes are no-ops, and disabling the option reverts the description to the base form. `forge_subagent_profiles` remains the authoritative full-detail surface.

## [0.4.0] - 2026-08-02

### Added

- **Per-profile subagent delegation in the browser editor.** Each profile now has a delegation card that reports its effective delegation state, backend, timeout, and sources, and trusted projects can toggle the `subagents.profiles.<id>` opt-in with backend and timeout overrides without hand-editing `.pi/forge/config.json`. The editor writes the project config while preserving unrelated keys and removing emptied entries, warns when the effective backend is not registered, marks delegation-enabled profiles with a `subagent` badge, and keeps project defaults and `allowAgentInvocationWithoutApproval` read-only. Backend listing degrades to registered IDs when backend construction is unavailable, so profile browsing never depends on backend runtime resources.
- **Agent-profile editor foundation.** The localhost editor now has top-level navigation between prompt stacks and project agent profiles. The profile surface lists exact model/thinking/stack targets, auto-activation and last-applied markers, current-to-target transitions, effective tools, shared resolution diagnostics, applicability, provenance, and runtime drift. Trusted projects can create, validate, edit, apply once, and delete project-local profiles through a token-protected API backed by the existing resolver, transactional application service, and guarded repository.
- **Configurable subagent backend selection.** The execution backend is now layered configuration rather than a fixed default: `subagents.backend` in the user-owned `~/.pi/forge/config.json` sets the global default, a trusted project's `.pi/forge/config.json` overrides it, trusted-project per-profile policy can refine it, and `/forge-agent plan|run <profile> --backend <id>` or the interactive `forge_subagent` `backend` parameter overrides a single run. The experimental `pi-rpc-readonly` backend registered in the previous prerelease is now reachable from the product. There is deliberately no fallback to another backend when the selected one is unavailable; unattended `forge_subagent` invocation is pinned to the effective configured profile backend and rejects per-call backend overrides. `forge_subagent_profiles` and `/forge-agent backends` report resolved values and sources.
- **Explicit per-profile delegation policy.** Agent profiles are no longer automatically exposed as subagents. Trusted-project `subagents.profiles.<id>` entries explicitly enable delegation and can override backend and timeout per profile while keeping runner policy out of portable agent-profile JSON. Disabled and unlisted profiles remain available to ordinary `/profile` workflows but are hidden from model discovery and rejected before preparation by command, tool, and runtime paths. Global profile entries warn and are ignored because profiles and prompt stacks are project-local; interactive backend overrides remain highest priority.
- **Conversation fingerprint visibility.** `AgentExecutionPlan` now carries the runtime-issued `conversationFingerprint` alongside the execution fingerprint. `/forge-agent plan`, the approval summary, the full-prompt viewer, and the `forge_subagent` plan details display it, so cross-backend prompt fidelity is observable (equal conversation fingerprints with backend-distinct execution fingerprints).

### Changed

- **Declarative stack item editor.** Prompt blocks, runtime slots, and structured slot options now render through a lifecycle-managed Vue component. Form and raw-JSON modes share one reactive draft, preserve unknown option keys, and keep malformed JSON visible while preventing validation, preview, or save.
- **First declarative web-editor tabs.** The policy and regex editors now run as lifecycle-managed Vue components while the remaining stack editor stays on the compatibility bridge. Their drafts remain plain JSON at the bridge boundary, validation errors survive tab changes, repeated mounts clean up safely, and advanced rule/policy fields are preserved while editing.
- **Declarative stack settings editor.** Context options, stack variables, and the raw JSON recovery view now share the same lifecycle-managed Vue tab host. Duplicate-variable errors remain authoritative across tab changes, raw JSON stays unapplied until explicitly accepted, and applying a replacement stack resets the other tab drafts through one plain-JSON boundary.
- **Declarative stack metadata.** Stack identity, name, mode, auto-activation, description, file provenance, collapse state, and dirty-state signaling now render through a lifecycle-managed Vue component while preserving the established browser controls and immutable-ID behavior.
- **Viewport-safe subagent approval.** The interactive approval selector now shows a bounded one-line task preview and compact execution metadata instead of embedding the full multi-line review in an unbounded selector title. `View full prompt` opens the complete approval details, full fingerprints, and exact provider-bound prompt in Pi's internally scrollable editor, avoiding terminal-scrollback jumps in small terminals such as VS Code's integrated terminal.
- **Configurable foreground subagent timeout.** `subagents.timeoutMs` configures the best-effort default from 1,000 through 3,600,000 milliseconds with a 60,000-millisecond built-in value, while `subagents.profiles.<id>.timeoutMs` can override it per enabled profile. Malformed values preserve the preceding valid/default value with a warning, and discovery, backend, plan, and approval surfaces show the effective timeout.
- **Published subagent runtime integration.** Pinned `@zihanw/pi-subagent-runtime@0.1.0-beta.2` instead of a sibling `file:` dependency. Host compilation now consumes the runtime's validated accepted preflight directly, and preparation forwards its `AbortSignal` through the public runtime API, removing the temporary `hostCompilePreflight()` and `prepareWithAbort()` shims. Runtime beta.2 consumes Pi SDK packages as host-provided peers and resolves model registries structurally, avoiding a private-class identity dependency on one Pi release.
- **Runtime-issued plan fingerprints.** `createAgentExecutionPlan()` now requires the runtime-issued conversation and execution fingerprints as inputs instead of computing a host-side execution fingerprint. `validateAgentExecutionPlan()` validates fingerprint shape and internal consistency; substituted-plan detection is the runtime's sealed-plan binding, not host recomputation.
- **Portable validators unified with the runtime core.** The subagent contract's access, limit, prompt-runtime, backend-descriptor, and access-enforcement validators are re-exported from `@zihanw/pi-subagent-runtime` (adapted to the host collecting style), removing the duplicated portable implementations. Host-specific artifacts (selected context, context budget, media, usage, artifacts, traces, and the richer host access-receipt cross-checks) keep their local validators.
- **Host-provided Pi compatibility.** Pi SDK packages and `typebox` are wildcard optional peers instead of private runtime dependencies, while exact versions remain development-only for reproducible builds. The full verification surface passes against Pi 0.82.1 and 0.83.0, and scheduled CI checks the latest published Pi family so incompatibilities are found without constraining every host update.

### Removed

- **Breaking: legacy subagent compatibility surfaces.** Removed the `src/subagent-contract.ts` compatibility barrel (import the identical surface from `@zihanw/pi-forge/subagent` or the package root), the `subagentExecutionFingerprint` host fingerprint helper (execution fingerprints are runtime-issued), and the `scripts/subagent-sdk-spike*` diagnostic harness with its `spike:subagent` npm script and test. The spike's media-transport and trusted-extension preparation diagnostics are recorded as coverage debt in `docs/development/roadmap.md` and return with productized delegated media tasks.

### Fixed

- **Profile editor state synchronization.** Returning to agent profiles now refreshes resolution after prompt-stack changes, so deleted or changed stack references immediately fail preflight instead of showing stale applicability. Unsaved delegation drafts survive same-profile refreshes and require confirmation before profile/editor navigation, manual reload, or deletion; browser unloads also use the standard unsaved-change guard. Deleting a profile now removes its effective `subagents.profiles.<id>` delegation policy, preventing a later profile with the same ID from silently inheriting delegation authority.
- **Restored viewport-constrained editor layout.** The Vue app shell's mount element had no height, so every `height: 100%`/`calc()` below it collapsed to content height while `body` clipped the overflow without a scroll path: the delegation card, profile sidebar rows, and the stacks workspace were silently cut off at desktop window sizes. Both surfaces now size through flex `min-height: 0` chains with internal scroll regions, the sidebar list no longer assumes a fixed header height, and the narrow-width profiles layout stacks without phantom gaps. A browser regression test asserts both surfaces stay within the viewport and that bottom-of-page controls are reachable by scrolling.
- **Narrow-window stack editing.** The stacked single-column workspace no longer stretches the items pane into dead space, the prompt-content editor keeps a usable 220px minimum height with vertical resize instead of collapsing to two lines, item fields lay out in two columns, and the diagnostics panel is now collapsible: a slim summary header (auto-expanded when errors or warnings exist, collapsed when clean, with an explicit user toggle and `aria-expanded` state) replaces the fixed 128px region.
- **Editor UX polish.** Profiles default-select the last-applied or first healthy profile instead of the alphabetically-first broken one; the delegation card distinguishes its saved policy from an unsaved draft and uses a bounded number input for timeout overrides; the profile editor warns inline when the typed model lacks configured authentication; surface navigation exposes `aria-current`; harness-driven tests no longer read the developer's real global pi-forge config.
- **Single auto-activation enforced on profile save.** The browser editor's create and save APIs now reject a profile that requests auto-activation while another project profile already does (409), matching the existing validation diagnostic instead of writing an ambiguous configuration that the loader would then flag on both profiles. Browser coverage now also exercises the single auto-activation rule, registry-populated model options, and runtime drift reporting after external model, thinking-level, and stack changes.

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
- The web editor client is authored as strict TypeScript/Vue source with a dedicated browser typecheck. A build-only Vite pipeline emits self-contained JavaScript and CSS strings for the localhost editor, and verification rejects stale generated output without publishing browser-only source modules.
- **Breaking: browser-client compatibility paths.** `@zihanw/pi-forge/src/web-editor/client/*` imports are now explicitly blocked instead of matching the broad legacy `src/*` export wildcard. Browser implementation modules are build inputs rather than runtime integration surfaces; the supported editor delivery remains the generated embedded bundle.
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
