# Historical 0.4 roadmap and implementation log

> **Archive:** This document preserves the planning record through the 0.4 development cycle. Completed behavior belongs in the [feature inventory](../reference/features.md); current plans belong in the [roadmap](../development/roadmap.md).

This file was the forward-looking product roadmap during 0.4 development. Completed capability now belongs in the [feature inventory](../reference/features.md), release history in the root [changelog](../../CHANGELOG.md), and current plans in the [roadmap](../development/roadmap.md).

## Documentation Map

- [Root README](../../README.md) and [Chinese README](../../README.zh-CN.md): short project landing pages.
- [Feature inventory](../reference/features.md): implemented profile, prompt-stack, web-editor, payload, extension, packaging, and experimental subagent behavior.
- [Changelog](../../CHANGELOG.md): release and unreleased change history.
- [Subagent interface design](subagents/interface-design.md): accepted request/response architecture, context model, responsibility boundaries, and implementation history.
- Subagent adapter contract: the 0.4 exported contract documented the execution surface that moved to `@zihanw/pi-forge-subagents` in 0.5; see the [subagent host port contract](../reference/subagent-host-port.md) for the current boundary.
- [SDK spike findings](subagents/sdk-spike-findings.md): historical real Pi SDK findings for model/auth resolution, exact prompt preparation, dynamic tools, media, timeout, and cleanup.
- [Subagent design review](subagents/design-review.md): issues that drove resolution, preflight, enforcement, task-preservation, fingerprint, and response revisions.
- [Public API policy](../reference/public-api.md): stable, experimental, and internal compatibility surfaces.

## Current Objective

Harden the completed approval-gated foreground subagent path without turning pi-forge into a general orchestrator. Work should proceed in this order:

1. Dogfood the shared-user read-only path and tighten report, cancellation, and sensitive-path behavior found in real use.
2. Evaluate an optional bubblewrap-style backend that can enforce allowed roots, subprocess limits, and network policy honestly.
3. Design any future write access as an inspectable staged patch with a separate approval boundary.
4. Expose agent profiles in the existing browser editor.
5. Harden the workflows and prepare the release.

The current tool and commands already share the same request, preflight, host preparation, immutable plan, execution, and response-projection path. Further safety work should strengthen the backend boundary rather than introduce a second runner. Profile UI remains a bounded user-facing iteration independent of sandbox development.

## Recently Completed: Approval-Gated Foreground Subagent

The `pi-subprocess-readonly` and `pi-rpc-readonly` paths send one requested text task through profile eligibility and resolution, backend preflight, exact backend-assisted prompt preparation, immutable plan validation, interactive review by default, a foreground Pi process (text/print or RPC), and normalized response handling without owning a general runner. Backend registration, preflight binding, plan sealing, lifecycle arbitration, and both process backends are owned by `@zihanw/pi-subagent-runtime`; pi-forge keeps profiles, execution policy, compilation, approval, and presentation. Backend and timeout defaults are layered global/project configuration, while explicit `subagents.profiles.<id>` delegation opt-in and per-profile overrides are trusted-project-only; interactive runs may override the backend, there is no fallback, and a trusted-project option can explicitly authorize the model-callable tool without per-run review pinned to the effective configured profile backend. The former in-package `SubagentBackendRegistry`, `PiSubprocessBackend`, and `PiSdkIsolatedBackend` exports were removed in the migration; the SDK spike harness was removed after its findings were productized in the runtime's shared preparation gate.

User test surface:

- Explicitly enable intended delegation profiles under the trusted project's `subagents.profiles`, then ask the main agent to discover them with `forge_subagent_profiles` and execute with `forge_subagent`; restrictive tool policy must permit both names.
- `/forge-agent backends`
- `/forge-agent plan <profile> <task>` prepares the exact request behind a provider gate, reports its plan, and discards it without transport.
- `/forge-agent run <profile> <task>` reviews the same exact prepared plan in the TUI and executes it only after approval.

Current boundary:

- Use Pi's existing model registry, authentication, streaming, and in-memory session primitives.
- Support one-shot sequential foreground text execution with an existing agent profile and clean context.
- Expose only stack-filtered `read`, `grep`, `find`, and `ls`; load no write/edit/shell tools, skills, prompt templates, context files, or third-party Pi extensions.
- Declare `executionBoundary: shared-user`: read-only is model-tool policy, not mount, path, process, or network isolation. The child retains the invoking user's OS permissions.
- Load trusted pi-forge macro/slot registrations only in the host compiler and preserve the delegated task as the final protected user message.
- Treat timeout and abort as host best-effort enforcement.
- Keep provider execution opt-in through interactive approval bound to the exact execution fingerprint or the explicit trusted-project unattended-tool setting. Ordinary automated tests use only an offline faux provider.
- Let the main agent inspect only delegation-enabled profile IDs/descriptions, effective execution settings, and current resolution status locally without approval, provider transport, or exact prompt preparation.
- Return bounded model-visible output and expandable human-visible plan, approval, diagnostics, transcript, tool-event, usage, and response details. Advertise no artifact or contract trace storage until those implementations exist.

## 0.4.0 Exit Plan (agreed 2026-07-26)

Decisions and scope for taking 0.4.0 out of beta. This section supersedes older subagent-status prose elsewhere in this file (notably the retained `pi-sdk-isolated` wording, which no longer matches the code); aligning those documents is work item 4 below.

### Decisions

- **Backend selection is configuration, not profile schema.** Agent profiles remain execution-environment-agnostic personas (model, thinking level, prompt stack). Defaults are configured through `subagents.backend` in global `~/.pi/forge/config.json` with a trusted-project override in `.pi/forge/config.json`; trusted-project `subagents.profiles.<id>` entries gate delegation and may override backend/timeout per profile, and interactive runs may override backend with `--backend`. Global profile entries are ignored until global profiles and prompt stacks have explicit source scope. The unattended model-callable tool path pins the effective configured profile backend; the interactive approval dialog always displays the bound backend. There are no fallback chains: the runtime contract forbids silent fallback, and a fallback that downgrades the execution boundary would overstate enforcement.
- **Depth over orchestration breadth.** pi-forge's delegation niche is policy-bound, reviewable execution: sealed exact prompts, fingerprint-bound approval, and honest enforcement receipts. Background agents, parallel fan-out, chains/pipelines, nested delegation, and inter-agent messaging stay deferred (see Deferred Product Backlog); general orchestration is deliberately left to dedicated packages. The runtime's run-handle model already permits host-composed concurrency, so a future parallel approval UX needs no runtime change.
- **pi-forge 0.4.0 does not require pi-subagent-runtime 0.1-stable.** Pin an exact runtime version and keep the subagent surface labelled experimental per Milestone 3. The runtime's own stabilization still waits for a second consumer or backend author per its VISION.md.

### Work items, in order

1. **Finish the runtime integration in pi-forge.**
   - ~~Expose backend selection as decided above~~ **(done 2026-07-29):** global/trusted-project defaults plus explicit trusted-project `subagents.profiles.<id>` delegation eligibility and backend/timeout overrides, `/forge-agent plan|run --backend <id>`, interactive `forge_subagent` `backend` parameter, unattended pinning to the effective configured profile backend, and resolved-setting reporting in `forge_subagent_profiles` and `/forge-agent backends`.
   - ~~Resolve the fingerprint-semantics contradiction~~ **(done 2026-07-26):** `AgentExecutionPlan` now carries the runtime-issued `conversationFingerprint` and `executionFingerprint` as required inputs to `createAgentExecutionPlan()`; the host never computes either value. `subagentExecutionFingerprint` and the host-side recomputation check in `validateAgentExecutionPlan()` were removed; substitution detection remains the runtime's sealed-plan binding.
   - ~~Surface the sealed `conversationFingerprint`~~ **(done 2026-07-26):** shown in `/forge-agent plan` output, the approval summary, the full-prompt viewer, and the tool's plan details.
   - ~~Deduplicate validation toward runtime core~~ **(done 2026-07-26):** `src/subagent/validation.ts` re-exports and adapts the runtime core validators; only host-specific artifacts keep local implementations. The host access-receipt validator intentionally stays richer than the runtime's (mount uniqueness, level consistency, boundary-claim cross-checks); porting those checks into the runtime core is a runtime-side follow-up.
2. **Land small runtime-side API additions** **(done 2026-07-28):** `compile` receives the validated accepted preflight and `prepare` accepts an `AbortSignal`; pi-forge now consumes both directly without `hostCompilePreflight()` or `prepareWithAbort()`. Media materialization remains deferred unless delegated media tasks enter 0.4 scope.
3. **Resolve the runtime publish story** **(done 2026-07-28):** published `@zihanw/pi-subagent-runtime@0.1.0-beta.1` and pinned that exact prerelease in pi-forge. The subagent surface remains experimental and does not require runtime 0.1-stable.
4. **Legacy cleanup and documentation alignment** **(done 2026-07-26):** removed the SDK spike scripts/test, the `src/subagent-contract.ts` compatibility barrel, and the `subagentExecutionFingerprint` host shim; aligned stale `pi-sdk-isolated`/registry claims in `SUBAGENT_INTERFACE_DESIGN.md`, `SUBAGENT_ADAPTER_CONTRACT.md`, `SUBAGENT_SDK_SPIKE_FINDINGS.md`, and `FEATURES.md`; recorded the removed legacy exports as breaking changes in `CHANGELOG.md`. Coverage debt accepted: the removed spike was the only live media-preparation and trusted-extension preparation diagnostic; re-establish that coverage when delegated media tasks are productized (work item 2).
5. **Milestone 1 step 1 dogfooding** of the subprocess backend against representative providers, cancellation timing, long prompts, large read results, and rejection/full-prompt review flows. The bubblewrap sandbox evaluation and staged-write proposal remain Milestone 1 design work and do not gate 0.4.0; any sandbox backend lands as a separate runtime backend entry point with honest receipts.
6. **Milestone 2: profile UI** **(done 2026-07-31):** the browser editor now manages profiles end to end — navigation, list/badges, create/edit/validate/save/apply/delete, single auto-activation enforcement, registry-driven model controls, provenance/drift display, and a per-profile delegation card that writes `subagents.profiles` policy with backend/timeout overrides. A viewport-layout regression from the Vue shell migration (clipped content with no scroll path) was repaired with flex `min-height: 0` chains, a collapsible diagnostics panel, narrow-mode layout fixes, and a layout-invariant browser test.
7. **Milestone 3: release readiness**, plus explicit release-note non-goals: no runner, no background execution, no chains, no profile schema expansion, no macro portability hints, no chat-history lifecycle controls.

## 0.4.1 Candidate: Scoped Global Profiles and Stacks

If cross-project presets are added, introduce global profiles and prompt stacks together rather than treating a project-local profile ID as a global identity. Load them from explicit global directories, retain source scope on every loaded resource, let a same-ID project resource shadow its global counterpart, and apply global/project `subagents.profiles` policy only to profiles from the matching scope. Define discovery, auto-activation, stack-reference, and editor behavior against that scoped identity before implementation.

## Milestone 1: Sandbox and Write-Safety Evaluation

Goal: determine whether stronger isolation and useful write workflows can be added without obscuring the current honest shared-user boundary.

Implementation sequence:

1. Exercise the current subprocess against representative local and remote providers, cancellation timing, long prompts, large read results, and rejection/full-prompt review flows.
2. Define an optional sandbox-driver interface and prototype bubblewrap on supported Linux hosts with explicit allowed roots, a minimal environment, process restrictions, and configurable network policy.
3. Keep shared-user as an explicitly unsafe compatibility mode; never report sandbox enforcement when the selected host cannot provide it.
4. Specify a staged-write result containing proposed patches/change metadata that the human can inspect and approve separately before host application.

Initial scope:

- One foreground text task at a time, with no background execution or automatic retries.
- Clean context and explicit task only; no automatic parent history.
- Preserve read-only defaults until a separate staged-write approval/apply path exists.
- No generic shell merely to obtain file writes; sandbox claims require enforcement tests and receipts.

Done criteria:

- The optional sandbox can demonstrate and test allowed-root, process, symlink, and requested network behavior, or the product continues to label execution shared-user without ambiguity.
- A proposed write cannot affect the workspace before a second, human-visible approval and has a clear failure/partial-application strategy.
- User cancellation and host timeout settle once and clean up preparation sessions, child processes, and temporary bridge data.
- Documentation and receipts remain accurate on unsupported platforms and when falling back to shared-user execution.

## Milestone 2: Profile UI (landed 2026-07-31)

Goal: make profile v1 fully manageable from the existing localhost editor while preserving the exact behavior of the shared profile service and `/profile` commands.

Scope:

- Add clear top-level navigation between prompt stacks and agent profiles.
- List profiles with ID, name, exact provider/model, thinking level, prompt-stack reference, auto-activation, and validation state.
- Support create, edit, validate, save, delete, and one-shot apply operations.
- Populate model/thinking controls from available model-registry data and prompt-stack selection from the shared stack repository.
- Show resolution diagnostics for missing models, authentication, unsupported thinking levels, invalid stacks, and unmatched tool policy.
- Distinguish source-definition changes, last-applied provenance, and current runtime drift; never imply that a profile continuously owns runtime state.
- Retain a raw JSON recovery path for invalid or future fields without silently accepting unsupported profile fields.
- Reuse the existing profile repository, application, preview, provenance, and drift services rather than duplicating command behavior in web handlers.

Done criteria:

- A user can create, edit, validate, save, apply once, and delete a profile without editing JSON or using `/profile` commands.
- At most one auto-activation profile is accepted, and profile precedence remains identical to the command/runtime path.
- Applying a profile performs full preflight and best-effort rollback on failure.
- The UI does not duplicate prompt-stack item, tool-policy, or skill-policy editing.
- Browser tests cover token protection, empty and invalid states, model/stack selection, validation, save, apply, drift display, deletion, and lifecycle host refresh.

## Milestone 3: Release Readiness

Goal: make the user-visible profile and experimental delegation surfaces understandable, reproducible, and safe to release.

Scope:

- Update English and Chinese user documentation with profile UI workflows, profile-versus-stack ownership, delegation consent, and concrete backend limitations.
- Clearly label the subagent API/backend as experimental and keep installation and ordinary non-delegation use independent of backend execution.
- Run command/event and browser workflows across extension reload, session navigation, fresh sessions, compaction, and editor reuse.
- Verify npm and Git delivery through compiled `dist` while clone-based development continues to load `src/index.ts` explicitly.
- Run `npm run verify` before every release candidate and reject stale browser-client or `dist` output.

Done criteria:

- Documentation and UI do not overstate skill filtering, tool filtering, filesystem isolation, timeout enforcement, or profile ownership.
- Release-like package checks contain no physical `src/` files and both package entry points resolve to compiled output.
- All core, browser, type, generated-client, `dist`, and package checks pass from a clean checkout.

## Deferred Product Backlog

### Broader or Owned Subagent Runner

Do not build a full runner in 0.4. The current subprocess path should remain fresh-context, profile-backed, foreground, approval-gated, and sequential rather than expanding into chains or pipelines.

Requirements before implementation:

- Project trust behavior for local profiles and agents.
- Cancellation, timeout, and cleanup semantics.
- Budget, turn, token, output, and cost limits.
- Tool/model/profile inheritance and provider fallback rules.
- Artifact and trace storage, authorization, retention, redaction, pagination, and cleanup.
- Failure and retry formats, priorities, queues, and concurrency.
- Secret/environment injection and structured-output policy.
- Protection against recursive delegation loops.

Build native orchestration only if stored profiles need behavior external runners cannot provide without taking over pi-forge's product surface. Otherwise keep the adapter boundary and let dedicated packages own orchestration.

### Profile Schema Expansion

Keep generation parameters, model fallbacks, tools, skills, global profile storage, secrets, and runner limits out of profile v1. Revisit them only when a concrete consumer can validate and enforce their semantics consistently across supported backends.

### Custom Macro and Slot Portability

- Add optional dependency hints for required slots, macros, or extension package names only after real stack sharing demonstrates portability friction.
- Surface missing custom dependencies in validation and the editor without allowing executable code in stack JSON.
- Preserve parser, filter, conditional, slot, and unknown-policy compatibility.
- Continue deferring general expressions, boolean algebra, loops, arithmetic, regex conditions, and arbitrary stack-authored code.

### SillyTavern Import Fidelity

- Preserve additional useful original metadata under `import` when real presets require it.
- Add fixtures when real presets reveal unsupported field shapes.
- Keep macro and regex conversion warnings in their focused importer modules.
- Preserve existing behavior unless a real fixture demonstrates the need for a change.

### Chat-History and Prompt Lifecycle Controls

Potential history controls include omitting the last N user messages, selecting only the branch after the latest compaction, explicitly including or omitting hidden/synthetic/custom messages, and eventually summarizing old history. Each option needs a concrete use case and dangling tool-call/result repair tests.

Potential lifecycle configuration may include:

```json
{
  "lifecycle": {
    "contextRewrite": "first-provider-request"
  }
}
```

Only add alternatives to the current `first-provider-request` behavior when users demonstrate a need for repeated rewriting, tool-follow-up-aware rewriting, or disabled message-layout rewriting.

### Payload and Regex Expansion

Continue deferring provider-payload rewriting, true display-only regex transforms, and streaming display cleanup. Near-term diagnostics may broaden provider-payload shape coverage and explain precisely what regex changed and where. Add a new stage only for a concrete use case with a stable hook and a non-destructive preview path.

## Product and Engineering Guardrails

- Keep prompt-stack JSON declarative. Trusted executable customization belongs in `~/.pi/forge/extensions`, `.pi/forge/extensions`, or reusable packages.
- Treat profiles as one-shot presets. Manual use or fresh-session auto-activation configures Pi once; later user changes must not be continuously overwritten.
- Keep tool names out of profiles. The referenced prompt stack remains the single source of truth for strict active-tool policy.
- Treat skill policy as model-visible prompt filtering only, not explicit invocation control or a security boundary.
- Drive new prompt-stack behavior from demonstrated prompt-authoring pain rather than complete SillyTavern compatibility.
- Avoid expanding browser behavior without browser-level workflow coverage.
- Keep pi-forge install and ordinary use independent of `pi-subagents`, `@gotgenes/pi-subagents`, Archimedes, or another orchestration package; delegation remains opt-in and additional backends remain optional integrations.
- Verify any future event-bus adapter against the supported Pi version range before adopting it.
- Do not expose delegation merely because a dispatcher exists. A concrete adapter must prove its actual isolation, preparation, projection, cleanup, and authorization semantics end to end.
- Keep Node's built-in test runner for core tests and separate compiler, loader, importer, regex, policy, profile, and subagent-contract tests from integration-style command tests.
- Extend the command/event harness for command or lifecycle changes, run browser smoke tests for material editor workflows, and run `npm run verify` before commits and releases.
