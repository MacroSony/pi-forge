# Command reference

[Documentation](../README.md) · [中文](../zh-CN/reference/commands.md)

Arguments in brackets are optional. Commands that write project files require a trusted project.

## Prompt stacks

| Command | Behavior |
|---|---|
| `/preset list` | List stacks and activation/validation state. |
| `/preset status` | Show the selected stack and diagnostics summary. |
| `/preset use <id>` | Validate and select a stack. |
| `/preset use none` | Disable prompt stacks for this session branch. `off` is accepted as an alias. |
| `/preset preview [id]` | Compile and display a stack without provider transport. Defaults to the selected stack. |
| `/preset validate [id]` | Validate one stack or all stacks when omitted. |
| `/preset diagnostics` | Show loader, runtime, policy, regex, and trusted-extension diagnostics. |
| `/preset reload` | Reload stacks and trusted macro/slot registrations. |
| `/preset ui [stop\|restart]` | Open, stop, or replace the local web editor. |

## Storage migration and import

| Command | Behavior |
|---|---|
| `/preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]` | Copy legacy `.pi/prompt-stacks` files into `.pi/forge/prompt-stacks`. |
| `/preset import-silly <path> [character_id] [--dry-run] [--overwrite]` | Convert a SillyTavern preset and write a migration report. |

Use migration/import dry runs before overwriting or deleting anything. See [SillyTavern import](../guides/sillytavern-import.md).

## Agent profiles

| Command | Behavior |
|---|---|
| `/profile list` | List project profiles and resolution diagnostics. |
| `/profile use <id>` | Preflight and apply a profile once. |
| `/profile save <id> [--overwrite]` | Capture the current model, thinking level, and stack. |
| `/profile status` | Compare current runtime with last-applied branch provenance. |
| `/profile preview <id>` | Resolve model/auth/thinking/stack/tools without applying. |
| `/profile validate [id]` | Validate one profile or all profiles when omitted. |
| `/profile reload` | Reload definitions without applying them. |
| `/profile forget` | Remove last-applied provenance without changing runtime state. |

## Experimental foreground delegation

| Command | Behavior |
|---|---|
| `/forge-agent backends` | List registered experimental backends, capabilities, and effective defaults. |
| `/forge-agent plan <profile> [--backend <id>] <task>` | Prepare, validate, display, and discard an exact plan without provider transport. |
| `/forge-agent run <profile> [--backend <id>] <task>` | Review and approve an exact foreground read-only run. |

Only project-authorized delegation profiles are accepted. The model-callable equivalents are `forge_subagent_profiles` (local discovery) and `forge_subagent` (execution). See the [delegation safety guide](../guides/delegation.md).

## Payload inspection

| Command | Behavior |
|---|---|
| `/intercept` | Display the next redacted provider payload. |
| `/payload next [save=<path>]` | Display the next payload, optionally save it, and expose it to the web editor. |

Saved payloads may include prompt and conversation text even though credential-shaped fields are redacted. Handle them as potentially sensitive.
