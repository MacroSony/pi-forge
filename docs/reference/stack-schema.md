# Prompt-stack schema and policy

[Documentation](../README.md)

Use [the default Pi mirror](../../examples/default-prompt-stack.json) as the complete baseline. This page describes behavior-significant fields; `/preset validate` and the web editor are the final validators.

## Top-level shape

A stack has a unique `id`, schema/type identity, optional display metadata and auto-activation, a system `mode`, ordered `items`, and optional defaults, parameters (schema v2) or legacy variables, context, resource policy, regex, and source metadata.

Unknown/advanced metadata is preserved by raw editing, but behavior-changing fields are shape-checked and invalid values are not silently normalized into active behavior.

## Items

Block:

```json
{
  "kind": "block",
  "id": "unique-id",
  "name": "Readable label",
  "enabled": true,
  "role": "system",
  "content": "Your text here. Use {{ parameters.role }} / {{ runtime.lastUserMessage }} for dynamic content."
}
```

Valid roles are `system`, `user`, `assistant`, and `custom`. Custom-role content participates in compilation but does not produce a provider message directly.

Slot:

```json
{
  "kind": "slot",
  "id": "history",
  "name": "Chat history",
  "enabled": true,
  "role": "user",
  "slot": "chat-history",
  "options": {
    "includeLastUserMessage": false
  }
}
```

Item IDs must be unique. Unsupported slots and missing required custom registrations produce diagnostics. Multiple chat-history slots warn unless explicitly permitted.

## Modes

- `replace` replaces Pi's base system prompt; empty output falls back to the base.
- `append` places stack system text after Pi's base.
- `prepend` places stack system text before Pi's base.

## Chat-history options

```json
{
  "includeLastUserMessage": false,
  "stripAssistantThinking": true,
  "includeSummaries": true,
  "toolMode": "keep",
  "roles": ["user", "assistant"],
  "maxMessages": 40,
  "maxChars": 20000
}
```

- Set `includeLastUserMessage: false` when a later block reinserts `{{ runtime.lastUserMessage }}`.
- `stripAssistantThinking` removes prior thinking blocks but preserves visible assistant text, tool calls, and results. It does not change the live loop or stored transcript.
- `includeSummaries: false` excludes branch/compaction summaries.
- `roles` keeps only selected roles.
- `toolMode: "drop"` removes prior tool traffic.
- `maxMessages` and `maxChars` keep recent history within limits.

When filtering would separate a tool call from its result, pi-forge removes dangling entries rather than sending inconsistent provider history.

## Structured slots

`tools`, `tool-guidelines`, `skills`, and `project-context` support `"format": "plain"`; the default is XML-style structure. Date slots support `includeTime: true`.

See [macros and slots](macros-and-slots.md) for names and options.

## Tool and skill policy

Patterns are exact by default and support `*` wildcards:

```json
{
  "tools": {
    "allow": ["read", "grep", "find", "ls"]
  },
  "skills": {
    "deny": ["browser-danger"]
  }
}
```

Each resource may have a non-empty `allow` list or `deny` list, never both. Tool allow keeps matching active tools; deny removes matching active tools. Unmatched allow patterns are surfaced during validation/preflight.

Tool policy changes Pi's active tool list, is reasserted before input/turns, and has a tool-call guard. It preserves external additions in the restorable baseline and restores that baseline when policy no longer applies or the extension shuts down.

Skill policy filters only pi-forge-rendered skill slots. It does not disable explicit invocation and is not a capability boundary. `append`/`prepend` may retain Pi's unfiltered base skill text, so validation warns.

## Parameters and schema v2

Schema v2 stacks store immutable static values in `parameters` (JSON-compatible):

```json
{
  "schemaVersion": 2,
  "parameters": {
    "char": "Konata",
    "user": "User",
    "style": { "tone": "concise" }
  }
}
```

Parameters resolve through `{{ parameters.<name> }}` templates and are available
to trusted custom macros/slots. Unversioned and v1 stacks continue to read the
legacy `variables` field (string values) and support bare `{{name}}` fallback.
A stack must not mix `parameters` and `variables` across schema versions. See
[macro reference](macros-and-slots.md).

## Regex transforms

Regex rules are ordered, deterministic JavaScript `RegExp` replacements. There is no embedded JavaScript, DOM, browser, CSS, or HTML-decoration runtime.

```json
{
  "regex": {
    "schemaVersion": 1,
    "rules": [
      {
        "id": "trim-ooc",
        "enabled": true,
        "stage": "history",
        "effect": "outgoing",
        "pattern": "\\(OOC:[^)]+\\)",
        "flags": "gi",
        "replace": "",
        "roles": ["assistant"],
        "maxMessages": 20
      }
    ]
  }
}
```

`stage: "history"` changes text inserted by `chat-history`. `stage: "compiled"` changes the final compiled system prompt and/or messages through optional `targets: ["system", "messages"]`.

Message rules may filter by `roles`, `maxMessages`, `maxChars`, `minDepth`, and `maxDepth` (depth 0 is latest). `trimStrings` removes literal strings from expanded matches/captures. Supported flags are `g`, `i`, `m`, `s`, and `u`. Replacements use JavaScript `$&`/`$1`; `$0` is accepted as a full-match alias and `$$` yields a literal dollar sign.

Outgoing rules change future model input. To destructively change a completed assistant transcript message:

```json
{
  "id": "finalize-ooc",
  "enabled": true,
  "stage": "compiled",
  "effect": "finalize",
  "targets": ["messages"],
  "roles": ["assistant"],
  "pattern": "\\s*\\(OOC:[^)]+\\)",
  "flags": "gi",
  "replace": ""
}
```

> `finalize` runs at `message_end`, after raw output may have streamed. It replaces the stored assistant message, so the original output is not preserved.

`effect: "outgoing"` and `"finalize"` are the only valid effects; `"display"` and `"both"` are rejected during validation. Runtime diagnostics report match and changed-segment counts.
