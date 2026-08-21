# Agent profiles

[Documentation](../README.md) · [中文](../zh-CN/concepts/agent-profiles.md)

An agent profile is a project-local, schema-versioned preset that references one exact model, thinking level, and prompt stack. It is deliberately small and portable.

## Schema

Profiles live in `.pi/forge/agent-profiles/*.json` (project scope) or `~/.pi/forge/agent-profiles/*.json` (global scope). Commands accept `reviewer`, `project:reviewer`, and `global:reviewer`; a project profile shadows a same-ID global profile for unqualified lookups. A profile's `promptStack` reference resolves relative to the profile's own scope: a project profile may reference its own project stack by bare ID or a global stack as `global:<id>`; a global profile may only reference global stacks.

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

`promptStack` may be `null`. Unsupported fields are errors: generation settings, tools, skills, backend selection, and runner policy are intentionally not profile-v1 data. The referenced prompt stack is the sole source of tool policy and model-visible skill filtering.

## Capture and application

```text
/profile save reviewer
/profile preview reviewer
/profile use reviewer
```

Save captures the current provider/model, thinking level, and stack without secrets, history, tools, or provenance. `--overwrite` is required to replace an existing file; existing display metadata is preserved.

Application is transactional and one-shot. pi-forge first validates the profile, model, configured authentication, thinking-level support, prompt stack, and tool allow patterns. It changes nothing when preflight fails. If an application step fails, it attempts rollback and does not record successful provenance.

After a successful application, later manual changes are respected. The profile does not continuously own model or thinking state, although the selected prompt stack continues enforcing its policy.

## Auto-activation

At most one profile may set `autoActivate: true`. It applies once when Pi starts a fresh session and takes precedence over standalone prompt-stack autoload, including when `promptStack` is `null`.

Restored branch selections take precedence over auto-activation. Invalid or ambiguous profile auto-activation fails closed: pi-forge will not partially apply it or silently fall back to a stack.

## Provenance and drift

`/profile status` compares the current runtime with the last-applied resolved snapshot. It reports source-definition changes separately from runtime drift in model, thinking level, or stack.

Provenance is branch-scoped status metadata, not ownership. Reload, resume, tree navigation, and compaction never reapply a profile. `/profile forget` removes provenance without changing runtime state.

## Delegation is separate

Ordinary profiles cannot be delegated by default. Delegation authorization is owned by the optional `@zihanw/pi-forge-subagents` package in dedicated files, using canonical `project:<id>` or `global:<id>` keys with per-profile backend/timeout overrides. Bare authorization keys are project-only compatibility aliases regardless of file location. The main package reads no subagent configuration, and deleting a profile does not touch `subagents.json`.

Read the [experimental delegation guide](../guides/delegation.md) before enabling it.
