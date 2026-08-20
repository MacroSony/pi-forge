# Migrating to pi-forge 0.5

[Documentation](../README.md)

0.5.0 is a breaking cleanup release. This page is the migration note for the
changes landed so far (Lane 1a-1c plus the compiler/extension conformance
pass in Lane 1d).

## What was removed

- SillyTavern importer (`/preset import-silly`), its reports, guide, example,
  and tests. Convert SillyTavern presets with pi-forge 0.4 before upgrading.
- Mutable turn/session variables, variable mutation macros,
  `pi-forge-variable-state` session entries, and the `variables` slot.
- Regex `display` and `both` effects; `outgoing` and `finalize` remain.

## Template syntax changes

Prompt text now compiles with the closed `forge-v1` grammar.

| 0.4 construct | 0.5 forge-v1 |
|---|---|
| `{{name}}` (static) | `{{ parameters.name }}` |
| `{{lastUserMessage}}` | `{{ runtime.lastUserMessage }}` |
| `{{date}}` / `{{time}}` / `{{cwd}}` | `{{ runtime.date }}` / `{{ runtime.time }}` / `{{ runtime.cwd }}` |
| `{{tools}}` | `{{ runtime.selectedToolsText }}` |
| `{{upper::x}}` | `{{ x \| upper }}` |
| `{{iftools::bash::A::B}}` | `{% if runtime.tool.bash %}A{% else %}B{% endif %}` |
| custom `{{myMacro}}` | `{{ extensions.myMacro }}` |

Unknown paths, unknown filters, parse errors, cycles, and output-limit breaches
are compile errors; a failing block is omitted instead of re-injecting raw
template text.

## Schema v2

Schema v2 stacks store immutable static values in `parameters` (JSON-compatible)
instead of the legacy string-only `variables` field:

```json
{
  "schemaVersion": 2,
  "parameters": { "char": "Konata" }
}
```

Unversioned / v1 stacks continue to load through the legacy `variables` reader.

## Running the migration utility

A mechanical, diagnostics-first script converts a saved stack file:

```bash
node scripts/migrate-stack-v2.mjs .pi/forge/prompt-stacks/default.json --dry-run
node scripts/migrate-stack-v2.mjs .pi/forge/prompt-stacks/default.json --write
```

It renames `variables` to `parameters`, maps runtime/parameter paths, and
converts simple filter pipelines. Non-mechanical constructs are reported and
the file is only written when they are absent. A schema v2 file that still
contains a legacy `variables` field is left untouched and only warned about.

## Preview and finalize

Preview never applies `finalize`; it now reports an informational diagnostic.
`finalize` remains a destructive, lifecycle-owned transform that replaces the
stored assistant message.

## Lane 2: scoped global profiles and prompt stacks

- User-global resources now live in `~/.pi/forge/prompt-stacks` and `~/.pi/forge/agent-profiles` alongside the project stores. Profile and stack selectors accept explicit scopes: `project:<id>`, `global:<id>`, with bare IDs resolving project-first.
- Same-ID project resources shadow their global counterparts; global stacks cannot reference project resources (and vice versa) — references resolve within the referenced resource's scope.
- Untrusted projects fail closed: only global resources load, all mutation routes are rejected, and `session_shutdown` no longer disposes a trusted workspace while sessions may still be active (idle workspaces are swept after an hour; hosts stop independently).
- The web editor gained scope selectors for creating stacks/profiles into either store and routes global mutations through explicit `global:<id>` selectors.

## Lane 3: subagent package split

Subagent execution moved out of the main package into the optional `@zihanw/pi-forge-subagents` package (requires `@zihanw/pi-forge@^0.5.0`). Install it separately to keep foreground delegation.

- **Commands:** `/subagents` and `/subagent-run` were removed from the main package. The optional package registers `/forge-agent backends|plan|run`.
- **Model tools:** `forge_subagent_profiles` and `forge_subagent` are registered by the optional package.
- **Configuration:** `subagents.*` moved out of `.pi/forge/config.json` into dedicated `.pi/forge/subagents.json` (trusted project) and `~/.pi/forge/subagents.json` (user defaults). The optional package reads legacy `config.json.subagents` sections as a read-only fallback with a warning; it never writes them. Copy the values into `subagents.json` to silence the warning.
- **Web editor:** the delegation card was removed from the main editor; edit `subagents.json` directly.
- **Architecture:** the main package's prompt compiler is host-neutral (no subagent assumptions), and `ForgeWorkspace` is the single owner of resource state and compilation contexts.

## Lane 4: Forge-native host contract and public surface

- The main package no longer depends on `@zihanw/pi-subagent-runtime` and no longer exports the 0.4 execution contract. That contract (`AgentRequest`, `createAgentExecutionPlan`, `validateAgentRequest`, `negotiateSubagentTools`, preflight/plan/response validators, …) now lives in `@zihanw/pi-forge-subagents` for its own runtime wiring; it is not a public surface of either package for third-party consumers.
- `@zihanw/pi-forge/subagent` now exports only the versioned host port: wire DTOs and validators, `ForgeHostTransport`, `ForgeHost`/`ForgeHostClient`, lifecycle constants, and the Forge-owned canonical fingerprint helpers. `resolveSubagentHostProfile` / `prepareSubagentHostPlan` were replaced by the host-port operations `resolveProfile` and `prepare`.
- The package root exports only the default extension factory, `registerMacro`/`registerSlot`, and their contract types. All other root re-exports (loader, agent-profile, profile-service, catalog, resource-identity, render-helper values, the `forge-v1` engine, registry readers) were removed.
- All `@zihanw/pi-forge/src/*` subpath aliases and the `./examples/*` export were removed; `check-package` rejects them.

### Import migration table

| 0.4 import | 0.5 replacement |
|---|---|
| `@zihanw/pi-forge` (default, `registerMacro`, `registerSlot`) | unchanged |
| `@zihanw/pi-forge/subagent` host-port names (`ForgeHost*`, validators, fingerprints) | unchanged |
| `@zihanw/pi-forge/subagent` execution contract (`AgentRequest`, `createAgentExecutionPlan`, …) | internal to `@zihanw/pi-forge-subagents`; no public replacement |
| `@zihanw/pi-forge/subagent` `resolveSubagentHostProfile` / `prepareSubagentHostPlan` | host-port operations via `ForgeHostClient` |
| `@zihanw/pi-forge/src/*` aliases | removed; no replacement (internals) |
| root loader/profile/catalog/engine re-exports | removed; no replacement (internals) |

## Compatibility notes

- The wire shape of the host port is additive across `FORGE_HOST_PORT_VERSION = 1`; unknown operations are rejected with a plain `{ ok: false, error }` result (`"Unknown Forge host operation: …"`), not a thrown error, and optional packages must treat any operation failure as terminal for that request.
- Vendored fingerprint helpers in the main package are pinned by golden vectors to stay byte-compatible with `@zihanw/pi-subagent-runtime` canonical serialization; plan sealing still happens only in the optional package.
