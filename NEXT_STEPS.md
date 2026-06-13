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
- Basic macro expansion and turn/session/static variables.
- `/preset` commands for list/use/preview/validate/reload/vars.
- `/preset import-silly <file> [character_id]` command that writes prompt stacks and import reports.
- `/intercept` command to display the next provider payload.
- Local converted SillyTavern writer preset in `.pi/prompt-stacks/default.json`.
- Guardrails for bad stacks: stacks with error diagnostics are skipped during default activation, and empty replacement system prompts preserve Pi's base prompt.
- Active prompt stack status in the footer.
- Node built-in tests covering loader selection, system prompt compilation, chat-history placement, macros, diagnostics, variables slot rendering, and SillyTavern import behavior.
- `variables` slot that renders static/session/turn variables as structured XML, positionable in the prompt layout.
- `/preset vars set <name> <value>` and `/preset vars get <name>` commands.
- `forge_set_var` tool that lets the agent set `agent.*`-prefixed session variables for cross-turn state tracking.

## Priority 1: Command and lifecycle test coverage

Pure compiler/loader/importer tests are in place. The next reliability gap is the extension command/event surface in `src/index.ts`.

Add a small test harness that can instantiate the extension with mocked:

- `ExtensionAPI` command/tool/event registration
- `ExtensionContext` cwd, UI, trust, and session manager
- `appendEntry`, `setStatus`, `notify`, and editor calls

High-value command/event cases:

1. `/preset` second-level completions keep the subcommand in the inserted value, e.g. `use default`.
2. `/preset use <id>` persists the selected stack and updates footer status.
3. `/preset use none` persists the disabled selection and clears footer status.
4. `/preset reload` preserves an explicit disabled selection instead of reactivating `default.json`.
5. `/preset vars set/get/clear` updates session variables and persistence entries.
6. `/preset validate` shows diagnostics for the requested stack.
7. `/preset import-silly` writes the stack and report, then reloads stack state.
8. `session_start` restores variables and active stack selection.
9. `turn_start` persists active stack selection only when needed.

## Priority 2: Harden SillyTavern importer

The first importer command is implemented. Next work should make it safer and more ergonomic.

Remaining immediate fixes:

- Add collision handling when `.pi/prompt-stacks/<id>.json` or `.pi/forge/import-reports/<id>.md` already exists.
- Add tests around command-level import behavior, not only the pure importer.

Importer improvements:

- Choose a prompt order interactively when multiple `prompt_order` entries exist and no `character_id` was supplied.
- Preserve more SillyTavern metadata in `import.source`.
- Expand the unsupported macro report with suggested pi-forge replacements where clear.
- Add fixtures from real presets to catch field-shape drift.
- Consider a dry-run mode that only shows the generated stack/report.

## Priority 3: Variable metadata

### Add variable metadata later

Current variables are strings. Later format could support:

```json
{
  "value": "...",
  "scope": "session",
  "description": "What this variable means",
  "updatedAt": "..."
}
```

Keep the current string map for now; migrate only if useful.

## Priority 4: Improve macro engine

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

## Priority 5: Better chat-history controls

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

## Priority 6: Prompt-stack lifecycle controls

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

## Priority 7: Tests

Pure compiler/loader/importer tests exist. Keep extending them before the command surface grows much more.

Suggested setup:

- keep Node's built-in test runner for now
- add a narrow extension harness before command tests
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
15. context rewrite once per user turn behavior
16. command behavior for `/preset vars`
17. command behavior for `/preset validate`
18. command behavior for `/preset import-silly`

## Priority 8: Payload/debug tools

Improve `/intercept`:

- optional command name `/payload next`
- option to save payload to file:

```txt
/payload next save=.pi/forge/payloads/last.json
```

- redact API keys and large binary/image content
- show token-ish size estimates if possible

## Priority 9: Agent profiles later

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

1. Add a lightweight extension harness for `/preset` command and session event tests.
2. Cover `/preset use`, `/preset reload`, `/preset vars`, `/preset validate`, and `/preset import-silly`.
3. Add importer collision handling so generated files are not silently overwritten.
4. Revisit the local writer preset and add a compact `<turn_state>` block using the `variables` slot.
