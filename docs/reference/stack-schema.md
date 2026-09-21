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

Valid roles are `system`, `user`, `assistant`, and `custom`. Custom-role content participates in compilation and reaches the provider as a `user` message: Pi converts `custom` messages to `user` when it builds the wire request, so the wire carries no distinct custom role. Custom-role items never merge with other items (see [Context options](#context-options)).

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

Item position only matters within each channel: all `system` items join the system prompt in their relative order, and all non-system items become messages in their relative order. A `system` item placed after non-system items therefore has no effect on placement and produces a validation warning; roles are never silently converted. Use a `user` item for in-conversation injection.

## Modes

- `replace` replaces Pi's base system prompt; empty output falls back to the base.
- `append` places stack system text after Pi's base.
- `prepend` places stack system text before Pi's base.

## Context options

```json
{
  "context": {
    "allowDuplicateChatHistory": false,
    "mergeConsecutiveRoles": true,
    "mergeSeparator": "\n\n"
  }
}
```

- `allowDuplicateChatHistory` permits multiple enabled chat-history slots; otherwise only the first expands.
- `mergeConsecutiveRoles` (default `false`) merges runs of consecutive stack items that share the same declared role into a single message, joined by `mergeSeparator` (default a blank line). Only stack-authored `user`/`assistant` items merge: chat-history output (including the implicit history tail) and `custom` items are hard boundaries, and merging runs after compiled-stage regex so regex semantics are unchanged. The web editor preview reflects the merged layout.
- `mergeSeparator` is inserted verbatim between merged texts and may be an empty string.

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
    "allow": ["read", "grep", "find", "ls"],
    "initial": ["read", "grep"]
  },
  "skills": {
    "deny": ["browser-danger"]
  }
}
```

Each resource may have a non-empty `allow` list or `deny` list, never both. A selective tool `allow` list chooses matching tools from Pi's complete registered tool catalog, so it can activate a registered tool that was inactive when the stack was selected. A tool `deny` list removes matching tools from the active baseline. `allow: ["*"]` remains unrestricted and does not activate every registered tool. Unmatched allow patterns are surfaced during validation/preflight.

### Initial active tools (`tools.initial`)

The `tools` policy optionally accepts an `initial` list:

- **Concrete names only:** `tools.initial` must be an array of valid, concrete tool name strings (up to 128 characters each). Wildcards (`*`, `?`) are rejected; duplicate names produce a warning and are deduplicated on parsing.
- **Omission vs. empty array:**
  - When `initial` is omitted, pi-forge preserves legacy behavior: a selective allow chooses matching registered tools; unrestricted/deny policies retain or filter the restorable session baseline, not the entire catalog.
  - When `initial: []` is set explicitly, zero tools are active initially.
- **Ceiling enforcement:** The `allow`/`deny` ceiling remains authoritative and exclusive. Initial tools must fall within permitted bounds: listing a tool that is blocked by allow/deny produces a validation error.
- **Extension and mod tools:** Dynamically registered extension tools are allowed by default if they satisfy the allow/deny policy, but when `initial` is specified, they remain registered and inactive until explicitly added by `initial`, by an active instruction mode, or through runtime tooling.
- **Preset baseline behavior:** Configured initial tools serve as the active base for as long as the preset remains active—not a one-time reset per turn. Calling `/system-update off` or `/system-update reset` returns the session to the preset defaults (plus any remaining active modes). Disabling restores the reconciled session baseline; switching recomputes under the new Preset and remaining unbound modes.
- **Compatibility:** Stacks declaring `tools.initial` require updated Forge. Older Forge versions may ignore `tools.initial` and activate all allowed tools, so the field is not downgrade-compatible. Development continues on the 0.5.4 tree with a release version bump decision pending (0.5.5 or maybe 0.6); host requirement remains Pi `>=0.87.0 <0.88.0`.

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

### Frequency

Outgoing rules default to `"frequency": "turn"`: they run during the full compilation on the first provider request of each user turn. Tool-result follow-up requests receive Pi's natural context, so a turn-scoped rule never sees tool output until the next user turn.

Set `"frequency": "request"` to also run an outgoing message rule on every tool-result follow-up request, applied to Pi's full natural context:

```json
{
  "id": "redact-api-keys",
  "stage": "history",
  "effect": "outgoing",
  "frequency": "request",
  "pattern": "\\b(sk-[A-Za-z0-9_-]{12,})\\b",
  "flags": "g",
  "replace": "[REDACTED]"
}
```

Each provider request is rebuilt from the stored transcript, so re-applying a rule to older messages is wire-consistent and never doubles. History-stage rules and compiled-stage rules with a `messages` target both participate; on follow-ups there is no stack layout rewrite, so both stages collapse onto the natural context (history-stage rules run first). `frequency` has no effect on `finalize` rules or system-only targets, and validation says so. It is wire-only scrubbing: the stored transcript keeps the original text.

Regex rules only cover the text targets and patterns you declare. They cannot recognize every credential format and do not scan system text, tool definitions, or arbitrary request metadata unless those targets are explicitly supported and selected. Treat them as deterministic text transforms, not as a security boundary.

To scrub the same recognized shapes from stored assistant/tool-result text, pair a request-frequency outgoing rule with a `finalize` rule:

```json
{
  "id": "redact-api-keys-finalize",
  "stage": "compiled",
  "effect": "finalize",
  "targets": ["messages"],
  "roles": ["assistant", "toolResult"],
  "pattern": "\\b(sk-[A-Za-z0-9_-]{12,})\\b",
  "flags": "g",
  "replace": "[REDACTED]"
}
```

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

`finalize` applies to assistant messages by default, and additionally to stored tool-result messages when a rule's `roles` explicitly includes `"toolResult"` — useful for scrubbing secrets out of stored tool output before the follow-up request replays it. Rules without `roles` keep assistant-only behavior, user messages are never finalized, and unsupported roles warn.
