# Prompt and payload debugging

[Documentation](../README.md)

## Validate and preview

```text
/preset validate [id]
/preset preview [id]
/preset status
/preset diagnostics
```

Validation checks schema shape, item IDs, slots, policy, regex rules, custom dependencies, and activation conflicts. Preview compiles without sending a provider request. Diagnostics includes runtime policy, regex activity, extension modules, and load failures.

The web editor provides the same validation plus a full visual preview and source-aware resources.

## Inspect the next provider payload

```text
/payload next
/payload next save=.pi/forge/payloads/last.json
```

Or open `/preset ui`, click **Arm payload**, then send the next Pi prompt. Credential-shaped token fields are redacted; normal request limits and accounting fields such as `max_tokens`, `input_tokens`, and `output_tokens` remain visible.

`/intercept` is the compact command for showing the next provider payload.

Saved payloads can contain prompt and conversation content. Keep them out of version control unless deliberately sanitized.

## Common checks

- Unexpected duplicate task: set the `chat-history` slot's `includeLastUserMessage` to `false` when a later block uses `{{lastUserMessage}}`.
- Missing tool: inspect stack `allow`/`deny` policy and `/preset status`; the tool-call guard enforces the selected stack even if another extension modifies active tools.
- Skill still visible: use `replace` mode when Pi's base prompt must not include its own skill listing.
- Missing custom slot: trust the project, check `.pi/forge/extensions`, reload, and inspect diagnostics.
- Changed profile source: `/profile status` distinguishes source-definition changes from manual runtime drift.
- Delegation unavailable: use `/forge-agent backends`, `/profile preview`, and `forge_subagent_profiles` metadata before provider execution.
- Provider authentication works in the parent but not the child: restart after updating Pi or pi-forge and confirm the installed extension/runtime versions are not stale.
