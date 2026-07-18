# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md)

![pi-forge header](https://raw.githubusercontent.com/MacroSony/pi-forge/main/assets/pi-forge-header-concept-1.png)

**pi-forge** lets you customize how Pi thinks and behaves. It gives you prompt stacks for prompt/tool policy and agent profiles that apply a model, thinking level, and prompt stack as a reusable one-shot preset.

Think of it as a character sheet for your AI agent.

## What you can do with it

- **Give Pi a personality** — turn it into a creative writer, a roleplay partner, a strict code reviewer, or anything in between.
- **Switch contexts instantly** — one command to swap between "coding mode", "writing mode", and "translation mode".
- **Save complete agent presets** — capture the current model, thinking level, and prompt stack, then apply them together later.
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

This development version requires Node.js 22.19 or newer and the exact `@earendil-works/pi-*` 0.80.10 packages used by Pi 0.80.10.

> **Pi version compatibility:** Pi changed session authentication/runtime wiring within the 0.80.x line. This build targets 0.80.10 exactly; 0.80.6–0.80.9 and later unverified 0.80.x releases are not claimed as compatible. After installing or rebuilding pi-forge, restart Pi so the extension and host SDK agree. If the parent agent can use a provider but subagent preparation reports `No API key found`, check for an older pi-forge build before using `/login`: a build using the pre-0.80.10 session API can lose the parent authentication during preparation, and logging in again does not fix that version mismatch.

### Your first prompt stack

Create `.pi/forge/prompt-stacks/default.json` from [examples/default-prompt-stack.json](examples/default-prompt-stack.json).

The default example mirrors Pi's own prompt builder from `@earendil-works/pi-coding-agent/dist/core/system-prompt.js`, but splits it into movable pi-forge slots: role, tools, guidelines, Pi docs guidance, appended system prompt text, project context, skills, date/cwd, and chat history.

```bash
mkdir -p .pi/forge/prompt-stacks
$EDITOR .pi/forge/prompt-stacks/default.json
```

Paste the example JSON into that file. If you are working inside this repository, you can copy it directly with `cp examples/default-prompt-stack.json .pi/forge/prompt-stacks/default.json`.

That's it. Restart Pi or run `/preset reload`. If no stack is already selected, `default.json` auto-activates. If you previously chose another stack or `/preset use none`, run `/preset use default`.

### Visual editor

Prefer clicking over typing JSON? pi-forge has a built-in web editor:

```
/preset ui
```

Drag, drop, create, edit, validate, inspect full previews and captured payloads, manage variables/context/regex rules in tabs, switch dark mode, recover through raw stack JSON, import, export, fork, and delete stacks — all in your browser. New stacks start from the default Pi prompt mirror layout. Existing stack IDs are immutable; use Fork to create a new ID without risking profile references or active selection. Stack metadata is collapsible so the active editor stays in view. The policy tab shows registered tools and loaded skills with selected-pattern chips and filtering, so allow/deny rules can be built from exact names while still supporting wildcards.

Import accepts native pi-forge stack JSON and SillyTavern preset JSON. SillyTavern presets are converted to prompt stacks automatically; if a preset contains multiple `character_id` configs, the editor asks which one to use.

The editor runs on an available `127.0.0.1` port with a session token, so multiple Pi instances can run editors at the same time. If Pi reinitializes the extension after session navigation or a new session, `/preset ui` reuses the existing editor URL for the same project instead of orphaning the old server; resources and preview remain available across lifecycle refreshes. Writes require a trusted project and stay inside prompt-stack storage. New stacks are written to `.pi/forge/prompt-stacks`; existing legacy stacks under `.pi/prompt-stacks` remain readable and editable. Successful save, import, fork, and delete actions reload into the current Pi session. Use `/preset ui restart` or `/preset ui stop` when needed.

To copy old stacks into the new location, run `/preset migrate-stacks`. Add `--dry-run` to preview, `--overwrite` to replace existing target files, and `--delete-legacy` to remove old files after successful copy.

To prefer a specific port, create `.pi/forge/config.json`. If that port is busy, pi-forge falls back to another available port and shows the actual URL:

```json
{
  "webEditor": {
    "port": 41738
  }
}
```

### Agent profiles

Agent profiles are project-local JSON files under `.pi/forge/agent-profiles`. The quickest way to create one is to configure Pi normally and capture the current model, thinking level, and prompt-stack selection:

```text
/profile save reviewer
/profile use reviewer
```

Profiles are applied once. They do not continuously own Pi's model or thinking level, so later manual changes are preserved until `/profile use reviewer` is run again. Prompt-stack tool policy remains strict for as long as that stack is active.

A profile can also be written directly:

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.agent-profile",
  "id": "reviewer",
  "name": "Reviewer",
  "description": "Reviews code without making changes.",
  "autoActivate": true,
  "model": {
    "provider": "provider-id",
    "id": "model-id"
  },
  "thinkingLevel": "high",
  "promptStack": "reviewer"
}
```

`autoActivate: true` applies the complete profile once when Pi starts a fresh session. At most one profile may request auto-activation. An auto-activated profile takes precedence over standalone prompt-stack autoload, including when its `promptStack` is `null`; if no profile requests auto-activation, the existing `default.json`/`autoActivate` stack behavior remains the fallback. Restored branch selections take precedence over both mechanisms.

`promptStack` may be `null`. Tool names and skill lists do not belong in profile v1: the referenced prompt stack is the single source of truth for tool policy and model-visible skill filtering. Profile validation rejects unsupported fields rather than silently retaining inert generation or runner settings.

`/profile preview <id>` resolves the model, authentication, thinking-level support, prompt stack, and effective tools without changing runtime state. `/profile status` reports the last-applied profile and current drift; it deliberately does not describe a profile as active. Provenance follows the session branch for status purposes but never causes automatic reapplication during reload, resume, tree navigation, or compaction. Fresh-session auto-activation is still one-shot, so later manual changes are preserved.

### Experimental foreground subagent

The 0.4 development branch can run a stored profile as a separate, clean, one-shot Pi subprocess. The no-egress `forge_subagent_profiles` tool lets the main agent discover the currently loaded profile IDs, names, descriptions, declared model/thinking/stack, and current resolution status. It should call that first when the user has not specified a profile, then invoke `forge_subagent`. A restrictive main-agent prompt stack must permit both tool names. The same execution path remains available to a human through commands:

```text
/forge-agent backends
/forge-agent plan reviewer Review this API design for correctness.
/forge-agent run reviewer Review this API design for correctness.
```

`plan` resolves the profile and stack, compiles the exact provider-bound prompt, validates an immutable execution plan, and then discards it without contacting the provider. `run` and `forge_subagent` prepare that same exact plan before showing an approval screen. The default screen shows the agent task, profile/stack, provider, model, thinking level, effective tools, working directory, security boundary, payload size, and execution fingerprint. Choose **View full prompt** to inspect the complete system prompt and ordered provider-bound messages before approving; any editor changes are ignored.

The child starts with a clean conversation and receives no parent history automatically. It runs in the foreground with the profile's exact model/thinking level and prompt stack. Its only candidate tools are `read`, `grep`, `find`, and `ls`, further restricted by the stack's tool policy; it receives no write/edit/shell tools, skills, prompt templates, context files, or third-party extensions. The final tool result contains a bounded model-visible report plus expandable human-visible execution details. Retained transcript strings are individually bounded, base64-like text is redacted, and the transcript keeps a 512 KiB rolling tail so the final report remains available without making the TUI retain an unbounded tool history. Inline image data stays inside the child long enough for the selected vision model to use it, but the dedicated report channel replaces binary payloads with MIME type and encoded-size metadata before anything is retained in the parent session.

Important: this first backend is **shared-user**, not an operating-system sandbox. Read-only is a model-tool policy: the subprocess retains the invoking user's OS permissions, and absolute paths readable by that user may be read, sent to the selected provider, and retained as text inside the parent tool-result details. Host timeout and cancellation are best effort. `/tree` removes the invocation and result from the active conversation branch, but abandoned entries can remain in Pi's on-disk session JSONL; deleting sensitive retained text requires deleting the relevant session data. `/tree` also cannot undo provider requests, billing, or external side effects. The default tool set intentionally provides no filesystem mutation path while a bubblewrap-style sandbox and staged write mode remain future work.

## Use cases

### 🎭 Roleplay & creative writing

Turn Pi into a character. Define their personality in the system prompt, inject writing style rules as user messages, and use `{{lastUserMessage}}` to re-insert the user's input after the conversation history.

Useful pattern:
- Put long-term character rules in a `system` block.
- Keep Pi runtime context (tools, skills, project) in `user` slots.
- Set the `chat-history` slot to skip the latest user message.
- Add a final `user` block with `{{lastUserMessage}}`.

This keeps the latest request clear and avoids duplicating it.

For a baseline stack to fork before turning Pi into a character, start from [examples/default-prompt-stack.json](examples/default-prompt-stack.json).

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

### 🧪 Presets that show off pi-forge

- **Pi mirror** — start from [examples/default-prompt-stack.json](examples/default-prompt-stack.json). It preserves normal Pi behavior while making every runtime section movable and inspectable.
- **Focused reviewer** — see [examples/reviewer-prompt-stack.json](examples/reviewer-prompt-stack.json). It denies file-writing tools, wraps prior chat history as background, removes the latest user message from history, then reinserts `{{lastUserMessage}}` as the explicit review target.
- **Read-only scout** — use `tools.allow` for `read`, `grep`, `find`, and `ls`; omit editing tools; cap `chat-history` with `maxChars`. Good for exploration turns where the model should report findings without changing files.
- **Surgical patcher** — keep the Pi mirror, require `read`, `edit`, and `bash`, strip assistant thinking from inserted history, and move `project-context` near the final user turn. Good for focused implementation passes.
- **SillyTavern DM writer** — see [examples/sillytavern-dm-writer-prompt-stack.json](examples/sillytavern-dm-writer-prompt-stack.json). It defines a Dungeon Master character with `{{char}}` / `{{user}}`, wraps prior adventure history, reinserts `{{lastUserMessage}}` as the current player action, and uses regex cleanup for OOC notes, secret-roll markers, dice notation, and `Player:` prefixes.
- **Payload lab** — include `active-model`, `date-cwd`, and variables slots, then add `compiled` regex rules for deterministic redaction or formatting. Pair it with `/payload next` or the web editor's capture view to audit exactly what changed.
- **Docs-only Pi expert** — allow only read/search tools, enable the `pi-docs` slot, and keep project context. Useful when you want answers grounded in the installed Pi docs instead of general memory.

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

Deterministic SillyTavern `promptOnly` regex scripts are converted to pi-forge `regex.rules` as history-stage rules when they can be represented safely, including full-match token conversion, trim strings, depth fields, and clear user/assistant placements. Display-only, mixed prompt/display, DOM/browser, CSS/HTML decoration, JavaScript, unsupported placements, and invalid regex scripts stay report-only for manual review.

### 🔍 Prompt debugging

See exactly what gets sent to the model:

```
/payload next save=.pi/forge/payloads/last.json
```

Or open `/preset ui`, click **Arm payload**, send the next Pi prompt, and inspect the redacted provider payload in the browser. Credential-shaped token fields remain hidden, while normal limits and accounting fields such as `max_tokens`, `input_tokens`, and `output_tokens` remain visible.

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
| `date` / `cwd` / `date-cwd` | Current date, optional current time, and working directory |
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

### Managing agent profiles

| Command | What it does |
|---------|-------------|
| `/profile list` | Show project profiles and resolution diagnostics |
| `/profile use <id>` | Preflight and apply a profile once |
| `/profile save <id> [--overwrite]` | Capture the current model, thinking level, and prompt stack |
| `/profile status` | Show current runtime, last-applied provenance, and drift |
| `/profile preview <id>` | Preview resolved effects and effective tools without applying |
| `/profile validate [id]` | Validate one profile, or all profiles when omitted |
| `/profile reload` | Reload profile files without applying them |
| `/profile forget` | Forget last-applied provenance without changing runtime state |

### Experimental foreground subagent

| Command | What it does |
|---------|-------------|
| `/forge-agent backends` | Show the available experimental backend and its capabilities |
| `/forge-agent plan <profile> <task>` | Prepare, validate, display, and discard an exact plan without provider transport |
| `/forge-agent run <profile> <task>` | Review the exact plan and run one foreground read-only text task after approval |

The model-callable tools are `forge_subagent_profiles` for local metadata discovery and `forge_subagent` for execution. Discovery needs no approval and performs no provider request or subagent prompt preparation. Invocation is available only when the current main-agent tool policy permits it and an interactive approval UI is present.

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

### Filter and conditional macros

Nested macros are supported, and `::` separators are parsed only at the current macro depth.

| Macro | Expands to |
|-------|-----------|
| `{{trim::value}}` | `value` with leading/trailing whitespace removed |
| `{{upper::value}}` | Uppercase `value` |
| `{{lower::value}}` | Lowercase `value` |
| `{{json::value}}` | JSON string literal for `value` |
| `{{xml::value}}` | XML-escaped `value` |
| `{{ifvar::name::then::else}}` | `then` when a variable exists, otherwise `else` |
| `{{ifeq::name::expected::then::else}}` | `then` when a variable equals `expected`, otherwise `else` |
| `{{iftools::tool::then::else}}` | `then` when the selected tool list includes `tool`, otherwise `else` |
| `{{ifslot::slot::then::else}}` | `then` when the enabled stack items include `slot`, otherwise `else` |

Conditional branches are lazy: only the selected branch is expanded, so skipped branches cannot set or clear variables. The final `else` argument is optional and defaults to empty text.

### Trusted custom macros and slots

Custom macros and slots are registered by trusted extension code, not embedded in prompt-stack JSON. For project-local customization, put registration modules in `.pi/forge/extensions/`. For machine-wide personal customization, put them in `~/.pi/forge/extensions/`. pi-forge loads global modules first, then project-local modules, after project trust and before stack validation. Both locations reload on `/preset reload`.

These modules receive the registration API from pi-forge, so they do not need to import `@zihanw/pi-forge` or know where pi-forge is installed.

```ts
// .pi/forge/extensions/ticket-context.ts
export default function register(api) {
  api.registerMacro({
    name: "ticketId",
    description: "Current ticket id from session variables.",
    render: (ctx) => ctx.variables.toMacroText(ctx.variables.get("ticket.id")),
  });

  api.registerSlot({
    name: "ticket-context",
    description: "Render ticket context for the current task.",
    options: {
      heading: { type: "string", default: "Ticket context" },
    },
    render: (ctx) => [
      String(ctx.options.heading ?? "Ticket context") + ":",
      "- Ticket: " + ctx.variables.toMacroText(ctx.variables.get("ticket.id")),
      "- Project: " + ctx.helpers.normalizePath(ctx.runtime.options.cwd),
    ].join("\n"),
  });
}
```

The stack remains declarative:

```json
{
  "kind": "slot",
  "id": "ticket-context",
  "enabled": true,
  "role": "system",
  "slot": "ticket-context",
  "options": {
    "heading": "Current ticket"
  }
}
```

Supported module files are `.ts`, `.js`, `.mjs`, `.cjs`, and `index.*` inside a subdirectory. TypeScript modules should stick to syntax Node can strip at runtime, or you can use `.js` / `.mjs` instead. A module can export either `default function register(api)` or `export function register(api)`. Registered macro and slot names must be unique across built-ins, global extensions, and project extensions; duplicate names show as extension load warnings.

The API includes `cwd`, `forgeDir`, `extensionPath`, `helpers`, `registerMacro`, `registerSlot`, `getRegisteredMacros`, and `getRegisteredSlots`. For global modules, `forgeDir` is `~/.pi/forge`; for project modules, it is `<project>/.pi/forge`.

Missing custom slots are validation warnings until the registering module is loaded. Built-in macros and slots use the same registry internally, so `getRegisteredMacros()` and `getRegisteredSlots()` can be used as implementation references. `/preset diagnostics` shows loaded pi-forge extension files and load failures.

For a complete copyable extension and stack, see [examples/custom-system-status-extension](examples/custom-system-status-extension). It registers a `{{cpuLoad}}` macro and a `machine-status` slot from `.pi/forge/extensions/system-status.ts`.

Reusable Pi packages can still import `registerMacro` and `registerSlot` from `@zihanw/pi-forge`. The `.pi/forge/extensions` and `~/.pi/forge/extensions` loaders are intended for small trusted customizations without package boilerplate.

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
  "includeLastUserMessage": false,
  "stripAssistantThinking": true,
  "includeSummaries": true,
  "toolMode": "keep",
  "roles": ["user", "assistant"],
  "maxMessages": 40,
  "maxChars": 20000
}
```

Set to `false` when you use `{{lastUserMessage}}` after the history — prevents the user's message from appearing twice.

Set `stripAssistantThinking` to `true` to remove prior assistant thinking blocks from inserted chat history. Visible assistant text, tool calls, and tool result messages are preserved. This only affects history inserted by that slot and does not alter the current agent loop or stored transcript.

Use `includeSummaries: false` to omit Pi branch/compaction summary messages, `roles` to keep only specific message roles, `toolMode: "drop"` to remove prior tool-call/tool-result history, and `maxMessages` / `maxChars` to keep only recent history. When filters or limits can break tool-call pairs, pi-forge removes dangling tool calls/results instead of sending inconsistent tool history.

### Date slot options

Set `"includeTime": true` on a `date` or `date-cwd` slot to include the current time in `HH:MM:SS` after the current date.

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

The default Pi mirror uses a few extra slot options:

```json
{
  "slot": "tools",
  "options": {
    "format": "plain",
    "onlyWithSnippets": true
  }
}
```

`tools.onlyWithSnippets` matches Pi's default "Available tools" section by hiding tools that do not provide prompt snippets. `tool-guidelines.heading`, `tool-guidelines.includePiDefaultGuidelines`, and `tool-guidelines.piStyle` make the guidelines slot match Pi's default heading and bullets. `skills.requireReadTool` hides skills unless the read tool is active, matching Pi's default behavior.

### Tool and skill policy

Prompt stacks can constrain active tools and filter model-visible skills with stack-level `allow` or `deny` lists. Patterns are exact by default and support `*` wildcards.

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

For tools, use `allow` when only matching active tools should remain and `deny` when matching active tools should be removed. For skills, the same patterns control which skills remain visible in pi-forge's rendered `skills` slots. A single resource policy cannot contain both non-empty lists; mixed `allow` and `deny` entries are validation errors.

Tool policy is enforced through Pi's active tool list while the stack is active. On startup and reload, pi-forge waits for other extensions to finish their `session_start` tool configuration before capturing the baseline and applying the stack policy. It reasserts the policy before user input and turns, and a tool-call guard blocks disallowed model tool execution even if another extension later calls `setActiveTools()`. External tool additions are preserved in the restorable baseline, which is restored when prompt stacks are disabled or switched to an unrestricted stack.

Skill policy filters skills rendered by pi-forge's `skills` slot. It does not disable explicit skill invocation and is not a capability or security boundary. If a stack uses `mode: "append"` or `"prepend"`, Pi's base prompt may already contain unfiltered skills; use `mode: "replace"` when model-visible skill listings must be controlled.

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

Use `stage: "history"` to transform messages inserted by the `chat-history` slot. Use `stage: "compiled"` with optional `targets: ["system"]`, `["messages"]`, or both to transform the final compiled prompt. Message rules can filter by `roles`, `maxMessages`, `maxChars`, `minDepth`, and `maxDepth`, where depth `0` is the latest message. Replacements use JavaScript syntax (`$&` for the full match, `$1` for captures; `$0` is also accepted as a full-match alias, and `$$` escapes a literal `$`). `trimStrings` removes literal strings from expanded replacement matches/captures, matching SillyTavern's Trim Out behavior. Supported regex flags are `g`, `i`, `m`, `s`, and `u`.

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

SillyTavern imports convert deterministic prompt-only `{{match}}` / `$0` full-match replacements to JavaScript `$&` (both `$0` and `$&` work in pi-forge), preserve original regex metadata in `source.sillytavern`, and run as history-stage rules so depth stays chat-relative. Display-only/browser/unsupported-placement scripts stay report-only. The web editor has a structured Regex dialog for these rule fields and preserves advanced unknown fields for raw JSON editing.

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
git clone https://github.com/MacroSony/pi-forge.git
cd pi-forge
npm install
npm run build
# .pi/settings.json loads the package's built dist/index.js
pi    # start Pi, trust the project, /reload if needed
```

The npm package intentionally omits physical `src/` files and loads compiled `dist/` output at runtime. To inspect or modify pi-forge itself, clone or fork the repository instead of editing `node_modules` or generated `dist/` files. A clone preserves your changes in Git and includes the development dependencies, tests, and source-to-dist consistency checks.

For release-like local testing, register the cloned package directory. Its package manifest loads the tracked `dist/index.js`:

```json
{
  "packages": ["../pi-forge"]
}
```

For live source development, remove that pi-forge package entry and load the TypeScript extension directly from `.pi/settings.json`:

```json
{
  "extensions": ["../pi-forge/src/index.ts"]
}
```

You can also run `pi -e ../pi-forge/src/index.ts` for a one-off source-level smoke test. Do not load the package and source entry simultaneously or pi-forge will initialize twice. Browser-client source changes additionally require `npm run build:client` because the local editor serves its generated browser bundle.

Run tests:

```bash
npm test
```

Run the real-browser editor smoke test (set `CHROME_PATH` if Chrome is not in a standard location):

```bash
npm run test:browser
```

Typecheck:

```bash
npm run typecheck
```

Build package output:

```bash
npm run build
```

Run the full repository verification, including a clean temporary build that checks tracked `dist/` byte-for-byte against `src/`:

```bash
npm run verify
```

The same verification runs in CI. When source changes affect generated output, run `npm run build` and commit the matching `dist/` changes with the source changes.

## License

MIT
