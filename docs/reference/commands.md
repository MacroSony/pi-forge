# Command reference

[Documentation](../README.md) · [中文](../zh-CN/reference/commands.md)

Arguments in brackets are optional. Main pi-forge command arguments are strict: unknown flags and extra arguments are rejected. Commands that write project files require a trusted project.

## Forge commands

`/forge` is the canonical root. With no arguments it opens Forge command help; `/forge help` does the same.

| Command | Behavior |
|---|---|
| `/forge ui [stop\|restart]` | Open, stop, or explicitly restart the local web editor. |
| `/forge payload next [save=<path> [--overwrite]]` | Arm capture of the next provider-hook payload, display it, and optionally save it. Quote paths containing spaces, for example `save="path with spaces.json"`. |
| `/forge payload status` | Show whether a capture is pending and whether a latest capture exists. |
| `/forge payload cancel` | Cancel only the pending next-capture request. It does not delete or reset retained captures or context-diff history. |
| `/forge payload help` | Show payload syntax and capture boundaries. |
| `/forge subagent plan ...` | Optional execution-plan command supplied by the matching `@zihanw/pi-forge-subagents` package. Duplicate contributors fail closed. |

`/forge payload` and bare `/payload` both arm the next capture. `/intercept` remains a compatibility shortcut for the same arm-without-save operation. A save never overwrites an existing file unless `--overwrite` is present; `--overwrite` is valid only with `save=<path>`; an armed capture does not call a model. Capture is taken at `before_provider_request`, so later plugin shaping may change the final wire body. Saved payloads may contain prompt and conversation text even when credential-shaped fields are redacted.

The legacy `/subagent` command is a separate low-level smoke helper. It is not the actual `/forge subagent plan` execution-plan command.

## Prompt presets

| Command | Behavior |
|---|---|
| `/preset list` | List presets and activation/validation state. |
| `/preset status` | Show the selected preset and diagnostics summary. |
| `/preset use <id>` | Validate and select a preset. |
| `/preset use none` | Disable prompt presets for this session branch. `disable` is accepted as an alias. |
| `/preset preview [id]` | Compile and display a preset without provider transport. Defaults to the selected preset. |
| `/preset validate [id]` | Validate the selected preset when omitted, or one named preset when supplied. It does not validate every preset by default. |
| `/preset diagnostics` | Show loader, runtime, policy, regex, and trusted-extension diagnostics. |
| `/preset reload` | Reload presets and trusted macro/slot registrations. |
| `/preset ui [stop\|restart]` | Compatibility lifecycle entry for the local web editor; prefer `/forge ui`. |
| `/preset help` | Show preset command help. |

## Storage migration

| Command | Behavior |
|---|---|
| `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` | Copy legacy `.pi/prompt-stacks` files into `.pi/forge/prompt-stacks`. |

Use migration dry runs before overwriting or deleting anything.

## Agent profiles

| Command | Behavior |
|---|---|
| `/profile list` | List project profiles and resolution diagnostics. |
| `/profile use <id>` | Preflight and apply a profile once. |
| `/profile save <id> [--overwrite]` | Capture the current model, thinking level, and preset. |
| `/profile status` | Compare current runtime with last-applied branch provenance. |
| `/profile preview <id>` | Resolve model/auth/thinking/preset/tools without applying. |
| `/profile validate [id]` | Validate all loaded profiles when omitted, or one named profile when supplied. |
| `/profile reload` | Reload definitions without applying them. |
| `/profile forget` | Remove last-applied provenance without changing runtime state. |
| `/profile help` | Show profile command help. |

## Capabilities

`/capability` is the command for managing session capabilities.

| Command | Behavior |
|---|---|
| `/capability add <text>` | Add a literal manual instruction. |
| `/capability list` | Explicitly reload and list the capability library. |
| `/capability bindings` | List bindings on the active preset, including human-only bindings (`modelCallable: false`). |
| `/capability enable <[scope:]id>` | Enable an unbound library capability. |
| `/capability enable-bound <id>` | Enable a binding from the active preset. |
| `/capability disable <activation-id>` | Disable one active capability. |
| `/capability status` | Show active capabilities and effective tools. |
| `/capability reset` | Disable all active capabilities and manual directives. |
| `/capability help` | Show usage and compatibility notes. |

Completions use the current session and last published workspace snapshot. They do not scan resources on every keystroke. Use `/capability list` for an explicit discovery refresh. Human-only bindings remain visible in `bindings`; `modelCallable: false` only prevents Agent control.

## Optional foreground delegation

The following commands are supplied by the matching optional `@zihanw/pi-forge-subagents` package, not by main pi-forge:

| Command | Behavior |
|---|---|
| `/forge-agent backends` | List registered backends, capabilities, and effective defaults. |
| `/forge-agent plan <profile> [--backend <id>] <task>` | Prepare, display, and discard an exact plan without provider transport. |
| `/forge-agent run <profile> [--backend <id>] <task>` | Prepare a foreground run, always ask for human approval, then execute through the selected backend. A backend may write; this is not inherently read-only. |

Only explicitly scoped profiles are accepted by the optional package: use `project:<id>` or `global:<id>` keys in its `subagents.json`. The model-callable equivalents are `forge_subagent_profiles` (local discovery) and `forge_subagent` (execution). The model-callable `forge_subagent` tool is a separate path. Its unattended behavior is controlled by explicit trusted-project authorization; it is not a way to bypass the approval requirement of `/forge-agent run`. See the [delegation safety guide](../guides/delegation.md).
