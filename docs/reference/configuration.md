# Configuration reference

[Documentation](../README.md)

Project configuration lives in `.pi/forge/config.json` and is loaded only for a trusted project. User defaults live in `~/.pi/forge/config.json`.

## Web editor

```json
{
  "webEditor": {
    "port": 41738
  }
}
```

The port is preferred, not guaranteed. The editor binds only to `127.0.0.1` and chooses another available port when necessary.

## Experimental subagents

User configuration may set general defaults:

```json
{
  "subagents": {
    "backend": "pi-subprocess-readonly",
    "timeoutMs": 60000
  }
}
```

Trusted project configuration may override defaults, authorize individual project profile IDs, and authorize unattended model invocation:

```json
{
  "subagents": {
    "backend": "pi-subprocess-readonly",
    "timeoutMs": 60000,
    "allowAgentInvocationWithoutApproval": false,
    "profiles": {
      "reviewer": {
        "enabled": true,
        "backend": "pi-rpc-readonly",
        "timeoutMs": 180000
      }
    }
  }
}
```

Valid timeouts are 1,000–3,600,000 ms. Invalid fields warn and fall back to the preceding applicable default. General backend precedence is project then user then built-in; an interactive run and a project profile entry can further override it as described in [delegation](../guides/delegation.md#backends-and-precedence).

`subagents.summaryInToolDescription` (default `false`) embeds a compact, bounded summary of enabled subagent profiles directly in the `forge_subagent` tool description so the parent model can pick a profile without a discovery call. Ready profiles appear first, and unavailable enabled profiles include their first resolution error. It may be set in user or trusted-project configuration and applies wherever it is enabled.

`profiles` in global configuration warns and is ignored. `allowAgentInvocationWithoutApproval` is project-only, requires trust, and fails closed when malformed. Deleting a profile also clears its effective delegation policy.

Treat project configuration as an authorization boundary. In particular, do not commit unattended delegation unless every permitted parent agent may transmit compiled prompt and readable project content without another human approval.

## Trusted registration directories

These are code-loading locations rather than JSON fields:

- `~/.pi/forge/extensions/` loads trusted user macro/slot registrations.
- `.pi/forge/extensions/` loads trusted project registrations after project trust.

See [custom macros and slots](../guides/custom-macros-and-slots.md).
