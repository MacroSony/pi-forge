# pi-forge Next Steps

This file is forward-looking only. Shipped capability belongs in `FEATURES.md`; release history belongs in `CHANGELOG.md`.

## Current Read

- `0.3.2` is the current released baseline. Prompt stacks, storage migration, tool policy, model-visible skill filtering, regex MVP, SillyTavern import, web editor, payload inspection, trusted macro/slot extensions, and command/lifecycle coverage are shipped.
- The current 0.4 branch implements strict project-local agent profiles with exact model, thinking-level, and prompt-stack references; one-shot save/use; preflight and preview; branch-scoped last-applied provenance; and runtime drift reporting.
- The web editor page shell, static styles, and browser client are split. Browser smoke verification now gates larger UI work.
- Prompt stacks remain scoped to prompt/message layout and strict active-tool constraints. Skill policy filters model-visible pi-forge skill listings; it is not a security boundary.
- Profile v1 deliberately omits tool/skill lists, generation parameters, fallbacks, and runner limits. Prompt stacks own tool policy; unsupported profile fields fail validation instead of becoming inert configuration.
- New prompt-stack behavior should be driven by real prompt-authoring pain, not by aiming for complete SillyTavern compatibility.

## Plan Assessment

Recommended ordering:

1. Exercise the profile CLI against real installed providers and extension toolsets, then fix any compatibility findings without expanding the schema.
2. Add profile UI on top of the stable loader/resolver/application core, extending browser smoke coverage with each workflow.
3. Add a narrow subagent adapter boundary without requiring a subagent package.
4. Revisit custom macro/slot portability metadata and importer fidelity only when real sharing or preset drift demonstrates the need.
5. Defer provider-payload rewriting, true display regex, and an owned subagent runner until stable hooks and concrete use cases exist.

Risk calls:

- Keep prompt-stack JSON declarative. Trusted executable customization belongs in `~/.pi/forge/extensions`, `.pi/forge/extensions`, or reusable packages.
- Treat an agent profile as a one-shot preset. Applying it configures Pi once; subsequent user changes must not be continuously overwritten.
- Keep tool names out of agent profiles. The referenced prompt stack is the single source of truth for strict tool policy while active.
- Treat skill policy as model-visible prompt filtering only. It does not disable explicit skill invocation or provide a security boundary.
- Keep generation parameters, model fallbacks, global storage, and runner limits out of profile v1 until a concrete consumer can enforce their semantics consistently.
- Avoid expanding the browser editor without browser-level workflow coverage.
- Do not add delegation until real-world profile CLI testing confirms resolution, application diagnostics, and runtime drift reporting are coherent.

## Priority 1: Profile UI

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

## Priority 2: Subagent Adapter Boundary

Goal: make stored profiles useful to subagent systems without committing to one runner.

Boundaries:

- Do not hard-depend on `pi-subagents`, `@gotgenes/pi-subagents`, Archimedes, or another runner in 0.4.
- Keep profile definition, validation, resolution, preview, and export as pi-forge's responsibility.
- Resolve provider plus model ID, thinking level, loaded prompt-stack/tool policy, and diagnostics into a stable adapter-facing object. The runner supplies its available tool baseline; the stack policy filters it.
- Do not export parent chat history or dynamic compiled context by default.
- Verify any optional event-bus adapter against the supported Pi version range before adopting it.

Done criteria:

- The resolved profile object is independent of the web editor and command handlers.
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
- Run `npm run verify` before commits and releases; it covers tests, typecheck, and tracked `dist/` consistency.

## Next Design Session

1. Run `/profile save`, `preview`, `use`, `status`, `reload`, and `forget` against real providers, model switches, restrictive stacks, and extension tools.
2. Decide the smallest profile editor workflow and add its browser-test cases before implementation.
3. Define the adapter-facing resolved-profile contract and which side owns tool registration, cancellation, and result formatting.
4. Keep generation parameters and enforceable limits deferred until the adapter or a chosen runner exposes a stable consumer.
