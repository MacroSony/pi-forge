# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md) · [Documentation](docs/README.md)

![pi-forge header](https://raw.githubusercontent.com/MacroSony/pi-forge/main/assets/pi-forge-header-concept-1.png)

**pi-forge** lets you customize how [Pi](https://github.com/badlogic/pi-mono) thinks and behaves. Presets bundle an ordered prompt Stack with tool/skill policy, Regex, and parameters; agent profiles apply a model, thinking level, and Preset as a reusable one-shot configuration.

Think of it as a character sheet and workbench for your AI agent.

## Highlights

- Compose Pi's system prompt, conversation history, tools, skills, project context, and runtime data as ordered blocks and slots.
- Switch between coding, reviewing, writing, roleplay, and translation modes with one command.
- Save and apply complete model/thinking/Preset profiles.
- Enforce per-Preset tool policy and filter model-visible skills.
- Use immutable Preset `parameters` with the deterministic forge-v1 template engine.
- Apply deterministic regex transforms to outgoing prompts or finalized assistant messages.
- Edit Presets and profiles in a local browser UI and inspect the exact provider payload.
- Inspect prompt changes in the Preview dock: **Preview** compiles the live draft, **Draft diff** compares unsaved edits with disk, and **Run diff** compares recent provider turns. Git-style unified/split views include old/new line numbers, inline highlights, and changes-only/three-line/all-line context. Run metadata keeps chars/4 estimates separate from Pi's provider-reported prompt/cache usage and real cache-hit rate.
- Run an explicitly enabled profile as an experimental, approval-gated foreground subagent.

## Install

pi-forge requires Node.js 22.19 or newer.

```bash
pi install npm:@zihanw/pi-forge
```

Restart Pi after installing or updating the extension. Pi supplies its SDK packages to extensions at runtime; pi-forge keeps exact Pi versions only for reproducible development and tests. See [compatibility and setup](docs/development/setup.md#pi-compatibility) for the supported/tested policy.

## Five-minute start

### 1. Create a Preset

Create the `default` Preset from [the default Pi mirror](examples/default-prompt-stack.json). The compatibility storage path remains `.pi/forge/prompt-stacks/default.json` in 0.5.3:

```bash
mkdir -p .pi/forge/prompt-stacks
cp examples/default-prompt-stack.json .pi/forge/prompt-stacks/default.json
```

If you installed from npm rather than cloning this repository, open `/preset ui` and create a new Preset; the editor starts with the same Pi-mirror layout.

Restart Pi or run:

```text
/preset reload
/preset use default
```

`default.json` auto-activates when no Preset or restored session selection takes precedence.

### 2. Open the visual editor

```text
/preset ui
```

The local editor can create, fork, validate, preview, import, export, and delete Presets. Its **Agent profiles** view manages one-shot model/thinking/Preset bundles. Writes require a trusted project. When `@zihanw/pi-forge-subagents` is installed, its schema-driven editor appears on the separate top-level **Settings** surface and persists to the optional package's `subagents.json` files.

### 3. Save a profile

Configure Pi normally, then capture and reuse the current settings:

```text
/profile save reviewer
/profile use reviewer
```

A profile applies once. Later manual changes to the model or thinking level remain in effect until the profile is applied again; an active Preset continues enforcing its tool policy.

## The basic model

A **Preset** is one JSON document. Its ordered composition section is the **Stack**:

| Stack item | Purpose |
|---|---|
| **Block** | Static `system`, `user`, `assistant`, or hidden `custom` text |
| **Slot** | Runtime content such as tools, skills, project context, date/cwd, or chat history |

The Preset also carries system mode (`replace`, `append`, or `prepend`), tool/skill policy, Regex, parameters, and extension references. During compilation, pi-forge expands the Stack, compiles forge-v1 templates over `runtime.*` / `parameters.*` / `extensions.*`, enforces tool policy, filters its skill listing, and applies enabled Regex rules.

Agent profiles reference an exact provider/model, thinking level, and Preset. They intentionally do not duplicate tool or skill policy—the referenced Preset remains the source of truth.

> **0.5.3 compatibility note.** User-facing terminology now follows Preset → Stack. Storage and schema identifiers remain backward-compatible in this patch: `.pi/forge/prompt-stacks/`, `"pi-forge.prompt-stack"`, profile field `promptStack`, `/api/stacks`, and internal `PromptStack` type names are unchanged. See the [roadmap](docs/development/roadmap.md) for the later storage/schema migration.

Start with these examples:

- [Default Pi mirror](examples/default-prompt-stack.json) keeps normal Pi behavior while making its sections movable.
- [Minimal worker](examples/minimal-prompt-stack.json) borrows the DeepSeek Harness Minimal shape using stock Pi tools: the exact one-line persona, chat history, and only `bash` plus `edit`, without replicating DSH shell/editor semantics.
- [Regex hack pack](examples/hack-prompt-stack.json) demonstrates request-frequency outgoing redaction plus transcript-finalize scrubbing for two illustrative token shapes; it is not an exhaustive secret scanner.
- [Custom system-status extension](examples/custom-system-status-extension/README.md) registers a trusted macro and slot.
- [Fake-assistant direct-output experiment](examples/fake-assistant-direct-output-prompt-stack.json) appends ordinary assistant text after chat history to test a model-specific reasoning shortcut; support varies by model/provider/endpoint and must be verified with an A/B run.

## Common commands

| Command | Purpose |
|---|---|
| `/preset ui [stop\|restart]` | Open or manage the web editor |
| `/preset list` | List Presets |
| `/preset use <id\|none>` | Select or disable a Preset |
| `/preset preview [id]` | Compile a Preset without sending a request |
| `/preset validate [id]` | Validate one Preset or all Presets |
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
