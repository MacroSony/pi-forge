# pi-forge Next Steps

## Current status

Implemented and working:

- Pi package setup with `src/index.ts` as the extension entrypoint.
- File-backed prompt stacks under `.pi/forge/prompt-stacks/*.json`, with legacy `.pi/prompt-stacks/*.json` still readable/editable for compatibility.
- `default.json` auto-activation unless `autoActivate` is `false`, with persisted `/preset use none` opt-out.
- Prompt stack system prompt replacement.
- Movable `chat-history` slot.
- Context rewrite limited to the first provider request of each user-submitted turn, avoiding repeated COT/post-history injection after tool calls.
- Runtime slots for tools, tool guidelines, skills, project context, date/cwd, active model, append-system-prompt, and Pi docs guidance.
- Basic macro expansion and turn/session/static prompt state.
- `/preset` commands for list/use/preview/validate/diagnostics/reload/vars, plus `/state` commands for typed session state.
- `/preset import-silly <file> [character_id] [--dry-run] [--overwrite]` command that writes prompt stacks and import reports.
- `/intercept` and `/payload next [save=<path>]` commands to display/save the next provider payload with basic redaction/truncation.
- Local converted SillyTavern writer preset can live in `.pi/forge/prompt-stacks/default.json`.
- Guardrails for bad stacks: stacks with error diagnostics are skipped during default activation, and empty replacement system prompts preserve Pi's base prompt.
- Active prompt stack status in the footer.
- Node built-in tests covering loader selection, system prompt compilation, chat-history placement, macros, diagnostics, prompt state slot rendering, SillyTavern import behavior, command/event behavior, and web-editor API smoke flows.
- `variables` slot that renders static/session/turn prompt state as valid XML or JSON, with scope/namespace filters and optional stack metadata.
- Branch-aware prompt state restoration during session tree navigation.
- `/state set <name> <json-or-text-value>` command for typed JSON-compatible session state, with `/preset vars` kept as legacy string commands.
- `forge_state_set` tool that lets the agent batch update `agent.*`-prefixed session state for cross-turn tracking, with `forge_set_var` kept as a compatibility alias.
- `/preset ui` lightweight localhost web editor for prompt-stack editing, validation, preview, native/SillyTavern JSON import, export, fork, delete, activation, and disable flows, using an available port by default with optional preferred-port fallback.
- Full-screen web preview inspector with collapsible system/message sections, char/token estimates, and copy controls.
- Web payload capture inspector that can arm the next provider request, display captures from UI or `/payload next`, preserve redaction, and show collapsible top-level JSON sections.
- Structured web editors for stack static `variables`, `state.definitions`, and `context` options.
- Raw stack JSON view/apply recovery path for advanced fields that do not have dedicated controls yet.
- Web editor polish for dark mode, button icons/tooltips, unsaved-change badge, export clipboard fallback, and inline item validation badges.
- Web runtime session-state editor that can view, set, and clear state using the same validation and persistence path as `/state`.
- Metadata-enabled variables slots render matching state definitions as `unset` entries before runtime values exist.
- SillyTavern `extensions.regex_scripts` import-report classification with prompt/display/disabled counts and report-only migration guidance.
- Web SillyTavern imports display the generated import report in a copyable editor modal.
- Supported SillyTavern-style variable macros such as `setvar`/`getvar` are reported as handled instead of migration-needed.
- Web editor source split into `src/web-editor/index.ts`, `types.ts`, `server.ts`, and `page.ts` without behavior changes.
- Opt-in `format: "plain"` compact rendering for structured prompt slots: `tools`, `tool-guidelines`, `skills`, `project-context`, and `variables`.
- Prompt-stack storage adapter in `src/storage.ts`; new stacks/imports write under `.pi/forge/prompt-stacks`, while legacy `.pi/prompt-stacks` remains readable and same-named forge files shadow legacy files.
- `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` copies legacy `.pi/prompt-stacks` files into `.pi/forge/prompt-stacks`, with explicit deletion required to remove legacy files.
- `src/index.ts` first split: web stack CRUD/settings moved to `src/web-host.ts`, and provider payload redaction/capture moved to `src/payload-capture.ts`.
- Web editor host/runtime context flow is bound once when the server starts; host methods no longer pass their captured command context back into runtime callbacks.

## Architecture simplification review

Review findings to keep in mind before adding regex runtime behavior, tool allow/deny controls, or a larger web UI:

- `src/web-editor/page.ts` is now the highest-friction file. It is still one embedded HTML/CSS/client-script string, which is workable for small edits but risky for richer regex/tool configuration screens. Split it along practical static boundaries later (`template`, `styles`, `client-script`) or introduce a tiny build step before the browser UI grows much further.
- `src/index.ts` is still broad, but stack file CRUD/web-editor host methods now live in `src/web-host.ts`, and payload capture/redaction lives in `src/payload-capture.ts`. Continue extracting `runtime-state` and `commands` before implementing tool policy.
- `src/sillytavern-importer.ts` has a large conversion/reporting pipeline. Split conversion, prompt-order selection, report building, regex reporting, and macro reporting into smaller pure helpers before expanding SillyTavern regex support.
- `src/compiler.ts` should separate prompt-state collection from format rendering. `variables` already supports multiple formats, and adding display-only versus outgoing-payload transforms will otherwise make renderer branches harder to reason about.
- Prompt-stack storage now writes new stacks to `.pi/forge/prompt-stacks` and reads legacy `.pi/prompt-stacks` for compatibility. Keep future persistent feature state under `.pi/forge`.
- Keep `src/web-editor/server.ts` lightweight. A tiny route table would be enough if more APIs are added; a full web framework is not warranted yet.
- Test coverage is healthy, but `tests/index-command.test.ts` is becoming a large integration blob. Move the reusable mocked extension harness into `tests/helpers` when the next command/API feature lands.

## Priority 1: Web inspector and state editing

Core web observability and state editing are now in place. Slash-command preview and payload intercept remain useful fallbacks, while the browser handles the larger structured views.

Completed inspector/state work:

- Replace the web editor's plain preview pane with a full-screen structured preview inspector.
- Show system prompt and message layout as separate collapsible sections with char and approximate token counts.
- Avoid early truncation in the browser preview; large sections render collapsed instead.
- Add copy controls for full preview and individual sections.
- Add structured editors for stack `variables` and `state.definitions`.
- Add a runtime state view/editor for current session state, equivalent to `/state list/set/get/clear`.
- Keep metadata-enabled state definitions visible in previews even before runtime values exist.
- Capture provider payloads into the web editor with collapsible JSON, redaction preserved, char/token estimates, copy controls, and arm/clear actions.
- Add a structured editor for stack `context` options.
- Add a raw JSON stack view/apply recovery path for advanced stack-level fields.

Remaining inspector/state work:

- No immediate Priority 1 blockers. Keep new inspector and state work focused on real prompt-debugging pain points.

## Priority 2: Command and lifecycle test coverage

Pure compiler/loader/importer tests are in place, plus a mocked command/event harness for `src/index.ts`. Most high-value command and lifecycle cases are covered now; keep extending the harness as new command, event, and web-editor behavior lands.

Extend the test harness that can instantiate the extension with mocked:

- `ExtensionAPI` command/tool/event registration
- `ExtensionContext` cwd, UI, trust, and session manager
- `appendEntry`, `setStatus`, `notify`, and editor calls

Current command/event coverage:

1. `/preset` second-level completions keep the subcommand in the inserted value, e.g. `use default`. - done
2. `/preset use <id>` persists the selected stack and updates footer status. - done
3. `/preset use none` persists the disabled selection and clears footer status. - done
4. `/preset reload` preserves an explicit disabled selection instead of reactivating `default.json`. - done
5. `/state set/get/clear` and legacy `/preset vars set/get/clear` update session state and persistence entries. - get/clear coverage added
6. `/preset validate` shows diagnostics for the requested stack. - done
7. `/preset import-silly` writes the stack and report, then reloads stack state. - collision coverage done
8. `session_start` restores variables and active stack selection. - done
9. `turn_start` persists active stack selection only when needed. - done
10. `/preset ui` starts/stops the local editor and protects the API with a URL token. - smoke coverage done
11. Web editor save/create/delete operations reload current Pi stack state. - smoke coverage done
12. Web editor runtime state API uses `/state` validation and persistence semantics. - smoke coverage done
13. `/preset migrate-stacks` copies legacy stacks, handles collisions, supports dry-run/overwrite/delete-legacy, and refuses untrusted writes. - done

## Priority 3: Harden SillyTavern importer

The first importer command is implemented. Next work should make it safer and more ergonomic.

Completed hardening:

- Add collision handling when `.pi/forge/prompt-stacks/<id>.json`, legacy `.pi/prompt-stacks/<id>.json`, or `.pi/forge/import-reports/<id>.md` already exists. - done via confirmation/`--overwrite`
- Add tests around command-level import behavior, not only the pure importer. - initial coverage done
- Preview generated output without writing files via `--dry-run`. - done
- Detect `extensions.regex_scripts` during import and classify enabled scripts by `promptOnly`, `markdownOnly`, both, disabled, and script name. - done, report-only
- Show import reports in the web editor after SillyTavern imports. - done
- Treat supported `setvar`/`getvar`-style macros as handled in reports. - done

Importer improvements:

- Choose a prompt order interactively when multiple `prompt_order` entries exist and no `character_id` was supplied.
- Preserve more SillyTavern metadata in `import.source`.
- Expand the unsupported macro report with suggested pi-forge replacements where clear.
- Add fixtures from real presets to catch field-shape drift.

SillyTavern regex script boundary:

- Preserve more regex metadata in import reports as real-world needs appear.
- Use `.pi/TGbreak😺V3.1.1.json` as the stress fixture: 13 enabled regex scripts, with 5 prompt-only, 6 display-only, and 2 mixed prompt/display scripts.
- Treat `markdownOnly` HTML/CSS decoration scripts as non-portable to Pi TUI; examples like action-option beautification should become report notes, not runtime behavior.
- Treat DOM/browser automation, toasts, preset-panel toggles, and embedded JavaScript as out of scope for pi-forge runtime.
- Consider a small opt-in prompt-transform subset only if real presets need it: deterministic regex replace before provider request, no DOM, no JavaScript eval, no UI rewriting, disabled by default, and visible in validation/report output.

TGbreak migration notes:

- Heavy ST state macros (`setvar`/`getvar`) should drive pi-forge state/macro work before regex runtime work.
- The preset has enough display-only regex that full ST regex compatibility would add complexity without useful TUI behavior.
- The importer should help users distinguish prompt semantics from ST presentation polish.

Regex runtime design draft:

- Start with an opt-in, deterministic regex subset: JavaScript `RegExp` find/replace only, no embedded JavaScript, no DOM access, no CSS/HTML decoration runtime, and no SillyTavern UI panel behavior.
- Treat regex rules as ordered prompt-stack data, likely under a top-level `regex` object with `schemaVersion` and `rules`.
- Model rule execution by explicit stage instead of one global text pass:
  - `history` stage: transform only messages selected for the `chat-history` slot. Supports role filters and limits such as `maxTurns`, `maxMessages`, and `maxChars`.
  - `compiled` stage: transform final compiled prompt text before provider serialization. Supports targets such as `system`, `messages`, and message-role filters.
  - `payload` stage: advanced provider-payload rewrite in `before_provider_request`. Keep off by default and require explicit target paths because provider payload shapes differ.
  - `display` stage: transform web preview/display only. Never changes outgoing model input.
- Keep outgoing versus display behavior explicit with a field like `effect: "outgoing" | "display" | "both"`. SillyTavern `promptOnly` maps to outgoing, `markdownOnly` maps to display, and mixed rules require review.
- Suggested rule shape:

```json
{
  "id": "trim-ooc",
  "name": "Trim OOC markers from recent history",
  "enabled": true,
  "stage": "history",
  "effect": "outgoing",
  "pattern": "\\(OOC:[^)]+\\)",
  "flags": "gi",
  "replace": "",
  "roles": ["user", "assistant"],
  "maxTurns": 20
}
```

- Validation should compile every regex, reject unsupported flags, require valid IDs, warn on display-only rules in TUI contexts, and show match/change counts in preview diagnostics.
- Current Pi hooks can replace finalized assistant messages at `message_end`, so `displayFinal` cleanup is feasible: users may see raw streamed text during generation, but the final stored/displayed transcript can be regex-cleaned afterward. Current hooks do not support reliable `displayStreaming` cleanup; hiding partial blocks such as `(OOC: ... )` while streaming would require a future transformable streaming-display hook and a stateful buffered filter.
- Implementation order: first add pure regex rule types/validation/application tests, then apply `history` and `compiled` stages in the existing prompt compilation path, then expose a raw/structured web editor, then revisit provider-payload stage.

## Priority 4: Web editor polish

The lightweight web editor is implemented and usable. Future polish should stay focused rather than turning it into a separate full application too early.

Completed polish:

- Unsaved-change indicator tied to the selected stack.
- Copy-to-clipboard export fallback in addition to JSON download.
- Inline validation badges beside specific stack items.
- Structured editor for stack `context` options.
- Raw stack JSON view/apply recovery path for advanced stack-level fields.
- Light/dark theme toggle, toolbar/modal/inspector button icons, and hover tooltips.
- Split the long `src/web-editor.ts` file into a `src/web-editor/` module folder:
  - `src/web-editor/index.ts` for public exports.
  - `src/web-editor/types.ts` for shared web editor contracts.
  - `src/web-editor/server.ts` for HTTP routing, token checks, request parsing, and response helpers.
  - `src/web-editor/page.ts` for the embedded HTML/CSS/client script string.

High-value follow-ups:

- Better import flow for pasted JSON, not only file selection.
- Browser-level smoke screenshots if a browser test dependency is added later.
- Keyboard shortcuts for save, validate, preview, and close dialog once the UI settles.
- Consider splitting `src/web-editor/page.ts` later along static page boundaries (`markup`, `styles`, `client-script`) only if UI work keeps growing. Do not split browser logic into many string fragments without a bundler.

Keep slash-command fallbacks for terminal-first workflows.

## Priority 5: Prompt slot formats and token budget

Structured prompt slots can render as XML-style output by default or compact plain text when `options.format` is `"plain"`. `variables` also supports `"json"` for JSON-shaped state. XML remains the default because it gives clear boundaries, names, attributes, and nesting for mixed prompt content.

Completed compact-format work:

- Added `format: "plain"` as an opt-in compact format, not a default replacement.
- Supported plain output for `tools`, `tool-guidelines`, `skills`, `project-context`, and `variables`.
- Kept `xml` default for backwards compatibility and for robustness around multiline values, metadata-heavy state, and prompt-injection-like content.
- Kept `json` support for `variables`; JSON is still not supported for other structured slots.
- Render plain text with concise headings and newline-separated bullets, for example:

```txt
Available tools:
- read: Read files from disk.
- bash: Run shell commands.

Available skills:
- review: Review code for correctness. Location: /skills/review/SKILL.md

Prompt state:
session:
- agent.progress (string): step 2
```

Follow-ups:

- Compare real prompt previews across XML vs plain in daily use; keep XML as the recommended default unless plain output proves robust enough for specific stacks.
- Consider stack-level format defaults only if per-slot configuration becomes repetitive.

## Priority 6: Prompt state lifecycle metadata

### Add update metadata later

Current state definitions can declare type, scope, description, and write permissions. Later stored values could support runtime metadata:

```json
{
  "value": "...",
  "scope": "session",
  "description": "What this variable means",
  "updatedBy": "agent",
  "updatedAt": "..."
}
```

Keep persisted values as plain JSON for now; add metadata only if it becomes necessary for state review, expiration, or subagent curation.

## Priority 7: Improve macro engine

### 1. Replace regex-only parsing with a small macro parser

Current parser cannot handle nested macros like:

```txt
{{setvar::latest::{{lastUserMessage}}}}
```

Implement a small parser that can:

- find balanced `{{...}}` spans
- recursively expand arguments
- preserve unknown macros according to policy
- report diagnostics with item IDs

### 2. Add conditionals

Useful macros:

```txt
{{ifvar::name::then text::else text}}
{{ifeq::name::expected::then text::else text}}
{{iftools::toolName::then text::else text}}
{{ifslot::slotName::then text::else text}}
```

This would let one preset adapt to coding, creative writing, tool-heavy, or no-tool contexts.

### 3. Add safe string transforms

Useful low-risk transforms:

```txt
{{trim::...}}
{{upper::...}}
{{lower::...}}
{{json::...}}
{{xml::...}}
```

`xml` escaping is especially useful for generated XML context blocks.

## Priority 8: Better chat-history controls

Current option:

```json
"options": {
  "includeLastUserMessage": false
}
```

Next options:

```json
"options": {
  "includeLastUserMessage": false,
  "includeToolResults": true,
  "includeToolCalls": true,
  "includeSyntheticMessages": false,
  "maxMessages": null,
  "maxApproxChars": null
}
```

Potential filters:

- omit last N user messages
- only include current branch after last compaction
- omit hidden/custom messages
- include/exclude tool result messages
- summarize old history later

## Priority 9: Prompt-stack lifecycle controls

The current behavior rewrites context only once per user turn. That fixed tool-call loops.

Expose this as stack config:

```json
"lifecycle": {
  "contextRewrite": "first-provider-request"
}
```

Possible future values:

- `first-provider-request` — current safe default
- `every-provider-request` — advanced/debug only
- `user-only-no-tools` — skip rewrite when tool follow-up is expected
- `disabled` — only replace system prompt

Also add diagnostics warning if a stack has post-history COT blocks and uses `every-provider-request`.

## Priority 10: Tests

Pure compiler/loader/importer tests exist. Keep extending them before the command surface grows much more.

Suggested setup:

- keep Node's built-in test runner for now
- keep extending the narrow extension harness for command/event behavior
- keep pure compiler/loader/importer tests separate from command/event tests

Current and next test cases:

1. system prompt compile order - done
2. empty replacement system prompt fallback - done
3. chat-history expansion - done
4. `includeLastUserMessage=false` - done
5. static variables - done
6. turn variables - done
7. session variables - done
8. unknown macro diagnostics - done
9. duplicate chat-history warning - done
10. unsupported slot warning - done
11. invalid default stack selection - done
12. variables slot rendering - done
13. SillyTavern importer happy path and error handling - done
14. SillyTavern marker filtering and `lastUserMessage` handling - done
15. context rewrite once per user turn behavior - done
16. command behavior for `/state` and `/preset vars` - get/clear and validation coverage done
17. command behavior for `/preset validate` - done
18. command behavior for `/preset import-silly` - collision coverage done
19. command/tool lifecycle tests for `forge_state_set` - validation coverage done
20. `/payload next save=<path>` redaction/save behavior - done
21. `/preset ui` API smoke test for serve/save/create/delete and runtime state set/clear - done
22. Web preview inspector returns full structured sections without browser-side truncation - done
23. Web payload capture API arms, captures, redacts, exposes, and clears provider payloads - done
24. Web editor bundled page exposes context/raw JSON/polish controls and parses its inline script - done
25. SillyTavern `regex_scripts` import-report classification using TGbreak as a fixture - done

## Priority 11: Payload/debug tools

Improve `/intercept`:

- optional command name `/payload next` - done
- option to save payload to file - done:

```txt
/payload next save=.pi/forge/payloads/last.json
```

- redact API keys and large binary/image content - basic redaction/truncation done
- show token-ish size estimates if possible - basic char/approx-token display done
- mirror captured payloads into the web editor inspector with collapsible JSON - done
- add broader payload-shape tests for provider-specific payloads

## Priority 12: Agent profiles later

Keep out of prompt-stack MVP for now, but design around:

```txt
.pi/agent-profiles/*.json
```

Profiles should own:

- model/provider
- thinking level
- active tools
- fallback models
- context rewrite lifecycle
- prompt stack reference

Prompt stacks should remain about message/system layout.

## Suggested next coding session

1. Continue splitting `src/index.ts` by moving runtime state and command handlers into focused modules.
2. Split the embedded web editor page along practical static boundaries before adding larger regex/tool screens.
3. Refactor the SillyTavern importer pipeline so regex and macro reporting can grow without bloating one function.
4. Design preset-level tool allow/deny controls on top of the cleaner storage/module boundaries.
5. Design the regex runtime system around explicit prompt-payload versus display-only transform stages.
