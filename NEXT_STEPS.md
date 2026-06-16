# pi-forge Next Steps

## Current status

Implemented and working:

- Pi package setup with `src/index.ts` as the extension entrypoint.
- File-backed prompt stacks under `.pi/prompt-stacks/*.json`.
- `default.json` auto-activation unless `autoActivate` is `false`, with persisted `/preset use none` opt-out.
- Prompt stack system prompt replacement.
- Movable `chat-history` slot.
- Context rewrite limited to the first provider request of each user-submitted turn, avoiding repeated COT/post-history injection after tool calls.
- Runtime slots for tools, tool guidelines, skills, project context, date/cwd, active model, append-system-prompt, and Pi docs guidance.
- Basic macro expansion and turn/session/static prompt state.
- `/preset` commands for list/use/preview/validate/diagnostics/reload/vars, plus `/state` commands for typed session state.
- `/preset import-silly <file> [character_id] [--dry-run] [--overwrite]` command that writes prompt stacks and import reports.
- `/intercept` and `/payload next [save=<path>]` commands to display/save the next provider payload with basic redaction/truncation.
- Local converted SillyTavern writer preset in `.pi/prompt-stacks/default.json`.
- Guardrails for bad stacks: stacks with error diagnostics are skipped during default activation, and empty replacement system prompts preserve Pi's base prompt.
- Active prompt stack status in the footer.
- Node built-in tests covering loader selection, system prompt compilation, chat-history placement, macros, diagnostics, prompt state slot rendering, and SillyTavern import behavior.
- `variables` slot that renders static/session/turn prompt state as valid XML or JSON, with scope/namespace filters and optional stack metadata.
- Branch-aware prompt state restoration during session tree navigation.
- `/state set <name> <json-or-text-value>` command for typed JSON-compatible session state, with `/preset vars` kept as legacy string commands.
- `forge_state_set` tool that lets the agent batch update `agent.*`-prefixed session state for cross-turn tracking, with `forge_set_var` kept as a compatibility alias.
- `/preset ui` lightweight localhost web editor for prompt-stack editing, validation, preview, import/export, fork, delete, activation, and disable flows.

## Priority 1: Command and lifecycle test coverage

Pure compiler/loader/importer tests are in place, plus an initial mocked command/event harness for `src/index.ts`. The next reliability gap is broadening that harness across more lifecycle cases.

Extend the test harness that can instantiate the extension with mocked:

- `ExtensionAPI` command/tool/event registration
- `ExtensionContext` cwd, UI, trust, and session manager
- `appendEntry`, `setStatus`, `notify`, and editor calls

High-value command/event cases:

1. `/preset` second-level completions keep the subcommand in the inserted value, e.g. `use default`. - done
2. `/preset use <id>` persists the selected stack and updates footer status. - done
3. `/preset use none` persists the disabled selection and clears footer status. - done
4. `/preset reload` preserves an explicit disabled selection instead of reactivating `default.json`. - done
5. `/state set/get/clear` and legacy `/preset vars set/get/clear` update session state and persistence entries. - partial coverage done; add get/clear cases
6. `/preset validate` shows diagnostics for the requested stack. - done
7. `/preset import-silly` writes the stack and report, then reloads stack state. - collision coverage done
8. `session_start` restores variables and active stack selection. - done
9. `turn_start` persists active stack selection only when needed.
10. `/preset ui` starts/stops the local editor and protects the API with a URL token. - smoke coverage done
11. Web editor save/create/delete operations reload current Pi stack state. - smoke coverage done

## Priority 2: Harden SillyTavern importer

The first importer command is implemented. Next work should make it safer and more ergonomic.

Remaining immediate fixes:

- Add collision handling when `.pi/prompt-stacks/<id>.json` or `.pi/forge/import-reports/<id>.md` already exists. - done via confirmation/`--overwrite`
- Add tests around command-level import behavior, not only the pure importer. - initial coverage done

Importer improvements:

- Choose a prompt order interactively when multiple `prompt_order` entries exist and no `character_id` was supplied.
- Preserve more SillyTavern metadata in `import.source`.
- Expand the unsupported macro report with suggested pi-forge replacements where clear.
- Add fixtures from real presets to catch field-shape drift.
- Consider a dry-run mode that only shows the generated stack/report. - done

## Priority 3: Web editor polish

The lightweight web editor is implemented and usable. Future polish should stay focused rather than turning it into a separate full application too early.

High-value follow-ups:

- Unsaved-change indicator tied to the selected stack and item.
- Copy-to-clipboard export fallback in addition to JSON download.
- Inline validation badges beside specific stack items.
- More structured editors for stack `variables`, `state.definitions`, and `context` options.
- Better import flow for pasted JSON, not only file selection.
- Browser-level smoke screenshots if a browser test dependency is added later.

Keep slash-command fallbacks for terminal-first workflows.

## Priority 4: Prompt state lifecycle metadata

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

## Priority 5: Improve macro engine

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

## Priority 6: Better chat-history controls

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

## Priority 7: Prompt-stack lifecycle controls

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

## Priority 8: Tests

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
16. command behavior for `/state` and `/preset vars` - partial validation coverage done
17. command behavior for `/preset validate` - done
18. command behavior for `/preset import-silly` - collision coverage done
19. command/tool lifecycle tests for `forge_state_set` - validation coverage done
20. `/payload next save=<path>` redaction/save behavior - done
21. `/preset ui` API smoke test for serve/save/create/delete - done

## Priority 9: Payload/debug tools

Improve `/intercept`:

- optional command name `/payload next` - done
- option to save payload to file - done:

```txt
/payload next save=.pi/forge/payloads/last.json
```

- redact API keys and large binary/image content - basic redaction/truncation done
- show token-ish size estimates if possible - basic char/approx-token display done
- add broader payload-shape tests for provider-specific payloads

## Priority 10: Agent profiles later

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

1. Add small web-editor polish: unsaved-change indicator, copy export fallback, and inline item validation badges.
2. Add broader provider payload redaction tests and any remaining untrusted-project write refusals.
3. Begin macro parser replacement for nested macros and safe transforms.
4. Add richer chat-history controls (`maxMessages`, `maxApproxChars`, tool-call/result filters).
5. Consider explicit global/non-branch state scope if users need state that intentionally survives tree rollback.
