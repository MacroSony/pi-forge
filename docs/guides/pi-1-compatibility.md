# Pi 1.0 compatibility

[Documentation](../README.md) · [简体中文](../zh-CN/guides/pi-1-compatibility.md)

## Forge 0.5.8 versus older packages

This guide covers the **Forge 0.5.8** compatibility patch. Installing the older `@zihanw/pi-forge@0.5.7` does not install these changes: that artifact still declares Pi peers `>=0.87.0 <0.88.0`.

Forge 0.5.8 declares the following peer policy for the four Pi SDK packages:

```text
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || 1.0.0
```

Minimum Pi remains 0.87.0. Development pins are Pi 1.0.0 and `typebox@1.3.27`. The SDK packages and TypeBox remain host-provided optional peers, not private runtime dependencies. Other intermediate or future host versions are not implicitly supported.

This patch changes dependency/test coverage and documentation, **not** tool authorization, Capability ownership, usage aggregation, or personal configuration.

## Native MCP: migrate exact names deliberately

Pi 0.99.2+ normalizes native MCP names, for example `mcp__demo-server__ping` becomes `mcp__demo_server__ping`. Same-server tool collisions such as `a-b` and `a_b` receive hash suffixes; conflicting normalized server names are rejected.

Check all exact names in allow/deny, initial, Capability add/remove, scripts and saved loadouts:

- An unregistered Capability **add** is rejected. An old initial name may be omitted, and an old exact allow entry will not allow the new name.
- **Old exact deny/remove names may simply stop matching the renamed tool.** Do not assume every stale name fails closed. Review restrictions as carefully as additions.
- Inspect the live registered catalog after servers connect: use the Web editor's refreshed tool picker or extension API `pi.getAllTools()`. The active list alone omits inactive/deferred tools.
- Explicitly confirm each old-to-new mapping, including collision hashes, before updating configurations. Forge does not guess aliases or apply blanket hyphen replacement.

These rules concern **native MCP**, not third-party adapters such as `pi-mcp-adapter` 2.x. This patch does not migrate adapter configuration or rewrite existing resources.

## Discovery and delayed registration

Default native MCP servers now connect in the background without blocking the first prompt; `direct` exposure has different startup behavior. Default tools are registered with deferred exposure, omitted from codemode's description, and discovered using `searchTools()` / `describeNamespace()`. Discovery does not grant a Forge Capability or override its policy.

Pi 1.0 improves deferred-tool restoration on resume/reload. Forge still requires Capability additions to be registered before activation; when a server is late, wait for registration and retry the intended action. Reload alone is not a guaranteed remedy. Explicit policy sync can replace a restored host loadout, so do not assume pending tools must always reactivate. Full slow-MCP resume/reload behavior needs integration validation, not just catalog-mock tests.

Forge preserves foreign System sections such as `mcp_servers`, including updates and removals. Upstream section updates can change later prompts; this is not a cache-hit guarantee.

## Codemode boundaries remain unchanged

Pi 1.0 throws when scripts read missing `tools` properties. Use `"name" in tools`, not `typeof tools.name`, to test existence.

`tools.initial` is a default loadout, **not an enabled-membership execution gate**. Registered deferred/codemode tools permitted by the Preset can remain callable through nested codemode even when omitted from initial or after their adding Capability is disabled. Preset allow **or** deny policy and active Capability removes still apply; direct calls also depend on the host's active loadout. This patch does not change those semantics or make discovery authorization-aware.

`models.generateImages()` (new in 1.0) and `models.classify()` (since 0.99) call the session model registry, not `ctx.executeTool()` / `tool_call`. Disabling image tools does **not** disable these model APIs. Pi settings have no `models: false` toggle; the SDK factory `createCodemodeExtension({ models: false })` requires explicit programmatic extension assembly.

Pi accounts for reported codemode model usage. Forge's cache display still separates assistant usage from explicit `details.forgeNestedUsage`; it does not newly aggregate arbitrary native tool/model usage. Do not add both receipts without deduplication.

## TUI and optional packages

Pi 1.0 defaults to fullscreen. To retain ordinary terminal scrollback, set `"tuiMode": "regular"` in Pi settings or use `pi --tui-mode regular`. This does not change Forge's Web UI.

Removing the experimental agent-core harness does not remove the coding-agent `AgentSession` used by our companion runtime. `pi-durable` is still explicitly experimental; this patch does not adopt it or add cross-restart continuation.

Published subagents 0.5.3 does not support `tools.initial`. Its pending feature release can include Pi 1.0 adaptation, but requires its own runtime artifact/floor, TypeBox peer cleanup, bwrap `/tmp` launcher fix, packed tests and approval. Main Forge releases independently; main+optional import smoke does not certify the pending continuation/background features. See [host-port compatibility](../reference/subagent-host-port.md#tool-selection-compatibility).

## Verification

```bash
# Override both when testing a different host than the installed development SDK.
PI_TEST_VERSION=0.87.0 TYPEBOX_TEST_VERSION=1.3.7 npm run check:packed
PI_TEST_VERSION=1.0.0 TYPEBOX_TEST_VERSION=1.3.27 npm run check:packed
```

Without overrides, packed checks use the coherent installed SDK family and its declared TypeBox version, not a hardcoded historical pin. Both consumers use normal npm peer resolution and check the installed versions. An optional sibling, when present, uses its declared runtime dependency; this is not a test of an unreleased local runtime.

Ordinary Linux/macOS/Windows CI uses pinned Pi 1.0.0; explicit older compatibility lanes and scheduled latest-Pi probes run on Linux. Exact-release CI remains a release gate, not a claim that this source patch has already passed remote or real-provider testing.
