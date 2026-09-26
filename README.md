# pi-forge

[English](README.md) | [简体中文](README.zh-CN.md) · [Documentation](docs/README.md) · [Quick start](#install-and-first-run)

![pi-forge - Context editor and inspection workbench for Pi](assets/pi-forge-header-concept-1.png)

**A context editor and inspection workbench for Pi.**

pi-forge provides visual context composition, tool selection, reusable configurations, and request inspection for [Pi](https://github.com/earendil-works/pi).

> Inspired by SillyTavern’s presets, I built pi-forge to customize both what goes into an agent’s context and how it is assembled—and inspect what actually reaches the model.

[Context composition](#context-composition) · [Tool selection](#tool-selection) · [Regex transformations](#regex-transformations) · [Instruction modes](#dynamic-system-prompts-and-tools) · [Request inspection](#preview-and-request-inspection)

> **Optional subagents**: [pi-forge-subagents](https://github.com/MacroSony/pi-forge-subagents) — Delegate tasks to agents with their own model and preset.

## Install and first run

Requires Node.js **22.19 or newer**. The 0.5.5 line supports Pi **0.87.x** (`>=0.87.0 <0.88.0`), tested with **0.87.0**.

<!-- RELEASE NOTE: remove this block when 0.5.5 is published; keep the install command below. -->
> **0.5.5 is not published yet.** Instruction modes and configurable default tools currently require the local development build. The npm install command below still installs 0.5.4, whose features and Pi requirements differ. For a local build, see [development setup](docs/development/setup.md#load-the-extension).
<!-- END RELEASE NOTE -->

```bash
pi install npm:@zihanw/pi-forge
```

Restart Pi after installing or updating. In a trusted project:

1. Run `/forge ui` to open the local editor.
2. Choose **New preset** to start from the default Pi-mirror layout.
3. Edit a block or policy and check **Preview**.
4. **Save** your changes, then **Activate** the Preset for the current session.

Prefer the terminal? Select a Preset with `/preset use <id>` and enable a Mode with `/instruction use <mode>`. Try the [Read-first Worker example](docs/reference/instruction-modes.md#read-first-worker) yourself.

## Features

### Context composition

Build your agent’s context from editable text blocks and slots for tools, skills, project files, and conversation history. Reorder or toggle them and see the result in Preview.

- **Use case**: Give a code-review agent your project guidelines and selected context, instead of keeping one oversized prompt for every task.
- **Try it**: In the editor’s **Stack**, edit or drag a block, toggle project context, and check **Preview**.

![Drag system blocks to reorder them, then toggle project context; Preview follows](assets/readme/en/context-composition.gif)

See [Web editor guide](docs/guides/web-editor.md) and [Stack schema](docs/reference/stack-schema.md).

### Tool selection

Choose which tools an agent may use and which are available by default. An allowlist or denylist sets the permission limit; a smaller default set keeps other permitted tools available for Modes to enable later.

- **Use case**: Keep a review agent focused on reading and searching, without giving it editing or shell tools.
- **Try it**: In **Policy**, choose the permitted tools and a default set such as `read` and `ls`. Add the already-permitted `grep` to the defaults and check the tool list in **Preview**; save and activate to apply the policy.

![Tool selection with policy defaults read/ls and adding grep](assets/readme/en/tool-selection.gif)

See [Tool policy reference](docs/reference/stack-schema.md#tool-and-skill-policy).

### Regex transformations

Find and replace text in model input or completed assistant/tool output using reusable regex rules.

- **Use case**: Replace a known sensitive marker in selected prompt text before sending it, or clean repetitive boilerplate from responses.
- **Try it**: In **Regex**, set up an outgoing rule matching the synthetic `SAMPLE_TOKEN`, replacing it with `[REDACTED]`, and targeting system text. The demo toggles this preconfigured rule and compares **Preview**.

![Regex transformation redacting outgoing synthetic SAMPLE_TOKEN](assets/readme/en/regex-transforms.gif)

See [Regex transformation reference](docs/reference/stack-schema.md#regex-transforms).

### Dynamic system prompts and tools

**Instruction modes** update system instructions and available tools mid-conversation. Start an agent with minimal tools, then let it load task-specific instructions and tools when needed—without restarting the session or switching Presets.

- **Use case**: Let an agent explore code with `read` and `ls`, then enable an authorized editing Mode when it is ready to apply a fix.
- **Try it**: Create a Mode in **Modes** and authorize agent access in the Preset’s **Bindings** tab. You can also enable it yourself in **Current session** or with `/instruction use <mode>`, and inspect the resulting instructions and tools.

Updates reach the model as native mid-conversation system updates on supported models, with a labeled user-message fallback otherwise (see [delivery details](docs/reference/instruction-modes.md#delivery-models-native-vs-fallback)).

![Use and locate Explore mode: tools and instruction changes together; Off restores read and projects a removal](assets/readme/en/mode-tools.gif)

See [Instruction modes reference](docs/reference/instruction-modes.md).

### Preview and request inspection

See what your edits change before calling a model, then inspect captured requests and reported usage when debugging a run.

- **Use case**: Check whether a prompt edit adds the intended instructions, or compare successive requests when a run behaves differently than expected.
- **Try it**: In `/forge ui`, switch to **Preview** to view compiled messages, open **Draft diff** to see unsaved changes, or run `/forge payload next` in the terminal to inspect the next outgoing request.

![An unsaved instruction change compared with the saved Preset](assets/readme/en/edit-draft-diff.gif)

**Current session** also shows turn and branch cache-hit rates, with main-model and reported nested-tool usage kept separate. These are recorded usage metrics, not a complete bill. See [cache usage](docs/reference/session-cache.md), [debugging](docs/guides/debugging.md), and [commands](docs/reference/commands.md).

## Examples

- [Default Pi mirror](examples/default-prompt-stack.json) — A Pi-style starting point, split into editable blocks and runtime slots.
- [Minimal worker](examples/minimal-prompt-stack.json) — One line of instructions, chat history, and only `bash` plus `edit`.
- [Read-first Worker](examples/read-first-worker-prompt-stack.json) + [Write tools mode](examples/instruction-modes/write-tools.json) — Start with `read`, `ls`, and the mode control tool; let the model enable `bash`/`edit` on demand. [Setup and limits](docs/reference/instruction-modes.md#read-first-worker).
- [Regex examples](examples/hack-prompt-stack.json) — Outgoing redaction paired with stored-transcript cleanup for two sample token patterns.

Save your current model, thinking level, and Preset as an Agent Profile with `/profile save reviewer`; restore it with `/profile use reviewer`. See [patterns and use cases](docs/guides/use-cases.md) for more ideas.

## Optional subagents

The optional companion [`pi-forge-subagents`](https://github.com/MacroSony/pi-forge-subagents) package lets your agent delegate focused tasks—such as a code review or parallel investigation—to subagents configured with authorized Profiles. The agent uses `forge_subagent` to delegate; Forge itself does not require this package.

Use matching local development sources pending coordinated release. Subagents operate with backend-dependent write permissions and isolation (tool restrictions alone are not an OS sandbox). See the [delegation guide](docs/guides/delegation.md) before enabling delegation.

## Notes and documentation

- This is a **0.x** project; releases may introduce breaking changes.
- `replace` mode replaces Pi's base system prompt. Include any tool guidance, skills, or project context you still want.
- Skill filtering only changes Forge's rendered listing; it does not disable explicit skill invocation. Tool policy is not filesystem or process isolation.
- Regex only handles the text and patterns you select. `finalize` overwrites stored assistant/tool-result text and does not preserve the original. Payload captures are redacted and may be truncated; they can still contain private conversation content.
- For stack structure, resource schemas, and command details, see the documentation links below.

[Getting started](docs/getting-started.md) · [Web editor](docs/guides/web-editor.md) · [Commands](docs/reference/commands.md) · [Schema and policy](docs/reference/stack-schema.md) · [Debugging](docs/guides/debugging.md) · [All documentation](docs/README.md)

## License

[MIT](LICENSE)
