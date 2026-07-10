# pi-forge Next Steps

This file is forward-looking only. Shipped capability belongs in `FEATURES.md`; release history belongs in `CHANGELOG.md`.

## Current Read

- `0.3.2` is the current released baseline. Prompt stacks, storage migration, tool policy, model-visible skill filtering, regex MVP, SillyTavern import, web editor, payload inspection, trusted macro/slot extensions, and command/lifecycle coverage are shipped.
- The web editor page shell, static styles, and browser client are split. Browser smoke verification now gates larger UI work.
- Prompt stacks remain scoped to prompt/message layout and strict active-tool constraints. Skill policy filters model-visible pi-forge skill listings; it is not a security boundary.
- The likely 0.4 path remains profile-first and subagent-ready, but the exact agent-profile interface, fields, storage, and limits are intentionally undecided.
- New prompt-stack behavior should be driven by real prompt-authoring pain, not by aiming for complete SillyTavern compatibility.

## Plan Assessment

Recommended ordering:

1. Decide the minimal native agent-profile interface and storage contract.
2. Implement profile schema, loading, validation, preview, and one-shot CLI application.
3. Add profile UI only after the CLI/runtime behavior is stable, extending the browser smoke suite with each workflow.
4. Add a narrow subagent adapter boundary without requiring a subagent package.
5. Revisit custom macro/slot portability metadata and importer fidelity only when real sharing or preset drift demonstrates the need.
6. Defer provider-payload rewriting, true display regex, and an owned subagent runner until stable hooks and concrete use cases exist.

Risk calls:

- Keep prompt-stack JSON declarative. Trusted executable customization belongs in `~/.pi/forge/extensions`, `.pi/forge/extensions`, or reusable packages.
- Treat an agent profile as a one-shot preset. Applying it configures Pi once; subsequent user changes must not be continuously overwritten.
- Keep prompt-stack tool policy separate from profile application. Tool policy is a strict constraint while its stack is active.
- Treat skill policy as model-visible prompt filtering only. It does not disable explicit skill invocation or provide a security boundary.
- Avoid expanding the browser editor without browser-level workflow coverage.
- Do not add delegation until profile resolution, application diagnostics, and runtime drift reporting are coherent.

## Priority 1: Agent Profile Interface Decision

Goal: agree on the smallest stable profile contract before writing schema or command code.

Agreed behavior:

- Profiles are one-shot agent presets, not continuous runtime owners.
- Stored profiles remain unchanged when the parent runtime later drifts.
- Applying a profile should preflight its references and effects before mutating Pi.
- Prompt stacks are referenced by ID rather than embedded.
- `/profile` is the command namespace because `/preset` already means prompt stack.
- Future subagents resolve stored profiles afresh rather than copying mutable parent runtime state.

Decisions still required:

- Exact profile fields and schema version 1 shape.
- Project-only versus project and global storage locations.
- Exact tool representation: explicit active set, allow/deny resolution, or another form.
- Model/provider reference and fallback behavior.
- Skill visibility representation.
- Whether provenance uses `clear`, `use none`, or another command model.
- What, if anything, is persisted across session branches without reapplying runtime effects.
- Which limits belong in the profile once a subagent adapter can enforce them.
- Preflight, application ordering, partial-failure, and rollback rules.

Done criteria:

- The interface and semantics are recorded with representative JSON examples.
- Every field has an identified consumer and observable behavior.
- Inert runner/subagent fields are excluded until an adapter consumes them.
- Parent-session application and future subagent resolution have explicit, non-conflicting semantics.

## Priority 2: Native Agent Profile Core and CLI

Goal: implement the decided interface without coupling it to the web editor or a subagent runner.

Expected work after Priority 1:

- Add profile types, storage, loading, validation, and diagnostics.
- Add a pure resolution result independent of command handlers and UI.
- Add preview and one-shot application with preflight.
- Add `/profile` list, status, use, preview, validate, reload, and the decided provenance-clearing behavior.
- Report drift between the last-applied profile and current model, thinking, tools, and prompt-stack state without reapplying automatically.

Done criteria:

- Manual model, thinking, tool, and prompt-stack changes survive after profile application.
- Applying the same profile again is the explicit reapply/reset operation.
- Missing models, authentication, prompt stacks, and tools produce actionable diagnostics.
- Profile core has focused unit tests and command/lifecycle coverage.

## Priority 3: Profile UI

Goal: expose profile management only after profile core and CLI semantics are stable.

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

## Priority 4: Subagent Adapter Boundary

Goal: make stored profiles useful to subagent systems without committing to one runner.

Boundaries:

- Do not hard-depend on `pi-subagents`, `@gotgenes/pi-subagents`, Archimedes, or another runner in 0.4.
- Keep profile definition, validation, resolution, preview, and export as pi-forge's responsibility.
- Resolve provider plus model ID, thinking level, tool names, prompt-stack reference, and diagnostics into a stable adapter-facing object.
- Do not export parent chat history or dynamic compiled context by default.
- Verify any optional event-bus adapter against the supported Pi version range before adopting it.

Done criteria:

- The resolved profile object is independent of the web editor and command handlers.
- No subagent package is required to install or use pi-forge.
- Documentation explains which fields an external runner must enforce itself.

## Priority 5: Owned Subagent Runner Decision

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

## Priority 6: Custom Macro/Slot Portability Metadata

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

## Priority 7: Chat-History Controls

Potential filters:

- Omit the last N user messages.
- Include only the branch after the latest compaction.
- Explicitly include or omit hidden/synthetic/custom messages.
- Summarize old history later.

Done criteria:

- Each option has a concrete use case and tests for dangling tool calls/results.
- Existing defaults remain stable.

## Priority 8: Prompt-Stack Lifecycle Controls

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

## Priority 9: Payload and Regex Expansion

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
- Run `npm run verify` before commits and releases; it covers tests, typecheck, and tracked `dist/` consistency.

## Next Design Session

1. Decide the exact profile interface, fields, and storage locations.
2. Write representative parent-session and subagent profile examples.
3. Define preflight, application order, provenance, drift, and failure semantics.
4. Update this plan with the agreed schema before implementing profile code.
