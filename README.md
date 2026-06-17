# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md)

**pi-forge** lets you customize how Pi thinks and behaves. It gives you prompt stacks — JSON files that can replace, append to, or prepend Pi's default system prompt while controlling the AI's personality, visible tools, conversation history layout, and cross-turn state.

Think of it as a character sheet for your AI agent.

## What you can do with it

- **Give Pi a personality** — turn it into a creative writer, a roleplay partner, a strict code reviewer, or anything in between.
- **Switch contexts instantly** — one command to swap between "coding mode", "writing mode", and "translation mode".
- **Control what the AI sees** — choose which tools, skills, and project context appear in each prompt.
- **Remember things across turns** — let the agent track progress, store notes, and recall user preferences throughout a session.
- **Import SillyTavern presets** — bring your existing ST character presets into Pi with one command.
- **Debug your prompts** — intercept and inspect exactly what gets sent to the model.

## Quick start

### Install

```bash
pi install npm:@zihanw/pi-forge
```

### Your first prompt stack

Create `.pi/prompt-stacks/default.json`:

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
      "id": "role",
      "name": "Main Role",
      "enabled": true,
      "role": "system",
      "content": "You are a friendly and concise coding assistant. Prefer short answers with code examples."
    },
    {
      "kind": "slot",
      "id": "tools",
      "name": "Available Tools",
      "enabled": true,
      "role": "system",
      "slot": "tools"
    },
    {
      "kind": "slot",
      "id": "chat-history",
      "name": "Chat History",
      "enabled": true,
      "slot": "chat-history"
    }
  ]
}
```

That's it. Restart Pi or run `/preset reload`. If no stack is already selected, `default.json` auto-activates. If you previously chose another stack or `/preset use none`, run `/preset use default`.

### Visual editor

Prefer clicking over typing JSON? pi-forge has a built-in web editor:

```
/preset ui
```

Drag, drop, edit, validate, inspect full previews, manage variables/state, import, export, fork, and delete stacks — all in your browser.

Import accepts native pi-forge stack JSON and SillyTavern preset JSON. SillyTavern presets are converted to prompt stacks automatically; if a preset contains multiple `character_id` configs, the editor asks which one to use.

The editor runs on `127.0.0.1:41738` by default with a session token. Writes require a trusted project and stay inside `.pi/prompt-stacks`; successful save, import, fork, and delete actions reload into the current Pi session. Use `/preset ui restart` or `/preset ui stop` when needed.

To use a different fixed port, create `.pi/forge/config.json`:

```json
{
  "webEditor": {
    "port": 41738
  }
}
```

## Use cases

### 🎭 Roleplay & creative writing

Turn Pi into a character. Define their personality in the system prompt, inject writing style rules as user messages, and use `{{lastUserMessage}}` to re-insert the user's input after the conversation history.

Useful pattern:
- Put long-term character rules in a `system` block.
- Keep Pi runtime context (tools, skills, project) in `user` slots.
- Set the `chat-history` slot to skip the latest user message.
- Add a final `user` block with `{{lastUserMessage}}`.

This keeps the latest request clear and avoids duplicating it.

For a copyable starter stack, see [examples/default-prompt-stack.json](examples/default-prompt-stack.json).

### 🧑‍💻 Focused code review

Create a `reviewer.json` stack with a strict review block: "prioritize correctness, regressions, security, and missing tests." Keep the `tools`, `project-context`, `variables`, and `chat-history` slots enabled so Pi can still inspect the repo and remember review state.

Use `mode: "append"` if you want to keep Pi's normal coding behavior and only add the sharper review lens.

### 🌐 Translation mode

Create a small `translator.json` stack with one system block for tone and target language, then keep `chat-history` and `{{lastUserMessage}}` in the layout. This works well for switching between bilingual editing, literal translation, and localization review without changing your default assistant.

### 🔀 Multi-mode switching

Create separate stacks for different tasks:

```
.pi/prompt-stacks/
  coder.json       # strict coding assistant
  writer.json      # creative writing partner
  translator.json  # bilingual translator
```

Switch with `/preset use coder`, `/preset use writer`, etc.

### 🧠 Cross-turn memory

Define state the agent can read and write:

```json
"state": {
  "definitions": {
    "agent.progress": {
      "type": "string",
      "scope": "session",
      "description": "What we're working on",
      "agentWritable": true
    }
  }
}
```

The agent updates it with `forge_state_set`. You can also set state manually:

```
/state set user.preference "use TypeScript, not JavaScript"
```

### 📦 SillyTavern migration

Bring your ST presets into Pi:

```
/preset import-silly ~/SillyTavern/presets/my-preset.json
```

pi-forge converts the preset to a prompt stack and generates a migration report showing what was handled and what needs manual tweaking.

### 🔍 Prompt debugging

See exactly what gets sent to the model:

```
/payload next save=.pi/forge/payloads/last.json
```

Or preview your compiled prompt without sending anything:

```
/preset preview
```

## How it works

A prompt stack is a JSON file with two kinds of items:

| Kind | What it does |
|------|-------------|
| **Block** | Static text inserted at a specific position (system prompt, user message, assistant message) |
| **Slot** | Dynamic content from Pi's runtime — tools, skills, chat history, date, project context, etc. |

Items are arranged in order. When the stack is active, pi-forge:

1. Builds a system prompt from your `system`-role blocks and slots, then applies it with the stack's `mode`.
2. Inserts `user`/`assistant` blocks and slots around the conversation history.
3. Expands `{{macros}}` like `{{lastUserMessage}}`, `{{date}}`, and custom variables.

### Slots at a glance

| Slot | What it inserts |
|------|----------------|
| `chat-history` | The current conversation |
| `tools` | Available tools and their descriptions |
| `tool-guidelines` | Tool usage instructions |
| `skills` | Loaded Pi skills |
| `project-context` | Project instructions and context files |
| `variables` | Agent and user state (progress, preferences, notes) |
| `date` / `cwd` / `date-cwd` | Current date and working directory |
| `active-model` | Which model is being used |
| `append-system-prompt` | User's appended system prompt text |
| `pi-docs` | Pi documentation guidance |

### Modes

- **replace** (default) — your stack replaces Pi's system prompt entirely.
- **append** — your stack is added after Pi's default system prompt.
- **prepend** — your stack is added before Pi's default system prompt.

## Common commands

### Managing stacks

| Command | What it does |
|---------|-------------|
| `/preset list` | Show all available stacks |
| `/preset use <id>` | Activate a stack |
| `/preset use none` | Disable prompt stacks for the session |
| `/preset preview [id]` | See the compiled prompt |
| `/preset validate [id]` | Check a stack for issues |
| `/preset status` | Show the active stack and diagnostics summary |
| `/preset diagnostics` | Show runtime diagnostics |
| `/preset reload` | Reload stacks from disk |
| `/preset ui [stop\|restart]` | Open, stop, or restart the web editor |

### State management

| Command | What it does |
|---------|-------------|
| `/state list` | Show all session state |
| `/state status` | Show state definitions and current values |
| `/state set <name> <value>` | Set a state variable |
| `/state get <name>` | Read a state variable |
| `/state clear [name]` | Clear state (all or by name) |
| `/preset vars ...` | Legacy variable commands kept for older stacks |

### Import & debug

| Command | What it does |
|---------|-------------|
| `/preset import-silly <path>` | Import a SillyTavern preset |
| `/intercept` | Show the next provider payload |
| `/payload next [save=<path>]` | Show and optionally save the next payload |

## Common macros

Use these in block content to insert dynamic values:

| Macro | Expands to |
|-------|-----------|
| `{{lastUserMessage}}` | The user's latest message |
| `{{date}}` | Current date (YYYY-MM-DD) |
| `{{time}}` | Current time (HH:MM:SS) |
| `{{cwd}}` | Current working directory |
| `{{tools}}` | Comma-separated tool names |
| `{{selectedTools}}` | Alias for selected tool names |
| `{{activeModel}}` | Current model (provider/id) |
| `{{char}}` / `{{user}}` | Custom variables from your stack |

### Variable macros

```
{{setvar::name::value}}       set a turn variable (cleared each message)
{{setsessionvar::name::value}} set a session variable (persists)
{{setvar::session::name::value}} also set a session variable
{{getvar::name}}              read a variable (turn → session → static)
{{getturnvar::name}}          read only a turn variable
{{getsessionvar::name}}       read only a session variable
{{clearvar::name}}            clear a variable
{{clearturnvar::name}}        clear a turn variable
{{clearsessionvar::name}}     clear a session variable
```

## Stack reference

### Full item types

**Block:**

```json
{
  "kind": "block",
  "id": "unique-id",
  "name": "Readable label",
  "enabled": true,
  "role": "system",
  "content": "Your text here. Use {{macros}} for dynamic content."
}
```

Valid roles: `system`, `user`, `assistant`, `custom`.

**Slot:**

```json
{
  "kind": "slot",
  "id": "unique-id",
  "name": "Chat History",
  "enabled": true,
  "role": "user",
  "slot": "chat-history",
  "options": {
    "includeLastUserMessage": false
  }
}
```

### Chat history options

```json
"options": {
  "includeLastUserMessage": false
}
```

Set to `false` when you use `{{lastUserMessage}}` after the history — prevents the user's message from appearing twice.

### Variables slot options

```json
{
  "kind": "slot",
  "id": "state",
  "enabled": true,
  "role": "user",
  "slot": "variables",
  "options": {
    "includeScopes": ["session"],
    "includeNamespaces": ["user.*", "agent.*"],
    "includeMetadata": true,
    "format": "xml",
    "maxValueChars": 1200
  }
}
```

### State definitions

```json
"state": {
  "schemaVersion": 1,
  "definitions": {
    "agent.progress": {
      "type": "string",
      "scope": "session",
      "description": "Current task progress",
      "agentWritable": true
    },
    "user.preference": {
      "type": "string",
      "scope": "session",
      "description": "User's preference for this session",
      "userWritable": true
    }
  }
}
```

Supported types: `string`, `number`, `boolean`, `null`, `object`, `array`, `string[]`, `number[]`, `boolean[]`, `unknown`, and unions like `string | null`.

## Agent tools

pi-forge registers two tools that the AI agent can call:

### `forge_state_set`

Batch-update persistent state. Only `agent.*` names are writable. Use for cross-turn tracking:

- Task progress (`agent.progress`)
- Open questions (`agent.openQuestions`)
- Story state (`agent.storyState`)
- User-requested notes (`agent.notes`)

### `forge_set_var`

Legacy alias for setting a single string value. Prefer `forge_state_set`.

## Package setup for development

```bash
git clone <repo>
cd pi-forge
# .pi/settings.json already points at the package root
pi    # start Pi, trust the project, /reload if needed
```

Run tests:

```bash
npm test
```

Typecheck:

```bash
npm run typecheck
```

## License

MIT
