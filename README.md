# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md)

**pi-forge** lets you customize how Pi thinks and behaves. It gives you prompt stacks — JSON files that can replace, append to, or prepend Pi's default system prompt while controlling the AI's personality, visible tools, conversation history layout, template variables, and prompt transforms.

Think of it as a character sheet for your AI agent.

## What you can do with it

- **Give Pi a personality** — turn it into a creative writer, a roleplay partner, a strict code reviewer, or anything in between.
- **Switch contexts instantly** — one command to swap between "coding mode", "writing mode", and "translation mode".
- **Control what the AI sees** — choose which tools, skills, and project context appear in each prompt.
- **Limit tools and skills per stack** — enforce active tool policy and filter skill visibility for focused modes.
- **Use template variables** — define static values such as `{{char}}` / `{{user}}`, and use ST-style turn/session variable macros inside prompt text.
- **Transform outgoing and finalized text** — run deterministic regex replacements on selected history, compiled prompt text, or finalized assistant messages.
- **Import SillyTavern presets** — bring your existing ST character presets into Pi with one command.
- **Debug your prompts** — intercept and inspect exactly what gets sent to the model.

## Quick start

### Install

```bash
pi install npm:@zihanw/pi-forge
```

### Your first prompt stack

Create `.pi/forge/prompt-stacks/default.json`:

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

Drag, drop, edit, validate, inspect full previews and captured payloads, manage variables/context/regex rules in tabs, switch dark mode, recover through raw stack JSON, import, export, fork, and delete stacks — all in your browser. Stack metadata is collapsible so the active editor stays in view.

Import accepts native pi-forge stack JSON and SillyTavern preset JSON. SillyTavern presets are converted to prompt stacks automatically; if a preset contains multiple `character_id` configs, the editor asks which one to use.

The editor runs on an available `127.0.0.1` port with a session token, so multiple Pi instances can run editors at the same time. If Pi reinitializes the extension after session navigation or a new session, `/preset ui` reuses the existing editor URL for the same project instead of orphaning the old server. Writes require a trusted project and stay inside prompt-stack storage. New stacks are written to `.pi/forge/prompt-stacks`; existing legacy stacks under `.pi/prompt-stacks` remain readable and editable. Successful save, import, fork, and delete actions reload into the current Pi session. Use `/preset ui restart` or `/preset ui stop` when needed.

To copy old stacks into the new location, run `/preset migrate-stacks`. Add `--dry-run` to preview, `--overwrite` to replace existing target files, and `--delete-legacy` to remove old files after successful copy.

To prefer a specific port, create `.pi/forge/config.json`. If that port is busy, pi-forge falls back to another available port and shows the actual URL:

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

Create a `reviewer.json` stack with a strict review block: "prioritize correctness, regressions, security, and missing tests." Keep the `tools`, `project-context`, `variables`, and `chat-history` slots enabled so Pi can still inspect the repo and see any template variables you expose.

Use `mode: "append"` if you want to keep Pi's normal coding behavior and only add the sharper review lens.

### 🌐 Translation mode

Create a small `translator.json` stack with one system block for tone and target language, then keep `chat-history` and `{{lastUserMessage}}` in the layout. This works well for switching between bilingual editing, literal translation, and localization review without changing your default assistant.

### 🔀 Multi-mode switching

Create separate stacks for different tasks:

```
.pi/forge/prompt-stacks/
  coder.json       # strict coding assistant
  writer.json      # creative writing partner
  translator.json  # bilingual translator
```

Switch with `/preset use coder`, `/preset use writer`, etc.

### 🔧 Template variables

```json
"variables": {
  "char": "Konata",
  "user": "User"
}
```

Use static variables for stable prompt constants, and ST-style macros for local prompt-time mutation:

```
{{setvar::mood::focused}}
{{getvar::mood}}
{{setsessionvar::topic::compiler cleanup}}
```

For durable project memory, use normal files in the repo rather than pi-forge prompt variables.

### 📦 SillyTavern migration

Bring your ST presets into Pi:

```
/preset import-silly ~/SillyTavern/presets/my-preset.json
```

pi-forge converts the preset to a prompt stack and generates a migration report showing what was handled and what needs manual tweaking.

Deterministic SillyTavern `promptOnly` regex scripts are converted to pi-forge `regex.rules` when they can be represented safely. Display-only, mixed prompt/display, DOM/browser, CSS/HTML decoration, JavaScript, and unsupported regex scripts stay report-only for manual review.

### 🔍 Prompt debugging

See exactly what gets sent to the model:

```
/payload next save=.pi/forge/payloads/last.json
```

Or open `/preset ui`, click **Arm payload**, send the next Pi prompt, and inspect the redacted provider payload in the browser.

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
4. Applies stack tool policy to Pi's active tool set and filters pi-forge-rendered tool/skill slots.
5. Applies enabled outgoing regex rules for the `history` and `compiled` stages.
6. Optionally applies destructive `finalize` regex rules when an assistant message finishes.

### Slots at a glance

| Slot | What it inserts |
|------|----------------|
| `chat-history` | The current conversation |
| `tools` | Available tools and their descriptions |
| `tool-guidelines` | Tool usage instructions |
| `skills` | Loaded Pi skills |
| `project-context` | Project instructions and context files |
| `variables` | Static/session/turn template variables |
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
| `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` | Copy legacy `.pi/prompt-stacks` files into `.pi/forge/prompt-stacks` |
| `/preset ui [stop\|restart]` | Open, stop, or restart the web editor |

### Import & debug

| Command | What it does |
|---------|-------------|
| `/preset import-silly <path>` | Import a SillyTavern preset |
| `/intercept` | Show the next provider payload |
| `/payload next [save=<path>]` | Show, save, and expose the next payload to the web editor |

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

### Structured slot format options

Structured runtime slots default to XML-style wrappers. Add `"format": "plain"` to `tools`, `tool-guidelines`, `skills`, `project-context`, or `variables` slots for compact newline-separated output.

```json
{
  "kind": "slot",
  "id": "tools",
  "enabled": true,
  "role": "system",
  "slot": "tools",
  "options": {
    "format": "plain"
  }
}
```

### Tool and skill policy

Prompt stacks can constrain tools and skills with stack-level `allow` or `deny` lists. Patterns are exact by default and support `*` wildcards.

```json
{
  "tools": {
    "allow": ["read", "bash"]
  },
  "skills": {
    "deny": ["browser-danger"]
  }
}
```

Use `allow` when only matching tools or skills should remain active. Use `deny` when everything except matching tools or skills should remain active. A single resource policy cannot contain both non-empty lists; mixed `allow` and `deny` entries are validation errors.

Tool policy is enforced through Pi's active tool list while the stack is active. pi-forge remembers the previous active tools and restores them when prompt stacks are disabled or switched to an unrestricted stack.

Skill policy filters skills rendered by pi-forge's `skills` slot. If a stack uses `mode: "append"` or `"prepend"`, Pi's base prompt may already contain unfiltered skills; use `mode: "replace"` when skill visibility must be controlled.

### Regex transforms

Prompt stacks can run deterministic regex replacements on model-bound prompt text and, optionally, finalized assistant messages. Outgoing rules support `history` and `compiled` stages. Destructive final-message cleanup uses `effect: "finalize"` at `stage: "compiled"` with the `messages` target. True display-only streaming transforms and provider-payload rewrites are not active yet.

```json
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
```

Use `stage: "history"` to transform messages inserted by the `chat-history` slot. Use `stage: "compiled"` with optional `targets: ["system"]`, `["messages"]`, or both to transform the final compiled prompt. Message rules can filter by `roles`, `maxMessages`, and `maxChars`. Supported regex flags are `g`, `i`, `m`, `s`, and `u`.

To clean a completed assistant message after streaming, use `effect: "finalize"`:

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

Warning: `finalize` runs at `message_end`, after raw output may already have streamed in the TUI. It returns a cleaned replacement message to Pi, so the original model output is not preserved in the stored transcript.

`effect: "outgoing"` changes model input. `effect: "finalize"` changes finalized assistant transcript content. `effect: "display"` and `"both"` validate with warnings but are ignored at runtime until true display transforms are implemented.

The web editor has a structured Regex dialog for these rule fields and preserves advanced unknown fields for raw JSON editing.

### Variables slot options

```json
{
  "kind": "slot",
  "id": "variables",
  "enabled": true,
  "role": "user",
  "slot": "variables",
  "options": {
    "includeStatic": true,
    "includeSession": true,
    "includeTurn": false,
    "format": "xml"
  }
}
```

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
