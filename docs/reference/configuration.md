# Configuration reference

[Documentation](../README.md)

Project configuration lives in `.pi/forge/config.json` and is loaded only for a trusted project. User defaults live in `~/.pi/forge/config.json`.

## Web editor

```json
{
  "webEditor": {
    "port": 41738,
    "locale": "auto"
  }
}
```

The port is preferred, not guaranteed. The editor binds only to `127.0.0.1` and chooses another available port when necessary.

`webEditor.locale` selects the editor's interface language: `"en"`, `"zh-CN"`, or `"auto"` (default). `"auto"` follows the browser language. The language selector in the editor's top bar writes this setting; `"auto"` removes the key.

## Experimental subagents

Subagent configuration is owned by the optional `@zihanw/pi-forge-subagents` package. Dedicated files are `.pi/forge/subagents.json` for a trusted project and `~/.pi/forge/subagents.json` for user defaults. Legacy `.pi/forge/config.json` / `~/.pi/forge/config.json` `subagents` sections are read-only fallback material and emit a warning.

User defaults may set general settings:

```json
{
  "backend": "pi-subprocess-readonly",
  "timeoutMs": 60000
}
```

Trusted project `subagents.json` may override defaults, authorize individual project profile IDs, and authorize unattended model invocation:

```json
{
  "backend": "pi-subprocess-readonly",
  "timeoutMs": 60000,
  "allowAgentInvocationWithoutApproval": false,
  "summaryInToolDescription": false,
  "profiles": {
    "project:reviewer": {
      "enabled": true,
      "backend": "pi-rpc-readonly",
      "timeoutMs": 180000
    }
  }
}
```

Valid timeouts are 1,000–3,600,000 ms. Invalid fields warn and fall back to the preceding applicable default. General backend precedence is project then user then built-in; an interactive run and a project profile entry can further override it as described in [delegation](../guides/delegation.md#backends-and-precedence).

`summaryInToolDescription` (default `false`) embeds a compact, bounded summary of enabled subagent profiles directly in the `forge_subagent` tool description so the parent model can pick a profile without a discovery call. Ready profiles appear first, and unavailable enabled profiles include their first resolution error. It may be set in user or trusted-project `subagents.json` and applies wherever it is enabled.

Profile authorization keys should use canonical selectors: `project:<id>` or `global:<id>`. A bare key is a compatibility spelling for `project:<id>` regardless of which config file contains it; it never authorizes a global profile. Therefore a global profile must be written explicitly as `"global:reviewer": { "enabled": true }` in `~/.pi/forge/subagents.json`. Same-ID profiles never inherit enablement, backend, or timeout policy from each other. `allowAgentInvocationWithoutApproval` is project-only, requires trust, and fails closed when malformed. Deleting a profile does not modify `subagents.json`; remove any enabled entry for the deleted profile manually.

Treat project configuration as an authorization boundary. In particular, do not commit unattended delegation unless every permitted parent agent may transmit compiled prompt and readable project content without another human approval.

## Trusted registration directories

These are code-loading locations rather than JSON fields:

- `~/.pi/forge/extensions/` loads trusted user macro/slot registrations.
- `.pi/forge/extensions/` loads trusted project registrations after project trust.

See [custom macros and slots](../guides/custom-macros-and-slots.md).
