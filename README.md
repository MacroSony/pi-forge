# pi-forge

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
/preset use <id|none>
/preset preview [id]
/preset validate [id]
/preset reload
/preset vars [clear [name]]
```

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
- `date`
- `cwd`
- `date-cwd`
- `active-model`
- `pi-docs`

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
- `{{lastUserMessage}}`
- `{{selectedTools}}` / `{{tools}}`
- `{{activeModel}}`
- custom variables from the stack `variables` object, e.g. `{{char}}`

### Variables

Static variables come from the stack file:

```json
"variables": {
  "char": "泉此方",
  "user": "USER"
}
```

Mutable turn variables are cleared for each user message:

```txt
{{setvar::name::value}}
{{setturnvar::name::value}}
{{getvar::name}}
{{getturnvar::name}}
{{var::name}}
{{clearvar::name}}
```

Mutable session variables persist in the Pi session as extension state:

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
2. session variables
3. static stack variables

`setvar` macros output empty text. Unknown macros warn by default and are kept literally.
