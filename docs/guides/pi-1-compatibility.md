# Pi 1.0 compatibility

[Documentation](../README.md) · [简体中文](../zh-CN/guides/pi-1-compatibility.md)

## Forge 0.5.10 (Unreleased): Pi 1.4

Development SDKs are pinned to **1.4.0** and the four optional SDK peers expand to:

```text
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.5.0
```

Minimum Pi 0.87.0 and `typebox@1.3.27` remain unchanged; Pi 1.5+ and other 0.x hosts are not implicitly supported. Ordinary CI and normal packed consumers use 1.4.0; historical compatibility lanes retain 1.3.0 and all existing versions. Forge 0.5.10 also adds the execution gate and namespace authorization described below; MCP names are not rewritten. The 0.5.9 / 0.5.8 sections below are historical records, not the current peer range.

**Pi 1.4 resume note:** Pi 1.4 activates extension tools that a resumed branch never mentioned (for example `forge_capability` when the transcript predates it). Forge still narrows the loadout to the active preset and Capabilities once it binds; `tests/pi13-tool-restore.test.ts` covers this on 1.4.

## Forge 0.5.9: Pi 1.1 / 1.2 / 1.3

Forge 0.5.9 pins development SDKs to **1.3.0** and expands the four optional SDK peers to:

```text
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.4.0
```

This is not an implicit promise for Pi 1.4 or other 0.x hosts. Historical 0.87/0.99/1.0 CI lanes remain, including 1.0.2, with 1.0.4, 1.1.0 and 1.2.0 explicit; ordinary jobs use 1.3.0. Compatibility jobs assert the resolved family and explicitly pin 1.x codemode/MCP/telemetry/chord as coherent fixtures. Their packed consumers get the same pins through `PI_TEST_COHERENT_UPSTREAM=1`; ordinary packed checks (the 1.3.0 jobs) keep normal npm resolution. This matters because fresh unconstrained installs of Pi 1.0.1–1.1.x now pull newer, incompatible codemode/MCP releases through upstream carets (for example Pi 1.1.0 + pi-codemode 1.3.0 fails with a missing `MCP_TYPESCRIPT_PREAMBLE` export) independently of Forge. Fixture success means Forge works on that host family, not that a fresh unconstrained install of that old Pi works.

Pi 1.2 emits `before_agent_start` for idle custom wakes (including Subagents completion notifications), with no `prompt`; startup is already busy (`isIdle() === false`). Forge resolves `runtime.lastUserMessage` once from the current branch's compaction-aware preview projection before compiling System blocks, using the existing latest non-empty user-content helper. No eligible content yields empty; custom content is not a user prompt. Existing preview rendering is retained (including `[image]` for image content). This is role-based history, not authenticated human identity. The snapshot survives tool followups until settlement. Each actual start, including custom starts, resets turn-frequency rewriting; busy steering does not invent a start or user message.

Ordinary and legacy user events retain their authoritative expanded prompt, even empty/image-only. Older hosts that do not emit the custom-start event are not retrofitted with it. The tests characterize that host distinction rather than claiming 1.2 custom-start behavior on 1.1.

**Known limitation on Pi 1.1 and earlier:** these hosts start idle custom wakes (for example a Subagents completion notification that wakes the parent) without any `before_agent_start`, so Forge never sees that run start. The wake request and its tool followups are sent without the Preset's System blocks; tool policy still applies. This is unchanged from 0.5.8 and was verified on Pi 1.1.0. Ordinary user turns and busy steering are not affected. If you rely on background completion wakes, use Pi 1.2 or later.

Pi 1.3 keeps the custom-start/System contract. It additionally restores the transcript's active tool loadout on default/modifier-based session creation; explicit tool selections still override restoration. Forge recomputes the effective selection using its Preset (`tools.initial`, allow/deny) and active Capabilities, rather than trusting stale restored tools. Disabling a Preset restores the tool-policy owner's saved pre-policy startup baseline, reconciling distinguishable external changes; a reduced transcript loadout must not erase that saved baseline. That 0.5.9 restoration change did not add an execution gate; Forge 0.5.10 adds the gate described below. Real-SDK persisted-session regressions cover these paths with offline faux streams.

Pi 1.3's internal SDK/codemode/MCP/telemetry dependencies are exact pins. Normal 1.3 consumers therefore resolve the seven Pi packages to 1.3.0 without the historical fixture overlay; this does not retroactively fix older releases' caret-resolution drift.

The 0.5.8 section below records the previous release's policy (peers through `<1.1.0`); it is kept as history and is not the current peer range.

## Forge 0.5.8 versus older packages

This guide covers the **Forge 0.5.8** compatibility patch. Installing the older `@zihanw/pi-forge@0.5.7` does not install these changes: that artifact still declares Pi peers `>=0.87.0 <0.88.0`.

Forge 0.5.8 declares the following peer policy for the four Pi SDK packages:

```text
>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || >=1.0.0 <1.1.0
```

Minimum Pi remains 0.87.0. Development pins are Pi 1.0.2 and `typebox@1.3.27`. The SDK packages and TypeBox remain host-provided optional peers, not private runtime dependencies. The `>=1.0.0 <1.1.0` range covers Pi 1.0 patch releases; 1.0.0, 1.0.1 and 1.0.2 were tested for this release, and a scheduled CI job tests the newest Pi. Other 0.x intermediate versions and Pi 1.1 or later are not implicitly supported.

This patch changes dependency/test coverage and documentation, **not** tool authorization, Capability ownership, usage aggregation, or personal configuration.

## Unsupported-host boundaries

Forge requires upstream Pi's `systemPromptOptions` and `context_with_system` contract. Forks such as oh-my-pi (OMP) remain unsupported; graceful missing-input handling is not OMP support or certification of a fork's tool permissions.

- CLI preset/profile application checks command-only prompt APIs before changing selection or model. Ordinary lifecycle contexts need no command-only getter.
- Fresh-session auto-profile model/thinking settings and preset/tool selection still apply early, potentially before first-turn prompt compatibility is observed. They are not deferred or automatically rolled back on later unsupported-input detection.
- Missing required inputs trigger one warning per session, clear stale compilation captures, and latch off new preset/profile application and preset compilation/preview, including an already-open Web editor's Preview. This detection does **not** abort provider dispatch or automatically clear independently applied tool policy; Forge continues applying/checking its policy.
- `/preset use none` (or `off`) explicitly disables the preset. A new session resets the latch and warning budget; tree navigation, compaction, and agent settlement do not. Fix the host contract before retrying in a new session.
- Detection is not universal or guaranteed at startup. Valid options and successful `pi.on()` registration cannot prove that `context_with_system` will actually run; Forge does not infer hook support from registration alone.

## Native MCP: migrate exact names deliberately

Pi 0.99.2+ normalizes native MCP names, for example `mcp__demo-server__ping` becomes `mcp__demo_server__ping`. Same-server tool collisions such as `a-b` and `a_b` receive hash suffixes; conflicting normalized server names are rejected.

Check all exact names in allow/deny, initial, Capability add/remove, scripts and saved loadouts:

- An unregistered Capability **add** is rejected. An old initial name may be omitted, and an old exact allow entry will not allow the new name.
- **Old exact deny/remove names may simply stop matching the renamed tool.** Do not assume every stale name fails closed. Review restrictions as carefully as additions.
- Inspect the live registered catalog after servers connect: use the Web editor's refreshed tool picker or extension API `pi.getAllTools()`. The active list alone omits inactive/deferred tools.
- Explicitly confirm each old-to-new mapping, including collision hashes, before updating configurations. Forge does not guess aliases or apply blanket hyphen replacement.

These rules concern **native MCP**, not third-party adapters such as `pi-mcp-adapter` 2.x. This patch does not migrate adapter configuration or rewrite existing resources.

## Discovery and delayed registration

Default native MCP servers now connect in the background without blocking the first prompt; `direct` exposure has different startup behavior. Default tools are registered with deferred exposure, omitted from codemode's description, and discovered using `searchTools()` / `describeNamespace()`. Discovery does not grant a Forge Capability or override its policy: finding a tool does not authorize its execution.

Pi 1.0 improves deferred-tool restoration on resume/reload. Forge still requires Capability additions to be registered before activation; when a server is late, wait for registration and retry the intended action. Reload alone is not a guaranteed remedy. Explicit policy sync can replace a restored host loadout, so do not assume pending tools must always reactivate. Full slow-MCP resume/reload behavior needs integration validation, not just catalog-mock tests.

Forge preserves foreign System sections such as `mcp_servers`, including updates and removals. Upstream section updates can change later prompts; this is not a cache-hit guarantee.

## Anthropic tool changes in Pi 1.0.1+

On Anthropic models with native mid-conversation tool changes, Pi 1.0.1 keeps the request-level tool list fixed at the initial tools plus a reserved placeholder and defines every later tool inline in a `tool_addition` block. Enabling or disabling a Capability therefore no longer rewrites the request-level tool list, and a same-name redefinition no longer forces the full list. The native path still needs at least one initial tool: a session that starts with no active tools (for example a Preset with `tools.initial: []`) sends the full current list at request level on every tool change. Forge does not change this behavior, and no new live cache measurements were taken for 1.0.1+. See [provider support](../reference/provider-support.md).

## Tool execution and codemode boundaries (Forge 0.5.10)

Pi 1.0 throws when scripts read missing `tools` properties. Use `"name" in tools`, not `typeof tools.name`, to test existence.

With an active Preset's restrictive tool policy, **all tool calls, including nested codemode calls, require Forge authorization**. The effective set starts from `tools.initial` when configured, otherwise the policy-derived baseline, then applies enabled Capability additions and removals under allow/deny. Turning a Capability off immediately revokes execution access for any tool no longer authorized; defaults or another Capability may still authorize it. Running tools are not interrupted. Forge uses this effective set, not Pi's active tool list; allow membership alone does not enable a tool omitted from the effective set. Calls to tools not currently enabled point to `forge_capability` when a Capability can provide access.

An effective tool `P` also authorizes registered `P__*` descendants **from the same registration source**. For example, enabling `mcp` or `mcp__hitch` permits pi-mcp-adapter 6+/7 calls named `mcp__hitch__<tool>` from that source, without listing every child in `allow`. Different or missing registration sources do not grant this access. Preset deny and active Capability remove still block child tools; use an exact deny entry to exclude one child. Capability `remove` uses exact names, not wildcards.

Without an active Preset or a restrictive tool policy, execution behavior is unchanged. `tools.initial` alone or `allow: ["*"]` alone does not enable the new gate; an allow list containing an entry other than `*`, or a nonempty deny list, does. Existing explicit Capability removals still apply.

### Known limitations

- **Discovery:** codemode `ALL_TOOLS` / `searchTools()` and `tool_search` can still reveal unauthorized names. Forge blocks execution, not discovery.
- **Model APIs:** codemode `models.generateImages()` (new in Pi 1.0) and `models.classify()` (since 0.99) do not pass through `tool_call`, so Forge cannot block them. Disabling an image Capability does **not** disable these APIs. Only programmatic SDK assembly with `createCodemodeExtension({ models: false })` disables this codemode model access; Pi settings have no equivalent toggle.
- **Prefix caching:** on OpenAI Responses/Completions transports, any tool removal, including disabling a Capability that removes tools, makes subsequent requests in that session send the full current tool list. Removal detection scans the transcript, so re-enabling tools does not restore incremental delivery while that history remains. This disrupts prefix caching. Anthropic's native `tool_removal` path is unaffected by this fallback. Forge aims to preserve cacheable prefixes where possible, not guarantee cache hits.

Pi accounts for reported codemode model usage. Forge's cache display still separates assistant usage from explicit `details.forgeNestedUsage`; it does not newly aggregate arbitrary native tool/model usage. Do not add both receipts without deduplication.

## TUI and optional packages

Pi 1.0 defaults to fullscreen. To retain ordinary terminal scrollback, set `"tuiMode": "regular"` in Pi settings or use `pi --tui-mode regular`. This does not change Forge's Web UI.

Removing the experimental agent-core harness does not remove the coding-agent `AgentSession` used by our companion runtime. `pi-durable` is still explicitly experimental; this patch does not adopt it or add cross-restart continuation.

Published subagents 0.5.3 does not support `tools.initial`. Its pending feature release can include Pi 1.0 adaptation, but requires its own runtime artifact/floor, TypeBox peer cleanup, bwrap `/tmp` launcher fix, packed tests and approval. Main Forge releases independently; main+optional import smoke does not certify the pending continuation/background features. See [host-port compatibility](../reference/subagent-host-port.md#tool-selection-compatibility).

## Verification

```bash
# Override both when testing a different host than the installed development SDK.
PI_TEST_VERSION=0.87.0 TYPEBOX_TEST_VERSION=1.3.7 npm run check:packed
PI_TEST_VERSION=1.4.0 TYPEBOX_TEST_VERSION=1.3.27 npm run check:packed
```

Without overrides, packed checks use the coherent installed SDK family and its declared TypeBox version, not a hardcoded historical pin. Both consumers use normal npm peer resolution and check the installed versions. An optional sibling, when present, uses its declared runtime dependency; this is not a test of an unreleased local runtime.

Ordinary Linux/macOS/Windows CI uses pinned Pi 1.4.0; explicit compatibility lanes (0.87.0 through 1.3.0, including 1.0.2) and scheduled latest-Pi probes run on Linux. CI on the exact release commit remains a release gate; this document does not record its result or any real-provider testing.
