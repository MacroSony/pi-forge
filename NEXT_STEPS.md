# pi-forge Next Steps

## Current status

Implemented and working:

- Pi package setup with `src/index.ts` as the extension entrypoint.
- File-backed prompt stacks under `.pi/forge/prompt-stacks/*.json`, with legacy `.pi/prompt-stacks/*.json` still readable/editable for compatibility.
- `default.json` auto-activation unless `autoActivate` is `false`, with persisted `/preset use none` opt-out.
- Prompt stack system prompt replacement.
- Movable `chat-history` slot.
- Opt-in `stripAssistantThinking` on `chat-history` slots to remove prior assistant thinking blocks while preserving visible text, tool calls, and tool results.
- Context rewrite limited to the first provider request of each user-submitted turn, avoiding repeated COT/post-history injection after tool calls.
- Runtime slots for tools, tool guidelines, skills, project context, date/cwd, active model, append-system-prompt, and Pi docs guidance.
- Basic macro expansion and turn/session/static template variables.
- `/preset` commands for list/use/preview/validate/diagnostics/reload/import/ui.
- `/preset import-silly <file> [character_id] [--dry-run] [--overwrite]` command that writes prompt stacks and import reports.
- `/intercept` and `/payload next [save=<path>]` commands to display/save the next provider payload with basic redaction/truncation.
- Local converted SillyTavern writer preset can live in `.pi/forge/prompt-stacks/default.json`.
- Guardrails for bad stacks: stacks with error diagnostics are skipped during default activation, and empty replacement system prompts preserve Pi's base prompt.
- Active prompt stack status in the footer.
- Node built-in tests covering loader selection, system prompt compilation, chat-history placement, macros, diagnostics, variables slot rendering, SillyTavern import behavior, command/event behavior, and web-editor API smoke flows.
- `variables` slot that renders static/session/turn template variables as valid XML or plain text.
- Branch-aware macro session variable restoration during session tree navigation.
- `/preset ui` lightweight localhost web editor for prompt-stack editing, validation, preview, native/SillyTavern JSON import, export, fork, delete, activation, and disable flows, using an available port by default with optional preferred-port fallback.
- Full-screen web preview inspector with collapsible system/message sections, char/token estimates, and copy controls.
- Web payload capture inspector that can arm the next provider request, display captures from UI or `/payload next`, preserve redaction, and show collapsible top-level JSON sections.
- Tabbed structured web editors for items, stack static `variables`, `context` options, raw stack JSON, policy, and regex rules.
- Raw stack JSON view/apply recovery path for advanced fields that do not have dedicated controls yet.
- Web editor polish for dark mode, button icons/tooltips, unsaved-change badge, export clipboard fallback, and inline item validation badges.
- SillyTavern `extensions.regex_scripts` import-report classification with prompt/display/disabled counts and report-only migration guidance.
- Web SillyTavern imports display the generated import report in a copyable editor modal.
- Supported SillyTavern-style variable macros such as `setvar`/`getvar` are reported as handled instead of migration-needed.
- Web editor source split into `src/web-editor/index.ts`, `types.ts`, `server.ts`, and `page.ts` without behavior changes.
- Opt-in `format: "plain"` compact rendering for structured prompt slots: `tools`, `tool-guidelines`, `skills`, `project-context`, and `variables`.
- Prompt-stack storage adapter in `src/storage.ts`; new stacks/imports write under `.pi/forge/prompt-stacks`, while legacy `.pi/prompt-stacks` remains readable and same-named forge files shadow legacy files.
- `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` copies legacy `.pi/prompt-stacks` files into `.pi/forge/prompt-stacks`, with explicit deletion required to remove legacy files.
- `src/index.ts` first split: web stack CRUD/settings moved to `src/web-host.ts`, and provider payload redaction/capture moved to `src/payload-capture.ts`.
- Web editor host/runtime context flow is bound once when the server starts; host methods no longer pass their captured command context back into runtime callbacks.
- Regex MVP: top-level `regex.rules` validates JavaScript regex replacements, applies `history` and `compiled` outgoing transforms to prompt text before provider serialization, and can destructively rewrite finalized assistant messages with `effect: "finalize"`.
- Web editor servers are tracked per project cwd and rebound after extension reinitialization, preventing orphaned same-project servers after `/tree` or `/new`.
- Stack-level tool allow/deny policy filters Pi's active tool list while a stack is active and restores the previous active tools when the policy no longer applies.
- Stack-level skill allow/deny policy filters skills rendered by pi-forge `skills` slots, with validation warnings for `append`/`prepend` mode.
- Safe SillyTavern `promptOnly` regex scripts are converted into pi-forge outgoing `compiled` regex rules during import; display-only, mixed, JavaScript, DOM/browser, CSS/HTML decoration, invalid, and unsupported regex scripts remain report-only.

## Architecture simplification review

Review findings to keep in mind before expanding regex runtime behavior, adding richer policy controls, or growing the web UI:

- `src/web-editor/page.ts` is now the highest-friction file. It is still one embedded HTML/CSS/client-script string, which is workable for small edits but risky for richer regex/tool configuration screens. Split it along practical static boundaries later (`template`, `styles`, `client-script`) or introduce a tiny build step before the browser UI grows much further.
- `src/index.ts` is still broad, but stack file CRUD/web-editor host methods now live in `src/web-host.ts`, and payload capture/redaction lives in `src/payload-capture.ts`. Continue extracting command/event handlers as behavior grows.
- `src/sillytavern-importer.ts` has a large conversion/reporting pipeline. Split conversion, prompt-order selection, report building, regex reporting, and macro reporting into smaller pure helpers before expanding SillyTavern regex support.
- `src/compiler.ts` should keep slot collection and format rendering easy to reason about as more display-only or provider-payload transforms are considered.
- Prompt-stack storage now writes new stacks to `.pi/forge/prompt-stacks` and reads legacy `.pi/prompt-stacks` for compatibility. Keep future persistent feature state under `.pi/forge`.
- Keep `src/web-editor/server.ts` lightweight. A tiny route table would be enough if more APIs are added; a full web framework is not warranted yet.
- Test coverage is healthy, but `tests/index-command.test.ts` is becoming a large integration blob. Move the reusable mocked extension harness into `tests/helpers` when the next command/API feature lands.

## Priority 1: Web inspector

Core web observability is now in place. Slash-command preview and payload intercept remain useful fallbacks, while the browser handles the larger structured views.

Completed inspector work:

- Replace the web editor's plain preview pane with a full-screen structured preview inspector.
- Show system prompt and message layout as separate collapsible sections with char and approximate token counts.
- Avoid early truncation in the browser preview; large sections render collapsed instead.
- Add copy controls for full preview and individual sections.
- Add structured editing for stack `variables`.
- Capture provider payloads into the web editor with collapsible JSON, redaction preserved, char/token estimates, copy controls, and arm/clear actions.
- Add a structured editor for stack `context` options.
- Add a raw JSON stack view/apply recovery path for advanced stack-level fields.

Remaining inspector work:

- No immediate Priority 1 blockers. Keep new inspector work focused on real prompt-debugging pain points.

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
5. Macro session variables restore from branch-scoped persistence entries. - done
6. `/preset validate` shows diagnostics for the requested stack. - done
7. `/preset import-silly` writes the stack and report, then reloads stack state. - collision coverage done
8. `session_start` restores variables and active stack selection. - done
9. `turn_start` persists active stack selection only when needed. - done
10. `/preset ui` starts/stops the local editor and protects the API with a URL token. - smoke coverage done
11. Web editor save/create/delete operations reload current Pi stack state. - smoke coverage done
12. `/preset migrate-stacks` copies legacy stacks, handles collisions, supports dry-run/overwrite/delete-legacy, and refuses untrusted writes. - done

## Priority 3: Harden SillyTavern importer

The first importer command is implemented. Next work should make it safer and more ergonomic.

Completed hardening:

- Add collision handling when `.pi/forge/prompt-stacks/<id>.json`, legacy `.pi/prompt-stacks/<id>.json`, or `.pi/forge/import-reports/<id>.md` already exists. - done via confirmation/`--overwrite`
- Add tests around command-level import behavior, not only the pure importer. - initial coverage done
- Preview generated output without writing files via `--dry-run`. - done
- Detect `extensions.regex_scripts` during import and classify enabled scripts by `promptOnly`, `markdownOnly`, both, disabled, and script name. - done
- Show import reports in the web editor after SillyTavern imports. - done
- Treat supported `setvar`/`getvar`-style macros as handled in reports. - done
- Convert safe prompt-only regex scripts into pi-forge outgoing compiled regex rules. - done

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
- Keep the implemented opt-in transform subset narrow: deterministic regex replace before provider request or at assistant-message finalization, no DOM, no JavaScript eval, no UI rewriting, disabled by default, and visible in validation/report output.

TGbreak migration notes:

- Heavy ST variable macros (`setvar`/`getvar`) should keep driving pi-forge variable/macro polish before broader SillyTavern regex conversion.
- The preset has enough display-only regex that full ST regex compatibility would add complexity without useful TUI behavior.
- The importer should help users distinguish prompt semantics from ST presentation polish.

Regex runtime status and design:

- Implemented MVP: opt-in, deterministic JavaScript `RegExp` find/replace only; no embedded JavaScript, no DOM access, no CSS/HTML decoration runtime, and no SillyTavern UI panel behavior.
- Regex rules are ordered prompt-stack data under top-level `regex.schemaVersion` and `regex.rules`.
- Model rule execution by explicit stage instead of one global text pass:
  - `history` stage: implemented for messages selected by the `chat-history` slot. Supports role filters, `maxMessages`, and `maxChars`.
  - `compiled` stage: implemented for final system prompt and final message text before provider serialization. Supports `targets`, role filters for messages, `maxMessages`, and `maxChars`.
  - `payload` stage: not implemented; advanced provider-payload rewrite in `before_provider_request` should stay off by default and require explicit target paths because provider payload shapes differ.
  - `display` stage: not implemented; should transform web preview/display only and never change outgoing model input.
- Keep outgoing versus final-transcript versus display behavior explicit with `effect: "outgoing" | "finalize" | "display" | "both"`. Current runtime applies omitted/`"outgoing"` effects to model input and `"finalize"` effects to completed assistant messages. `"display"` and `"both"` still warn and are ignored. SillyTavern `promptOnly` maps to outgoing, `markdownOnly` maps to display, and mixed rules require review.
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
  "maxMessages": 20
}
```

- Validation compiles every regex, rejects unsupported flags, requires valid IDs, warns on display-only rules in TUI contexts, warns that finalize rules are destructive, and shows match/change counts in preview/runtime diagnostics.
- Implemented final-message cleanup uses `effect: "finalize"` at Pi `message_end`: users may see raw streamed text during generation, but the final stored/displayed transcript can be regex-cleaned afterward. This is not true display-only behavior because Pi stores the replacement and the original model output is lost from the transcript.
- Current hooks do not support reliable `displayStreaming` cleanup; hiding partial blocks such as `(OOC: ... )` while streaming would require a future transformable streaming-display hook and a stateful buffered filter.
- Next regex implementation order: revisit true display-only and provider-payload stages only after real usage shows the current outgoing/finalize subset is insufficient.

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

Structured prompt slots can render as XML-style output by default or compact plain text when `options.format` is `"plain"`. XML remains the default because it gives clear boundaries, names, attributes, and nesting for mixed prompt content.

Completed compact-format work:

- Added `format: "plain"` as an opt-in compact format, not a default replacement.
- Supported plain output for `tools`, `tool-guidelines`, `skills`, `project-context`, and `variables`.
- Kept `xml` default for backwards compatibility and for robustness around multiline values and prompt-injection-like content.
- Render plain text with concise headings and newline-separated bullets, for example:

```txt
Available tools:
- read: Read files from disk.
- bash: Run shell commands.

Available skills:
- review: Review code for correctness. Location: /skills/review/SKILL.md

Variables:
session:
- progress: step 2
```

Follow-ups:

- Compare real prompt previews across XML vs plain in daily use; keep XML as the recommended default unless plain output proves robust enough for specific stacks.
- Consider stack-level format defaults only if per-slot configuration becomes repetitive.

## Priority 6: Improve macro engine

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
  "includeLastUserMessage": false,
  "stripAssistantThinking": true
}
```

Next options:

```json
"options": {
  "includeLastUserMessage": false,
  "stripAssistantThinking": true,
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
16. branch-scoped macro session variable restore - done
17. command behavior for `/preset validate` - done
18. command behavior for `/preset import-silly` - collision coverage done
19. removed agent-memory tool surface stays absent - covered by command/web smoke tests
20. `/payload next save=<path>` redaction/save behavior - done
21. `/preset ui` API smoke test for serve/save/create/delete - done
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

1. Continue splitting `src/index.ts` by moving command and event handlers into focused modules.
2. Split the embedded web editor page along practical static boundaries before adding larger policy/regex screens.
3. Refactor the SillyTavern importer pipeline so regex and macro reporting can grow without bloating one function.
4. Add better chat-history controls (`maxMessages`, tool call/result filters, synthetic message filters).
5. Expand regex beyond outgoing/finalize transforms only after real usage justifies display or provider-payload stages.
