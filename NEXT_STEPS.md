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
- `/intercept` command to display the next provider payload.
- Local converted SillyTavern writer preset in `.pi/prompt-stacks/default.json`.
- Guardrails for bad stacks: stacks with error diagnostics are skipped during default activation, and empty replacement system prompts preserve Pi's base prompt.
- Node built-in tests covering loader selection, system prompt compilation, chat-history placement, macros, diagnostics, and variables slot rendering.
- `variables` slot that renders static/session/turn variables as structured XML, positionable in the prompt layout.
- `/preset vars set <name> <value>` and `/preset vars get <name>` commands.
- `forge_set_var` tool that lets the agent set `agent.*`-prefixed session variables for cross-turn state tracking.

## Priority 1 (partial): Variable metadata

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

## Priority 2: Improve macro engine

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

## Priority 3: Better chat-history controls

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

## Priority 4: Prompt-stack lifecycle controls

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

## Priority 5: SillyTavern importer

Current conversion was manual/scripted. Implement a command:

```txt
/preset import-silly .pi/MySillyTavernPreset.json
```

Importer requirements:

- choose prompt order interactively when multiple `prompt_order` entries exist
- generate simple numeric IDs by default
- preserve original SillyTavern identifiers in `source.previousId`
- map `chatHistory` to `chat-history`
- map common boilerplate markers to disabled slots or removed import report entries
- set `chat-history.options.includeLastUserMessage=false` when preset already uses `{{lastUserMessage}}` later
- produce an import report

Output:

```txt
.pi/prompt-stacks/<name>.json
.pi/forge/import-reports/<name>.md
```

## Priority 6: Tests

Initial pure compiler/loader tests exist. Keep extending them before the system grows much more.

Suggested setup:

- use `vitest` or Node's built-in test runner
- test pure compiler functions first

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
12. context rewrite once per user turn behavior
13. command behavior for `/preset vars`
14. command behavior for `/preset validate`

## Priority 7: Payload/debug tools

Improve `/intercept`:

- optional command name `/payload next`
- option to save payload to file:

```txt
/payload next save=.pi/forge/payloads/last.json
```

- redact API keys and large binary/image content
- show token-ish size estimates if possible

## Priority 8: Agent profiles later

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

1. Add the `variables` slot.
2. Add `/preset vars set/get/clear`.
3. Add tests around context rewrite lifecycle and command handlers.
4. Implement a proper SillyTavern importer command.
5. Then revisit the local writer preset and add a compact `<turn_state>` block using the new variables slot.
