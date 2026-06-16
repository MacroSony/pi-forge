# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md)

Pi extension package for prompt stack and agent profile management. This first milestone implements file-backed prompt stacks.

## Package setup

This repository is a Pi package. Its package manifest exposes `./src/index.ts` as the extension entrypoint.

For local development in this checkout, `.pi/settings.json` points at the package root:

```json
{
  "packages": [".."]
}
```

After starting Pi in this directory, trust the project and use `/reload` if needed.

After publishing under your chosen npm package name, install it with:

```bash
pi install npm:@zihanw/pi-forge
```

## Prompt stacks

Prompt stacks live in:

```txt
.pi/prompt-stacks/*.json
```

Activation rules:

1. A restored `/preset use <id>` selection is used first when that stack still exists and has no validation errors.
2. A restored `/preset use none` selection disables prompt stack replacement.
3. `.pi/prompt-stacks/default.json` auto-activates when present unless the stack sets `"autoActivate": false`.
4. Otherwise, the first stack with `"autoActivate": true` is used.
5. `/preset use <id>` switches stacks for the session and persists that choice.
6. `/preset use none` disables prompt stack replacement and persists that choice.

When a stack is active, pi-forge replaces Pi's default system prompt by default and rebuilds the first provider request for each user message around a movable `chat-history` slot. Tool-result follow-up turns use Pi's natural context so post-history instructions are not repeatedly re-appended after every tool call.

## Commands

```txt
/preset list
/preset status
/preset use <id|none>
/preset preview [id]
/preset validate [id]
/preset diagnostics
/preset reload
/preset vars [set <name> <value>|get <name>|clear [name]]
/state [list|status|set <name> <value>|get <name>|clear [name]]
/preset import-silly <path> [character_id] [--dry-run] [--overwrite]
/intercept
/payload next [save=<path>]
```

## SillyTavern preset import

Import a SillyTavern preset JSON into `.pi/prompt-stacks/<id>.json` and write a migration report to `.pi/forge/import-reports/<id>.md`:

```txt
/preset import-silly <path> [character_id] [--dry-run] [--overwrite]
```

By default, import refuses to overwrite existing generated stack/report files unless the UI confirmation is accepted. Use `--dry-run` to preview generated JSON and the report without writing files, or `--overwrite` to allow replacement.

If a preset contains multiple `prompt_order` entries, pass the desired `character_id`. Imported stacks are created with `autoActivate: false`; activate one with `/preset use <id>` after reviewing the report.

## Payload inspection

`/intercept` displays the next provider payload before it is sent. `/payload next [save=<path>]` does the same and can also save the redacted/truncated payload to a file. The viewer/notification includes character and approximate token counts. Example:

```txt
/payload next save=.pi/forge/payloads/last.json
```

## Agent tools

### forge_state_set

Batch-updates persistent prompt state. Only state names starting with `agent.` can be written by the agent; user and stack state are read-only to the agent. Useful for cross-turn state tracking in roleplay (character mood, story progress) or coding (task checkpoints, discovered facts).

When the `variables` slot is active in a prompt stack, the agent sees rendered prompt state and can update `agent.*` state with `forge_state_set`. Without the slot, state still works for macro substitution but the agent won't have a structured view of the state.

`forge_set_var` remains as a compatibility alias for setting one string value. Prefer `forge_state_set` for new stacks.

## Stack format

Minimal example:

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.prompt-stack",
  "id": "default",
  "autoActivate": true,
  "mode": "replace",
  "items": [
    {
      "kind": "block",
      "id": "main-role",
      "enabled": true,
      "role": "system",
      "content": "You are a precise coding assistant."
    },
    {
      "kind": "slot",
      "id": "tools",
      "enabled": true,
      "role": "system",
      "slot": "tools"
    },
    {
      "kind": "block",
      "id": "history-open",
      "enabled": true,
      "role": "user",
      "content": "<conversation_context>"
    },
    {
      "kind": "slot",
      "id": "chat-history",
      "enabled": true,
      "slot": "chat-history"
    },
    {
      "kind": "block",
      "id": "history-close",
      "enabled": true,
      "role": "user",
      "content": "</conversation_context>"
    }
  ]
}
```

## Items

### Blocks

Static text:

```json
{
  "kind": "block",
  "id": "post-history-nudge",
  "enabled": true,
  "role": "user",
  "content": "Reason carefully about the latest request before answering."
}
```

### Slots

Live Pi runtime content:

```json
{
  "kind": "slot",
  "id": "skills",
  "enabled": true,
  "role": "system",
  "slot": "skills"
}
```

Supported slots:

- `chat-history` — current Pi conversation context from the session
- `tools` — active tool names and prompt snippets
- `tool-guidelines` — active tool guidance
- `skills` — loaded Pi skills
- `project-context` — project instructions/context files
- `append-system-prompt` — user-provided append system prompt text
- `variables` — static/session/turn prompt state rendered as structured XML or JSON
- `date`
- `cwd`
- `date-cwd`
- `active-model`
- `pi-docs`

### Variables / State Slot

Renders prompt state as structured XML by default:

```xml
<prompt_state>
  <static>
    <var name="char" type="string">Agent</var>
  </static>
  <session>
    <var name="agent.mood" type="string">happy</var>
    <var name="agent.progress" type="string">step 3</var>
  </session>
  <turn>
    <var name="recent" type="string">just happened</var>
  </turn>
</prompt_state>
```

Options:

```json
{
  "includeStatic": true,
  "includeSession": true,
  "includeTurn": true,
  "includeScopes": ["session"],
  "includeNamespaces": ["user.*", "agent.*"],
  "excludeNamespaces": ["agent.scratch.*"],
  "includeMetadata": true,
  "format": "xml",
  "maxValueChars": 1200
}
```

`includeScopes` overrides the older `includeStatic` / `includeSession` / `includeTurn` booleans when present. Namespace filters accept exact names or wildcard prefixes such as `agent.*`.

Use this slot to give the agent visibility into mutable state that it can also update via `forge_state_set`. Set `"format": "json"` to render the same state payload as escaped JSON inside `<prompt_state>`.

## Roles

- `system` items are compiled into the replacement system prompt.
- `user` items are inserted as ephemeral user messages.
- `assistant` items are inserted as ephemeral assistant messages.
- `custom` items are inserted as hidden Pi custom messages and converted to user context by Pi.

`chat-history` expands to the live conversation at its position. By default, only the first enabled `chat-history` slot is expanded.

To omit the latest user message from a chat history slot, use:

```json
{
  "kind": "slot",
  "id": "chat-history",
  "enabled": true,
  "slot": "chat-history",
  "options": {
    "includeLastUserMessage": false
  }
}
```

This is useful for SillyTavern-style stacks that re-insert `{{lastUserMessage}}` later as a post-history instruction.

To intentionally duplicate history:

```json
{
  "context": {
    "allowDuplicateChatHistory": true
  }
}
```

## Macros

Supported macros in block content:

- `{{cwd}}`
- `{{date}}`
- `{{time}}`
- `{{lastUserMessage}}`
- `{{selectedTools}}` / `{{tools}}`
- `{{activeModel}}`
- custom variables from the stack `variables` object, e.g. `{{char}}`

### Variables / Prompt State

Static variables come from the stack file:

```json
"variables": {
  "char": "Assistant",
  "user": "USER"
}
```

Typed state definitions can also be declared in the stack:

```json
"state": {
  "schemaVersion": 1,
  "definitions": {
    "agent.progress": {
      "type": "string",
      "scope": "session",
      "description": "Concise summary of current task progress",
      "agentWritable": true
    },
    "agent.openQuestions": {
      "type": "string[]",
      "scope": "session",
      "description": "Questions that may need user input",
      "agentWritable": true
    }
  }
}
```

Supported type strings are intentionally small and TypeScript-like: `string`, `number`, `boolean`, `null`, `object`, `array`, `string[]`, `number[]`, `boolean[]`, `unknown`, and unions like `string | null`.

Definition defaults are shown by the `variables` slot when their scope is included. Defaults do not initialize persisted session state, so `/state get <name>` can still show `(not set)` until the user, agent, or a macro writes that value.

Users can set typed JSON-compatible session state with:

```txt
/state set user.preference "concise answers"
/state set user.maxExamples 2
/state set user.flags ["brief","technical"]
```

`/preset vars set <name> <value>` remains as a legacy string-only command.

Mutable turn variables are cleared for each user message:

```txt
{{setvar::name::value}}
{{setturnvar::name::value}}
{{getvar::name}}
{{getturnvar::name}}
{{var::name}}
{{clearvar::name}}
```

Mutable session state persists in the Pi session as extension state and is restored from the current session tree branch. When you navigate to an earlier message with Pi's tree controls, pi-forge restores the latest state snapshot reachable from that branch, so state rolls back with conversation history instead of leaking future branch state.

```txt
{{setsessionvar::name::value}}
{{setvar::session::name::value}}
{{getsessionvar::name}}
{{getvar::name}}
{{clearsessionvar::name}}
{{clearvar::session::name}}
```

Lookup order for `{{getvar::name}}`, `{{var::name}}`, and bare `{{name}}` is:

1. turn variables
2. session state
3. static stack variables

`setvar` macros output empty text. Non-string state values are JSON-stringified when substituted by macros. Unknown macros warn by default and are kept literally.
