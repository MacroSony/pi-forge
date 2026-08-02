# Getting started

[Documentation](README.md) · [中文](zh-CN/getting-started.md)

## Requirements and installation

pi-forge requires Node.js 22.19 or newer and runs as a Pi extension.

```bash
pi install npm:@zihanw/pi-forge
```

Restart Pi after installing or updating. The running Pi host supplies its SDK packages; see [Pi compatibility](development/setup.md#pi-compatibility) for the tested-version policy.

Project stacks, profiles, and configuration are loaded only after Pi trusts the project.

## Create your first stack

Prompt stacks live in `.pi/forge/prompt-stacks/*.json`. The quickest baseline is [the default Pi mirror](../examples/default-prompt-stack.json), which preserves normal Pi behavior while splitting its prompt into movable sections.

In a repository clone:

```bash
mkdir -p .pi/forge/prompt-stacks
cp examples/default-prompt-stack.json .pi/forge/prompt-stacks/default.json
```

When installed from npm, open `/preset ui` and create a stack; new stacks start from the same mirror layout.

Reload and activate it:

```text
/preset reload
/preset use default
```

If no restored session selection or explicit opt-out takes precedence, `default.json` auto-activates. Set `"autoActivate": false` to prevent that behavior.

## Edit and inspect

```text
/preset ui
```

The editor opens on a token-protected `127.0.0.1` URL. It supports structured and raw JSON editing, drag-and-drop ordering, validation, exact preview, policy selection, regex rules, import/export, fork, and profile management. See the [web-editor guide](guides/web-editor.md).

To inspect without opening a browser:

```text
/preset validate default
/preset preview default
/preset diagnostics
```

## Create a profile

Select the model, thinking level, and prompt stack you want in Pi, then save them:

```text
/profile save reviewer
/profile preview reviewer
/profile use reviewer
```

Profiles live in `.pi/forge/agent-profiles/*.json`. Applying one is a preflighted, one-shot operation: later manual model/thinking changes remain until you apply the profile again. Read [agent-profile concepts](concepts/agent-profiles.md) for validation, auto-activation, and drift semantics.

## Storage and migration

| Location | Purpose |
|---|---|
| `.pi/forge/prompt-stacks/` | Project prompt stacks |
| `.pi/forge/agent-profiles/` | Project agent profiles |
| `.pi/forge/config.json` | Trusted project configuration and delegation authorization |
| `.pi/forge/extensions/` | Trusted project macro/slot registration code |
| `~/.pi/forge/config.json` | User defaults |
| `~/.pi/forge/extensions/` | Trusted user macro/slot registration code |

Legacy `.pi/prompt-stacks/*.json` files remain readable. New stacks go to `.pi/forge/prompt-stacks`, and same-named new-location files shadow legacy ones. Migrate safely with:

```text
/preset migrate-stacks --dry-run
/preset migrate-stacks
```

Add `--overwrite` only when target replacement is intended. Add `--delete-legacy` only after checking the copied files.

## Where to go next

- Learn the [prompt-stack model](concepts/prompt-stacks.md).
- Fork a [focused reviewer](../examples/reviewer-prompt-stack.json) or [DM writer](../examples/sillytavern-dm-writer-prompt-stack.json).
- Use the [SillyTavern importer](guides/sillytavern-import.md).
- Learn [macros and slots](reference/macros-and-slots.md).
- Inspect the [complete commands](reference/commands.md) and [stack schema](reference/stack-schema.md).
