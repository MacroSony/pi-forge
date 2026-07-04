# pi-forge Next Steps

This file is forward-looking only. Shipped capability belongs in `FEATURES.md`; release history belongs in `CHANGELOG.md`.

## Current Read

- `0.3.0` is a complete feature release: prompt stacks, storage migration, policy, regex MVP, SillyTavern import, web editor, payload inspector, and command/lifecycle coverage are shipped.
- The command/lifecycle extraction is handled in the current working tree. The next maintainability constraints are `src/sillytavern-importer.ts`, `src/web-editor/page.ts`, and continued discipline keeping `src/index.ts` as extension wiring.
- New behavior should be driven by real prompt-authoring pain, not by aiming for full SillyTavern compatibility.
- Keep prompt stacks scoped to message/system layout. Model, provider, thinking, and broad tool-profile choices belong in a later agent-profile layer.

## Plan Assessment

The plan is healthy, but it should stop treating completed release work as roadmap. The highest leverage next work is architecture cleanup before expanding regex, macros, or web UI. That reduces regression risk and makes the next user-facing feature cheaper to implement.

Recommended ordering:

1. Refactor `src/sillytavern-importer.ts` before adding richer macro/regex reporting.
2. Improve the macro parser as the next major user-facing feature.
3. Split `src/web-editor/page.ts` before adding larger screens.
4. Defer true display regex, provider-payload rewrite, and agent profiles until usage proves the need.

Risk calls:

- Macro parsing is worth doing, but only after the importer pipeline is easier to change. It touches the compiler and importer reports. Keep prompt-stack JSON declarative; custom macro/slot code should live in trusted extension APIs, not inline stack data.
- Web editor growth without a static split or tiny build step will keep making reviews noisy.
- Provider-payload transforms are high-risk because provider shapes vary; keep them out until there is a precise use case.
- True display-only regex needs platform support for display/stream transforms. The current finalize behavior is not a substitute because it mutates the transcript.
- Agent profiles are a separate product surface. Mixing them into prompt stacks would muddy ownership.

## Priority 1: Refactor SillyTavern Importer Pipeline

Goal: make importer changes easier without bloating one conversion function.

Work:

- Split prompt-order selection from prompt/item conversion.
- Split report building from conversion.
- Split regex script classification/conversion from prompt conversion.
- Split macro detection/reporting from prompt conversion.
- Preserve more useful SillyTavern metadata in `import.source`.
- Add fixtures from real presets when they reveal field-shape drift.

Done criteria:

- Existing import behavior is unchanged.
- Report-only cases remain report-only.
- Adding a macro or regex warning no longer requires editing the whole importer pipeline.

## Priority 2: Improve Macro Engine

Goal: replace regex-only macro scanning with a parser and registry-backed renderers that can handle nested macros, simple conditionals, and future trusted customization without turning prompt-stack JSON into a scripting language.

Design boundaries:

- Treat macros as inline renderers and slots as block/message renderers.
- Back built-in macros and slots with registries internally, even before exposing a public registration API.
- Keep prompt-stack files declarative. Do not allow arbitrary JavaScript or expression code inside stack JSON.
- Add user-defined macro/slot code later through trusted extension APIs such as `registerMacro` and `registerSlot`, not through raw prompt-stack data.
- Keep conditions simple and lazy. Only expand the selected branch so skipped branches cannot mutate variables.

Work:

- Parse balanced `{{...}}` spans.
- Recursively expand macro arguments.
- Preserve unknown macros according to the existing unknown-macro policy.
- Keep diagnostics tied to item IDs where possible.
- Refactor built-in macros into an internal registry:
  - `cwd`
  - `date`
  - `time`
  - `lastUserMessage`
  - `selectedTools`
  - `tools`
  - `activeModel`
  - variable get/set/clear macros
- Refactor built-in slots toward the same renderer shape where practical:
  - `chat-history`
  - `tools`
  - `tool-guidelines`
  - `skills`
  - `project-context`
  - `variables`
- Add safe output filters/transforms:
  - `{{trim::...}}`
  - `{{upper::...}}`
  - `{{lower::...}}`
  - `{{json::...}}`
  - `{{xml::...}}`
- Add basic conditionals after parser behavior is stable:
  - `{{ifvar::name::then text}}`
  - `{{ifvar::name::then text::else text}}`
  - `{{ifeq::name::expected::then text}}`
  - `{{ifeq::name::expected::then text::else text}}`
  - `{{iftools::toolName::then text}}`
  - `{{iftools::toolName::then text::else text}}`
  - `{{ifslot::slotName::then text}}`
  - `{{ifslot::slotName::then text::else text}}`
- Defer general expression syntax, boolean algebra, loops, arithmetic, regex conditions, and arbitrary user code.

Done criteria:

- Nested macro case works, for example `{{setvar::latest::{{lastUserMessage}}}}`.
- Conditional branches are lazily expanded, so only the chosen branch can run mutation macros.
- Existing macro behavior and diagnostics are preserved.
- Compiler tests cover nested expansion, unknown macros, mutation macros, escaping, filter output, and basic conditionals.
- Internal macro registration makes adding a built-in macro a local change instead of editing one long conditional chain.

## Priority 3: Split Web Editor Page Before Larger UI Work

Goal: keep the browser editor maintainable without prematurely building a separate app.

Work:

- Split `src/web-editor/page.ts` along practical static boundaries: page shell, styles, and client script.
- Keep the server lightweight. Add a tiny route table only if API count keeps growing.
- Do not split browser logic into many string fragments without a bundler.
- If browser-level verification becomes important, add smoke screenshots with a browser dependency later.

Follow-up UI candidates:

- Pasted JSON import flow, not only file selection.
- Keyboard shortcuts for save, validate, preview, and closing dialogs.
- Larger policy/regex screens only after the page split.

Done criteria:

- No editor behavior changes.
- Page/client code is easier to review.
- Existing web editor smoke tests still pass.

## Priority 4: Chat-History Controls

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

## Priority 5: Prompt-Stack Lifecycle Controls

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

## Priority 6: Payload and Regex Expansion

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

## Priority 7: Agent Profiles Later

Goal: keep prompt stacks focused on prompt/message layout.

Future profile path:

```txt
.pi/agent-profiles/*.json
```

Profiles may own:

- model/provider
- thinking level
- active tools
- fallback models
- context rewrite lifecycle
- prompt stack reference

Decision rule:

- Do not add profile fields to prompt stacks unless they directly affect prompt compilation.

## Ongoing Test Policy

- Keep Node's built-in test runner for now.
- Extend the command/event harness when command or lifecycle behavior changes.
- Keep pure compiler, loader, importer, regex, and policy tests separate from integration-style command tests.
- Add tests before broadening importer conversion, macro parsing, lifecycle controls, or chat-history filtering.
- Run `npm test`, `npm run typecheck`, and `git diff --check` before release or publish work.

## Next Coding Session

1. Refactor the SillyTavern importer pipeline without behavior changes.
2. Keep regex and macro reporting report-only unless the existing safe conversion rules already cover them.
3. Verify with importer tests, command tests, full test suite, typecheck, and `git diff --check`.
