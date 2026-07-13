# pi-forge Next Steps

This file is forward-looking only. Shipped capability belongs in `FEATURES.md`; release history belongs in `CHANGELOG.md`.

## Current Read

- `0.3.2` is the current released baseline. Prompt stacks, storage migration, tool policy, model-visible skill filtering, regex MVP, SillyTavern import, web editor, payload inspection, trusted macro/slot extensions, and command/lifecycle coverage are shipped.
- The current 0.4 branch implements strict project-local agent profiles with exact model, thinking-level, and prompt-stack references; one-shot save/use and fresh-session auto-activation; preflight and preview; branch-scoped last-applied provenance; and runtime drift reporting.
- Shared typed profile repository, application, preview, provenance, and drift services are implemented and consumed by the profile commands.
- The internal Pi SDK spike now validates real profile/model/auth resolution, exact lifecycle prompt preparation, protected task/media handling, dynamic tool discovery, no-access execution, host timeout/abort, in-memory cleanup, and trusted custom macro/slot loading. Its findings are in [`SUBAGENT_SDK_SPIKE_FINDINGS.md`](SUBAGENT_SDK_SPIKE_FINDINGS.md).
- Iterations 3 through 5 export the pure subagent request/resolution/preflight/plan/response boundary, dependency receipts, deterministic context budgeting, granular validators, canonical fingerprints, and an empty-by-default backend registry. A deterministic fake backend now covers the adapter status, enforcement, cancellation, artifact, and trace matrices documented in [`SUBAGENT_ADAPTER_CONTRACT.md`](SUBAGENT_ADAPTER_CONTRACT.md).
- The extension composition root, typed browser client, and subagent contract have been split into focused modules. Legacy package-root and `subagent-contract` exports remain compatibility barrels rather than separate implementations.
- The web editor page shell and static styles are separate, and its browser client is now authored as strict typed modules with a reproducible self-contained bundle. Browser smoke verification covers dirty state, policy and regex editing, validation, save, export, and import before profile UI work.
- Prompt stacks remain scoped to prompt/message layout and strict active-tool constraints. Skill policy filters model-visible pi-forge skill listings; it is not a security boundary.
- Profile v1 deliberately omits tool/skill lists, generation parameters, fallbacks, and runner limits. Prompt stacks own tool policy; unsupported profile fields fail validation instead of becoming inert configuration.
- New prompt-stack behavior should be driven by real prompt-authoring pain, not by aiming for complete SillyTavern compatibility.

## Plan Assessment

Recommended ordering:

1. Completed: exercise the profile CLI against real installed providers and extension toolsets, then fix compatibility findings without expanding the schema.
2. Completed: extract a shared typed profile repository/application/status service and make commands consume it without behavior changes.
3. Completed: implement discovery/preflight plus backend-assisted host plan preparation, pure validation, deterministic budgeting, and stable fingerprints.
4. Completed: add an optional backend registry and fake-backend conformance harness without registering a backend by default.
5. Build profile UI on the completed shared service as an independent product lane.
6. Design parent integration and choose whether the Pi SDK spike should become an optional concrete adapter; keep the registry useful with zero adapters installed.
7. Revisit custom macro/slot portability metadata and importer fidelity only when real sharing or preset drift demonstrates the need.
8. Defer provider-payload rewriting, true display regex, and an owned full runner until a concrete adapter demonstrates the remaining enforcement semantics end to end.

Risk calls:

- Keep prompt-stack JSON declarative. Trusted executable customization belongs in `~/.pi/forge/extensions`, `.pi/forge/extensions`, or reusable packages.
- Treat an agent profile as a one-shot preset. Manual use or fresh-session auto-activation configures Pi once; subsequent user changes must not be continuously overwritten.
- Keep tool names out of agent profiles. The referenced prompt stack is the single source of truth for strict tool policy while active.
- Treat skill policy as model-visible prompt filtering only. It does not disable explicit skill invocation or provide a security boundary.
- Keep generation parameters, model fallbacks, global storage, and runner limits out of profile v1 until a concrete consumer can enforce their semantics consistently.
- Avoid expanding the browser editor without browser-level workflow coverage.
- Do not add user-facing delegation merely because the dispatcher exists. First choose a concrete adapter whose real isolation limits are explicit, then prove request construction, response projection, cleanup, and authorization end to end.

## Priority 1: Profile UI

Goal: expose profile management on the completed shared service now that profile core and CLI semantics are stable.

Potential work:

- Add a profile list/detail view beside prompt stacks.
- Reuse resource pickers where their semantics actually match the decided profile fields.
- Add model/thinking controls from available model registry data.
- Add a prompt-stack picker by ID and raw JSON recovery for advanced fields.

Done criteria:

- Users can create, edit, validate, save, apply, and delete profiles.
- UI state distinguishes last-applied provenance from current runtime drift.
- Profile UI does not duplicate prompt-stack item editing logic.
- Browser smoke tests cover token checks, validation, save, application, drift display, and deletion.

## Priority 2: Subagent Adapter Boundary

Goal: make stored profiles useful to subagent systems without committing to one runner.

The accepted architecture is recorded in [`SUBAGENT_INTERFACE_DESIGN.md`](SUBAGENT_INTERFACE_DESIGN.md), and the implemented exported semantics are in [`SUBAGENT_ADAPTER_CONTRACT.md`](SUBAGENT_ADAPTER_CONTRACT.md). The Pi SDK spike, pure contract, optional registry, and fake-backend conformance suite are complete; no concrete backend is registered or shipped yet.

Boundaries:

- Do not hard-depend on `pi-subagents`, `@gotgenes/pi-subagents`, Archimedes, or another runner in 0.4.
- Keep profile definition, validation, resolution, preview, and export as pi-forge's responsibility.
- Split host profile/stack/dependency resolution from backend model/auth/tool/access preflight.
- Prepare compiled prompts/messages, effective tools, materialized access, enforced limits, diagnostics, and stable execution provenance in an immutable execution plan before provider transport.
- Allow backend-assisted host preparation when exact prompt-runtime inputs are available only in a pre-provider lifecycle hook; provider transport must remain blocked until plan validation succeeds.
- Start subagents with a clean context. Do not export parent chat history or dynamic compiled context by default; allow only explicit bounded summaries, excerpts, tool results, and resource references with provenance.
- Preserve the delegated task as a protected final user message after unrestricted stack message compilation.
- Keep access policy and per-run limits in the request rather than the reusable profile; use opaque workspace handles and require granular backend enforcement receipts.
- Return compact output/status/artifact data to the parent as a tool result; retain normalized history behind an inspectable trace reference.
- Verify any optional event-bus adapter against the supported Pi version range before adopting it.

Done criteria:

- Shared profile operations are independent of the web editor and command handlers.
- The completed real internal adapter spike validates model/auth preflight, prompt preparation, dynamic built-in tools, no-access enforcement, timeout cancellation, and media before public contract export.
- Serializable request, execution-plan, response, and enforcement-receipt contracts have pure validation and stable canonical fingerprints. Fake-backend conformance covers preparation, execution, cancellation, timeout, limit, media, artifact, and trace behavior.
- Parent context selection is explicit, bounded, provenance-preserving, and excludes hidden reasoning.
- The final task and required media survive all supported prompt-stack layouts.
- No subagent package is required to install or use pi-forge.
- Documentation explains which fields an external runner must enforce itself.

## Priority 3: Owned Subagent Runner Decision

Default answer: do not build a full runner in 0.4.

If pi-forge later owns a runner, start with subprocess isolation, fresh context, profile-backed foreground execution, cancellation, and compact results. Do not begin with chains or pipelines.

Requirements before implementation:

- Project trust behavior for local profiles and agents.
- Cancellation and cleanup semantics.
- Budget, turn, timeout, and output limits.
- Tool/model/profile inheritance rules.
- Artifact and result storage policy.
- Failure and retry formats.
- Protection against recursive delegation loops.

Decision rule:

- Build native only if stored profiles need behavior external runners cannot provide without taking over pi-forge's product surface.
- Otherwise provide adapters/export and let dedicated packages own orchestration.

## Priority 4: Custom Macro/Slot Portability Metadata

Goal: improve sharing for stacks that depend on trusted registration code without allowing executable code in stack JSON.

Potential work:

- Add optional dependency hints for required slots, macros, or extension package names.
- Surface missing custom dependencies in validation and the web editor.
- Preserve parser, filter, conditional, slot, and unknown-policy compatibility.
- Defer general expressions, boolean algebra, loops, arithmetic, regex conditions, and arbitrary stack-authored code.

Decision rule:

- Implement metadata only after real extension sharing demonstrates portability friction.

## SillyTavern Importer Follow-ups

Goal: broaden importer fidelity only when real presets show useful field-shape drift.

Potential work:

- Preserve additional useful original metadata under `import`.
- Add fixtures when real presets reveal unsupported shapes.
- Keep macro and regex conversion warnings inside their extracted importer modules.

Decision rule:

- Existing behavior stays stable unless a real fixture proves the need for a change.

## Priority 5: Chat-History Controls

Potential filters:

- Omit the last N user messages.
- Include only the branch after the latest compaction.
- Explicitly include or omit hidden/synthetic/custom messages.
- Summarize old history later.

Done criteria:

- Each option has a concrete use case and tests for dangling tool calls/results.
- Existing defaults remain stable.

## Priority 6: Prompt-Stack Lifecycle Controls

Potential configuration:

```json
{
  "lifecycle": {
    "contextRewrite": "first-provider-request"
  }
}
```

Possible values may include the current `first-provider-request` behavior, advanced repeated rewriting, tool-follow-up-aware rewriting, and disabled message-layout rewriting.

Decision rule:

- Add configuration only when users need behavior beyond the current safe default.

## Priority 7: Payload and Regex Expansion

Keep deferred:

- Provider-payload rewrite stage.
- True display-only regex transforms.
- Streaming display cleanup.

Allowed near-term work:

- Broader provider-payload shape tests.
- Better diagnostics describing what regex changed and where.

Decision rule:

- Implement a new stage only for a precise use case with a stable hook and non-destructive preview path.

## Ongoing Test Policy

- Keep Node's built-in test runner for core tests.
- Extend the command/event harness when command or lifecycle behavior changes.
- Keep compiler, loader, importer, regex, and policy tests separate from integration-style command tests.
- Run browser smoke tests for material editor workflows.
- Run `npm run verify` before commits and releases; it covers tests, typecheck, generated browser-client consistency, and tracked `dist/` consistency.

## Next Design Session

1. Choose the next product lane: profile UI, or the smallest parent integration around one optional concrete adapter. Neither should block the other architecturally.
2. If parent integration comes first, decide whether the Pi SDK spike can honestly advertise only a narrow capability subset or whether a more isolated subprocess adapter is required.
3. Define the parent request builder, explicit context-selection UX, compact response projection, cancellation handle, and authorized trace inspection before registering a run tool.
4. Add end-to-end cases for request/profile resolution, backend refusal, provider success/failure, cancellation cleanup, artifacts, and trace authorization using the chosen real adapter.
5. Continue profile UI on the shared profile service with browser cases defined before handlers.
6. Keep generation parameters, fallbacks, retries, resumable sessions, chains, and pipelines deferred until a concrete backend can enforce them consistently.
