# pi-forge Next Steps

This file is the forward-looking product roadmap. Completed capability belongs in [`FEATURES.md`](FEATURES.md), release history belongs in [`CHANGELOG.md`](CHANGELOG.md), and detailed architecture belongs in the linked design documents below.

## Documentation Map

- [`README.md`](README.md) and [`README.zh-CN.md`](README.zh-CN.md): user installation, profile, prompt-stack, editor, and development workflows.
- [`FEATURES.md`](FEATURES.md): implemented profile, prompt-stack, web-editor, payload, extension, packaging, and experimental subagent behavior.
- [`CHANGELOG.md`](CHANGELOG.md): release and unreleased change history.
- [`SUBAGENT_INTERFACE_DESIGN.md`](SUBAGENT_INTERFACE_DESIGN.md): accepted request/response architecture, context model, responsibility boundaries, and implementation history.
- [`SUBAGENT_ADAPTER_CONTRACT.md`](SUBAGENT_ADAPTER_CONTRACT.md): exported contract, backend registry flow, validation, enforcement receipts, and adapter responsibilities.
- [`SUBAGENT_SDK_SPIKE_FINDINGS.md`](SUBAGENT_SDK_SPIKE_FINDINGS.md): real Pi SDK findings for model/auth resolution, exact prompt preparation, dynamic tools, media, timeout, and cleanup.
- [`SUBAGENT_DESIGN_REVIEW.md`](SUBAGENT_DESIGN_REVIEW.md): the design issues that caused resolution, preflight, enforcement, task-preservation, fingerprint, and response semantics to be revised before implementation.
- [`PUBLIC_API.md`](PUBLIC_API.md): stable, experimental, and internal compatibility surfaces.

## Current Objective

Turn the completed human-operated subagent path into a safe parent-agent workflow. Work should proceed in this order:

1. Add the smallest model-callable parent integration on top of the proven command/backend path.
2. Expose agent profiles in the existing browser editor.
3. Harden the workflows and prepare the release.

The parent tool must reuse the same request, preflight, host preparation, immutable plan, execution, and response projection path as `/forge-agent`; it must not introduce a second runner. Profile UI remains a bounded user-facing iteration after the delegation path has a main-agent feedback loop.

## Recently Completed: Pi SDK Backend and Human Test Path

The `pi-sdk-isolated` walking skeleton now sends one user-requested text task through profile resolution, backend preflight, exact backend-assisted prompt preparation, immutable plan validation, a real Pi `AgentSession`, and normalized response handling without owning a general runner.

User test surface:

- `/forge-agent backends`
- `/forge-agent plan <profile> <task>` prepares the exact request behind a provider gate, reports its plan, and discards it without transport.
- `/forge-agent run <profile> <task>` confirms provider egress in the TUI and executes the same prepared path.

Current boundary:

- Use Pi's existing model registry, authentication, streaming, and in-memory session primitives.
- Support one-shot foreground text execution with an existing agent profile and clean context.
- Advertise and accept only `access: none`, with no agent tools, mounts, process access, project context discovery, skills, prompt templates, or third-party Pi extensions.
- Load trusted pi-forge macro/slot registrations only in the host compiler and preserve the delegated task as the final protected user message.
- Treat timeout and abort as host best-effort enforcement.
- Keep provider execution opt-in. Ordinary automated tests use only an offline faux provider; live external-provider tests require an explicit command.
- Return compact normalized output and diagnostics. Advertise no artifact or trace storage until those implementations exist.

## Milestone 1: Parent-Agent Integration

Goal: expose the proven one-shot backend to the main agent without broadening its access or returning control-plane detail into parent context.

Implementation sequence:

1. Register a `forge_agent_run` tool with profile, task, explicit context, timeout, and result-projection inputs.
2. Require prior user/session consent for remote provider egress; a model tool call cannot grant that consent itself.
3. Route the tool abort signal through registry cancellation and SDK-session abort.
4. Add media-resource resolution and authorized trace inspection only after text delegation is stable.

Initial scope:

- One foreground text task at a time.
- Clean context plus explicit bounded, provenance-bearing context items; no automatic parent history.
- `access: none`, no tools, no background execution, and no automatic retries.
- Compact output/status/error projection only.

Done criteria:

- The main agent can invoke one stored profile and receives only the bounded result projection.
- Explicit selected context preserves provenance and excludes hidden reasoning, raw provider payloads, secrets, and automatic full-history export.
- User cancellation and host timeout settle once and clean up the SDK session.
- The tool is unavailable or refuses execution without explicit user/session egress consent.

## Milestone 2: Profile UI

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

Do not build a full runner in 0.4. If pi-forge later owns one, start with subprocess isolation, fresh context, profile-backed foreground execution, cancellation, and compact results rather than chains or pipelines.

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
