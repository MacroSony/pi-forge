# pi-forge Next Steps

This file is forward-looking only. Shipped capability belongs in `FEATURES.md`; release history belongs in `CHANGELOG.md`.

## Current Read

- `0.3.2` is a patch release candidate on top of the complete `0.3.0` feature surface: prompt stacks, storage migration, policy, regex MVP, SillyTavern import, web editor, payload inspector, and command/lifecycle coverage are shipped.
- The command/lifecycle and SillyTavern importer pipeline extractions are handled. Macro parser/registry groundwork, lazy conditionals, slot registry cleanup, trusted macro/slot registration APIs, global/project `.pi/forge/extensions` loading, and 0.3.1 web editor QoL are handled. The web editor shell, styles, and browser script are split; the next maintainability constraint is runtime effect ownership.
- New behavior should be driven by real prompt-authoring pain, not by aiming for full SillyTavern compatibility.
- Keep prompt stacks scoped to message/system layout. Model, provider, thinking, and broad tool-profile choices belong in a later agent-profile layer.
- The likely 0.4.0 path is profile-first, subagent-ready. Build native agent profiles and the runtime ownership model before deciding whether pi-forge should own a subagent runner.

## Plan Assessment

The plan is healthy, but it should stop treating completed release work as roadmap. The highest leverage next work is runtime effect ownership before agent profiles and subagent integration.

Recommended ordering:

1. Add a central runtime effect resolver for stack/profile-owned model, thinking, tool, skill, and prompt-stack effects.
2. Add native agent profiles with a `/profile` command namespace and separate storage from prompt stacks.
3. Add profile UI on top of the split web editor shell.
4. Add a narrow subagent adapter boundary, but do not hard-depend on an existing subagent package for 0.4.0.
5. Add custom macro/slot dependency metadata only if portable sharing becomes painful in practice.
6. Preserve additional SillyTavern import metadata and fixtures only when real presets reveal useful drift.
7. Defer true display regex, provider-payload rewrite, and an owned subagent runner until usage proves the need.

Risk calls:

- Trusted customization now has a code-level registration boundary through `~/.pi/forge/extensions`, `.pi/forge/extensions`, and reusable package APIs. Keep prompt-stack JSON declarative; if portability pain appears, add dependency metadata instead of inline code.
- Web editor growth is less risky after the shell/styles/client split, but larger profile screens should still stay out of the page shell.
- Provider-payload transforms are high-risk because provider shapes vary; keep them out until there is a precise use case.
- True display-only regex needs platform support for display/stream transforms. The current finalize behavior is not a substitute because it mutates the transcript.
- Agent profiles are a separate product surface. Mixing them into prompt stacks would muddy ownership.
- Subagents multiply existing runtime ownership problems. Do not add delegation until profile activation, baseline restoration, diagnostics, and UI state are coherent.

## Priority 1: Keep Web Editor Shell Split

Goal: keep the browser editor maintainable without prematurely building a separate app.

Work:

- Keep `src/web-editor/page.ts` limited to page-shell composition.
- Keep static CSS in `src/web-editor/styles.ts`.
- Keep browser behavior in `src/web-editor/client-script.ts`.
- Keep the server lightweight. Add a tiny route table only if API count keeps growing.
- Do not split browser logic into many string fragments without a bundler.
- If browser-level verification becomes important, add smoke screenshots with a browser dependency later.

Follow-up UI candidates:

- Pasted JSON import flow, not only file selection.
- Dynamic registered slot/macro discovery in the structured editor.
- Larger policy/regex screens only after the page split.

Done criteria:

- No editor behavior changes.
- Page/client code is easier to review.
- Existing web editor smoke tests still pass.

## Priority 2: Runtime Effect Ownership

Goal: prevent prompt stacks, agent profiles, and future subagents from clobbering each other's model, thinking, tool, skill, and prompt-stack effects.

Current issue:

- Prompt-stack tool policy snapshots `pi.getActiveTools()` and restores it when the active stack no longer has a policy.
- Agent profiles will also want to set tools, model, thinking level, and prompt-stack selection.
- External user changes and other extensions can happen while a pi-forge-owned policy is active.
- Subagents will need clear inheritance/export behavior from the parent profile.

Work:

- Add a small runtime effect resolver that computes the desired Pi runtime state from:
  - active agent profile
  - active prompt stack
  - user/manual Pi state baseline
  - known tool registry
- Replace ad hoc `toolPolicyBaseline` logic with resolver-managed baselines and restore rules.
- Track which fields are owned by pi-forge and which are informational only.
- Subscribe to model/thinking/tool-related events where available, so external changes can update the baseline instead of being overwritten later.
- Make preview use the same resolver logic as runtime activation.

Done criteria:

- Existing prompt-stack tool policy behavior is preserved.
- Disabling/switching stacks restores the expected tools without clobbering unrelated manual changes.
- The resolver has focused tests for stack-only, profile-only, profile-plus-stack, disabled profile, unknown tools, and external state changes.

## Priority 3: Native Agent Profiles

Goal: add a first-class profile layer that can later feed subagents without turning prompt stacks into broad runtime presets.

Storage:

```txt
.pi/forge/agent-profiles/*.json
```

Initial profile shape:

```json
{
  "schemaVersion": 1,
  "id": "reviewer",
  "name": "Reviewer",
  "description": "Strict review profile",
  "model": { "provider": "anthropic", "id": "claude-sonnet-4-5" },
  "thinkingLevel": "high",
  "tools": { "allow": ["read", "grep", "find", "ls"] },
  "skills": { "deny": ["dangerous-*"] },
  "promptStack": "reviewer",
  "lifecycle": {
    "contextRewrite": "first-provider-request"
  },
  "subagents": {
    "enabled": false,
    "inheritsProfile": true
  }
}
```

Design boundaries:

- Keep profile fields out of `PromptStack`.
- Use `/profile`, not `/preset`, because `/preset` already means prompt stack in pi-forge.
- Treat model and thinking as profile-owned runtime effects, using Pi's `setModel` and `setThinkingLevel` APIs when the target model exists and has usable auth.
- Treat prompt stack as a profile reference, not embedded prompt-stack data.
- Let prompt-stack tool/skill policy refine the profile's base tool/skill state instead of competing with it.
- Keep `subagents` metadata inert in 0.4.0 unless an adapter explicitly consumes it.

Commands:

- `/profile list`
- `/profile status`
- `/profile use <id|none>`
- `/profile preview [id]`
- `/profile validate [id]`
- `/profile reload`

Done criteria:

- Profiles can be loaded, validated, activated, disabled, previewed, persisted in session state, and restored on session start/tree navigation.
- Profile activation can set model, thinking level, tool policy, skill policy, and referenced prompt stack.
- Diagnostics explain missing models, missing prompt stacks, unknown tools, and ignored fields.
- `npm test`, `npm run typecheck`, and `git diff --check` pass.

## Priority 4: Profile UI

Goal: expose profile management in the browser only after the editor file split makes the code reviewable.

Work:

- Add a profile list/detail view beside prompt stacks.
- Reuse the policy resource picker for profile tool and skill policy.
- Add model/thinking controls based on available model registry data when accessible.
- Add a prompt-stack picker by ID.
- Add raw JSON recovery for advanced fields.

Done criteria:

- Users can create, edit, validate, save, activate, deactivate, and delete profiles.
- Profile UI does not duplicate prompt-stack item editing logic.
- Editor smoke tests cover profile API token checks, save, validate, activate/deactivate, and delete.

## Priority 5: Subagent Adapter Boundary

Goal: make pi-forge profiles usable by subagent systems without committing to one runner.

Near-term decision:

- Do not hard-depend on `pi-subagents`, `@gotgenes/pi-subagents`, Archimedes, or another subagent package in 0.4.0.
- Existing packages are useful references and optional integration targets, but they own broad UX/runtime behavior that overlaps with pi-forge profiles.
- Keep pi-forge's first responsibility as profile definition, activation, preview, validation, and export.

Adapter/API work:

- Define a small internal profile resolution result that future adapters can consume:
  - profile id/name
  - resolved model id
  - thinking level
  - resolved tool names
  - referenced prompt stack id
  - compiled prompt preview or prompt-stack path when appropriate
- Add export helpers for generating common agent markdown/frontmatter only if it proves useful.
- Consider an optional event-bus adapter for `pi-subagents` only after profile activation is stable and the package API is verified against the supported Pi version range.

Done criteria:

- The profile resolver can produce a stable object that is independent of the web editor and command handlers.
- No subagent package is required to install or use pi-forge.
- Documentation explains how profiles relate to external subagent packages.

## Priority 6: Owned Subagent Runner Decision

Goal: decide whether pi-forge should build its own subagent system only after profiles are real.

Default answer for now:

- Do not build a full runner in 0.4.0.
- If pi-forge later owns a runner, start narrow: subprocess-based, fresh context, profile-backed, foreground-first, simple background status, no chains/pipelines at first.
- Prefer subprocess isolation initially because Pi's official example uses separate `pi --mode json -p --no-session` processes and it avoids sharing mutable extension/session state.

Runner requirements before implementation:

- Cancellation and cleanup semantics.
- Project trust prompts for project-local agents/profiles.
- Status UI and compact result rendering.
- Budget/turn/output limits.
- Tool/model/profile inheritance rules.
- Artifact/result storage policy.
- Failure format and retry semantics.
- Protection against recursive delegation loops.

Decision criteria:

- Build native only if profiles need behavior external packages cannot provide without taking over pi-forge's product surface.
- Otherwise provide adapters/export and let dedicated subagent packages own orchestration.

## Priority 7: Custom Macro/Slot Portability Metadata

Goal: improve sharing for stacks that depend on trusted custom registration code, without allowing executable code in stack JSON.

Design boundaries:

- Treat macros as inline renderers and slots as block/message renderers.
- Keep built-in macros and slots behind registries internally.
- Keep prompt-stack files declarative. Do not allow arbitrary JavaScript or expression code inside stack JSON.
- User-defined macro/slot code lives in trusted `~/.pi/forge/extensions` / `.pi/forge/extensions` modules or reusable Pi packages that call `registerMacro` and `registerSlot`, not raw prompt-stack data.
- Keep conditions simple and lazy. Only expand the selected branch so skipped branches cannot mutate variables.

Potential work:

- Add optional stack-level dependency hints such as required slots, macros, or extension package names.
- Surface missing custom macro/slot dependencies more clearly in validation and the web editor.
- Preserve parser, filter, conditional, slot, and unknown-policy compatibility while adding metadata.
- Defer general expression syntax, boolean algebra, loops, arithmetic, regex conditions, and arbitrary user code.

Done criteria:

- Existing macro and slot behavior and diagnostics are preserved.
- Compiler tests cover registry-backed slots, conditionals, branch laziness, mutation macros, escaping, and existing nested/filter behavior.
- The public customization boundary is explicit about trusted code versus stack-authored declarative data.

## SillyTavern Importer Follow-ups

Goal: broaden importer fidelity only when real presets show useful field-shape drift.

Work:

- Preserve more useful original SillyTavern metadata under `import`.
- Add fixtures from real presets when they reveal shapes not already covered.
- Keep regex and macro warning additions inside the extracted importer modules.

Done criteria:

- Existing import behavior stays stable unless the fixture proves the change.
- Report-only cases remain report-only.
- Adding a macro or regex warning stays local to the relevant importer module.

## Priority 8: Chat-History Controls

Goal: add only the controls that solve real prompt layout problems.

Potential filters:

- Omit last N user messages.
- Include only current branch after last compaction.
- Omit hidden/custom messages.
- Include/exclude synthetic/custom messages explicitly.
- Summarize old history later.

Done criteria:

- Each new option has a concrete use case and tests for dangling tool calls/results.
- Existing defaults remain stable.

## Priority 9: Prompt-Stack Lifecycle Controls

Goal: expose current context-rewrite behavior as explicit stack configuration only if users need it.

Potential config:

```json
{
  "lifecycle": {
    "contextRewrite": "first-provider-request"
  }
}
```

Possible values:

- `first-provider-request` - current safe default.
- `every-provider-request` - advanced/debug only.
- `user-only-no-tools` - skip rewrite when tool follow-up is expected.
- `disabled` - only replace system prompt.

Done criteria:

- Default behavior remains unchanged.
- Diagnostics warn when a stack combines repeated rewrites with post-history chain-of-thought style blocks.

## Priority 10: Payload and Regex Expansion

Goal: avoid broad payload/display transforms until usage justifies them.

Keep deferred:

- Provider-payload rewrite stage.
- True display-only regex transforms.
- Streaming display cleanup.

Allowed near-term work:

- Broader payload-shape tests for provider-specific payloads.
- Better diagnostics for what regex changed and where.

Decision rule:

- Implement a new regex stage only when there is a precise use case, a stable hook, and a clear non-destructive preview path.

## Ongoing Test Policy

- Keep Node's built-in test runner for now.
- Extend the command/event harness when command or lifecycle behavior changes.
- Keep pure compiler, loader, importer, regex, and policy tests separate from integration-style command tests.
- Add tests before broadening importer conversion, macro parsing, lifecycle controls, or chat-history filtering.
- Run `npm test`, `npm run typecheck`, and `git diff --check` before release or publish work.

## Next Coding Session

1. Add runtime effect ownership tests and replace ad hoc tool-policy baseline handling.
2. Add profile schema/storage/loader and `/profile` command skeleton.
3. Add profile UI on top of the existing split page shell.
4. Verify with focused command/runtime tests, full test suite, typecheck, and `git diff --check`.
