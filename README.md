# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md) · [Documentation](docs/README.md)

![pi-forge header](https://raw.githubusercontent.com/MacroSony/pi-forge/main/assets/pi-forge-header-concept-1.png)

**pi-forge** lets you customize how [Pi](https://github.com/badlogic/pi-mono) thinks and behaves. Prompt stacks control prompt composition and tool policy; agent profiles apply a model, thinking level, and stack as a reusable one-shot preset.

Think of it as a character sheet and workbench for your AI agent.

## Highlights

- Compose Pi's system prompt, conversation history, tools, skills, project context, and runtime data as ordered blocks and slots.
- Switch between coding, reviewing, writing, roleplay, and translation modes with one command.
- Save and apply complete model/thinking/stack profiles.
- Enforce per-stack tool policy and filter model-visible skills.
- Use immutable stack `parameters` with the deterministic forge-v1 template engine.
- Apply deterministic regex transforms to outgoing prompts or finalized assistant messages.
- Edit stacks and profiles in a local browser UI and inspect the exact provider payload.
- Inspect prompt changes in the Preview dock: **Preview** compiles the live draft, **Draft diff** compares unsaved edits with disk, and **Run diff** compares recent provider turns. Diff views focus on changed blocks by default, keep cache metadata out of the way until expanded, and can switch between split and full-width focus layouts.
- Run an explicitly enabled profile as an experimental, approval-gated foreground subagent.

## Install

pi-forge requires Node.js 22.19 or newer.

```bash
pi install npm:@zihanw/pi-forge
```

Restart Pi after installing or updating the extension. Pi supplies its SDK packages to extensions at runtime; pi-forge keeps exact Pi versions only for reproducible development and tests. See [compatibility and setup](docs/development/setup.md#pi-compatibility) for the supported/tested policy.

## Five-minute start

### 1. Create a prompt stack

Create `.pi/forge/prompt-stacks/default.json` from [the default Pi mirror](examples/default-prompt-stack.json):

```bash
mkdir -p .pi/forge/prompt-stacks
cp examples/default-prompt-stack.json .pi/forge/prompt-stacks/default.json
```

If you installed from npm rather than cloning this repository, open `/preset ui` and create a new stack; the editor starts with the same Pi-mirror layout.

Restart Pi or run:

```text
/preset reload
/preset use default
```

`default.json` auto-activates when no stack or restored session selection takes precedence.

### 2. Open the visual editor

```text
/preset ui
```

The local editor can create, fork, validate, preview, import, export, and delete prompt stacks. Its **Agent profiles** view manages one-shot model/thinking/stack presets. Writes require a trusted project. When `@zihanw/pi-forge-subagents` is installed, its schema-driven editor appears on the separate top-level **Settings** surface and persists to the optional package's `subagents.json` files.

### 3. Save a profile

Configure Pi normally, then capture and reuse the current settings:

```text
/profile save reviewer
/profile use reviewer
```

A profile applies once. Later manual changes to the model or thinking level remain in effect until the profile is applied again; an active prompt stack continues enforcing its tool policy.

## The basic model

A prompt stack is an ordered JSON document containing:

| Item | Purpose |
|---|---|
| **Block** | Static `system`, `user`, `assistant`, or hidden `custom` text |
| **Slot** | Runtime content such as tools, skills, project context, date/cwd, or chat history |

Stacks can `replace`, `append`, or `prepend` Pi's base system prompt. During compilation, pi-forge compiles forge-v1 templates over `runtime.*` / `parameters.*` / `extensions.*`, inserts conversation content, enforces tool policy, filters its skill listing, and applies enabled regex rules.

Agent profiles are project-local references to an exact provider/model, thinking level, and prompt stack. They intentionally do not duplicate tool or skill policy—the referenced stack remains the source of truth.

Start with these examples:

- [Default Pi mirror](examples/default-prompt-stack.json) keeps normal Pi behavior while making its sections movable.
- [Focused reviewer](examples/reviewer-prompt-stack.json) creates a read-only review layout with an explicit latest-user target.
- [Custom system-status extension](examples/custom-system-status-extension/README.md) registers a trusted macro and slot.

## Common commands

| Command | Purpose |
|---|---|
| `/preset ui [stop\|restart]` | Open or manage the web editor |
| `/preset list` | List prompt stacks |
| `/preset use <id\|none>` | Select or disable a stack |
| `/preset preview [id]` | Compile a stack without sending a request |
| `/preset validate [id]` | Validate one stack or all stacks |
| `/preset diagnostics` | Show runtime and extension diagnostics |
| `/profile list` | List and preflight profiles |
| `/profile save <id> [--overwrite]` | Capture the current runtime as a profile |
| `/profile use <id>` | Preflight and apply a profile once |
| `/profile status` | Show last-applied provenance and runtime drift |
| `/payload next [save=<path>]` | Inspect the next redacted provider payload |

See the [complete command reference](docs/reference/commands.md).

## Experimental foreground delegation

The optional `@zihanw/pi-forge-subagents` package provides foreground delegation on top of pi-forge's `/subagent` host port. The model can discover eligible profiles with `forge_subagent_profiles` and invoke one with `forge_subagent`; humans use `/forge-agent plan` and `/forge-agent run`.

This feature is **experimental** and profiles are not delegatable by default. Enable each profile in the trusted project's `.pi/forge/subagents.json` (or the optional package's read-only legacy fallback in `.pi/forge/config.json.subagents`). Interactive execution presents an immutable plan for approval unless the project explicitly authorizes unattended model invocation.

> **Security boundary:** The current backends are shared-user processes, not operating-system sandboxes. “Read-only” describes the model-visible tool policy. The child retains the invoking user's OS read permissions, and readable content may be sent to the selected provider and retained in Pi's session data. Timeout and cancellation are best effort, and `/tree` cannot undo provider requests, billing, or external effects.

Read [foreground delegation and its safety model](docs/guides/delegation.md) before enabling it.

## Documentation

### Learn

- [Getting started](docs/getting-started.md)
- [Migrating to 0.5](docs/guides/migrating-to-0.5.md)
- [Prompt-stack concepts](docs/concepts/prompt-stacks.md)
- [Agent-profile concepts](docs/concepts/agent-profiles.md)
- [Web editor](docs/guides/web-editor.md)
- [Prompt-stack patterns and examples](docs/guides/use-cases.md)
- [Custom macros and slots](docs/guides/custom-macros-and-slots.md)
- [Prompt and payload debugging](docs/guides/debugging.md)

### Reference

- [Commands](docs/reference/commands.md)
- [Stack schema and policy](docs/reference/stack-schema.md)
- [Macros and slots](docs/reference/macros-and-slots.md)
- [Configuration](docs/reference/configuration.md)
- [Public API policy](docs/reference/public-api.md)
- [Experimental subagent host port](docs/reference/subagent-host-port.md)

### Develop and design

- [Development setup](docs/development/setup.md)
- [Architecture and development rules](docs/development/architecture-rules.md)
- [0.5 architecture plan](docs/design/architecture-0.5.md)
- [Release process](docs/development/release.md)
- [Roadmap](docs/development/roadmap.md)
- [Architecture and design index](docs/design/README.md)

Chinese user documentation starts at [docs/zh-CN/README.md](docs/zh-CN/README.md).

## License

[MIT](LICENSE)
