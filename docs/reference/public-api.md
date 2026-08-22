# Public API policy

[Documentation](../README.md)

pi-forge is pre-1.0. This document defines the intentional integration surfaces of the 0.5.0 line.

## The four intentional entry points

`check-package` enforces this allowlist; nothing else is importable from the package.

### 1. Package root: extension factory

```ts
import piForge from "@zihanw/pi-forge";
```

The default export is the Pi extension entry point declared by `pi.extensions`. Most users install the package and never import it directly.

### 2. Package root: trusted extension API

```ts
import { registerMacro, registerSlot } from "@zihanw/pi-forge";
import type {
  ForgeExtensionApi,
  ForgeExtensionRegister,
  PromptEnvironment,
  PromptEnvironmentValue,
  PromptExtensionArgumentDefinition,
  PromptExtensionOptionDefinition,
  PromptExtensionOptionsSchema,
  PromptExtensionOptionType,
  PromptMacroDefinition,
  PromptMacroRenderContext,
  PromptMacroRenderer,
  PromptRegistryEntry,
  PromptRenderHelpers,
  PromptSlotDefinition,
  PromptSlotRenderContext,
  PromptSlotRenderer,
} from "@zihanw/pi-forge";
```

Supported for trusted reusable and project-local extensions. The contract (pure renderers, declared dependencies, immutable `PromptEnvironment`, bounded output) is specified in the [0.5.0 architecture plan](../design/architecture-0.5.md#extension-port-contract-050) and the [custom macros and slots guide](../guides/custom-macros-and-slots.md).

### 3. `@zihanw/pi-forge/subagent`: versioned host port

```ts
import {
  ForgeHost, ForgeHostClient, ForgeHostPortError,
  FORGE_HOST_CHANNEL, FORGE_HOST_PORT_VERSION, FORGE_HOST_PORT_OPERATIONS,
  validateListProfilesRequest, validateListProfilesResponse,
  validateResolveProfileRequest, validateResolveProfileResponse,
  validatePrepareRequest, validatePrepareResponse,
  canonicalSubagentJson, subagentFingerprint,
  subagentSourceProfileFingerprint, subagentPromptStackFingerprint,
} from "@zihanw/pi-forge/subagent";
```

The experimental host port over the Pi event bus: discovery, profile listing/snapshot, and host-owned prompt preparation with mandatory lifecycle semantics (correlation IDs, payload validation, bounded timeouts, host generation, duplicate-host failure, disposal/`unavailable`, listener cleanup). The wire DTOs and validators are self-contained Forge data contracts; the main package has no dependency on `@zihanw/pi-subagent-runtime`. The canonical `sha256:v1` fingerprint helpers are Forge-owned and byte-compatible with the runtime's canonical JSON.

The optional `@zihanw/pi-forge-subagents` package consumes this port and owns subagent execution and configuration.

### 4. `@zihanw/pi-forge/ui-contribution`: versioned settings port

```ts
import {
  UiContributionProvider,
  UiContributionClient,
  UI_CONTRIBUTION_PORT_VERSION,
} from "@zihanw/pi-forge/ui-contribution";
```

The experimental generic Settings integration surface. Optional packages contribute recursively validated, JSON-compatible schemas and values over the Pi event bus; pi-forge owns only the renderer and web proxy. Providers own validation and persistence, may resolve operations asynchronously, and receive an abort signal tied to provider generation so stale requests can stop before side effects. The full contract is documented in the [UI contribution port reference](ui-contribution-port.md).

## Compatibility policy

- **Stable** surfaces (root factory, macro/slot registration) preserve source compatibility within the documented release range unless a changelog entry announces a breaking release.
- **Experimental** surfaces (the `/subagent` and `/ui-contribution` ports) are typed, tested, and documented, but may change deliberately as integration experience exposes missing semantics.
- Everything not listed above is internal and may change without notice. In particular: no `src/*` subpath aliases exist, `./examples/*` is not an import surface (examples ship as browsable files), and removed 0.4 surfaces (the execution contract re-exports, loader/profile/catalog helpers) now live either nowhere or in `@zihanw/pi-forge-subagents`.

## Removed in 0.5.0

- All `@zihanw/pi-forge/src/*` compatibility aliases and the `./examples/*` subpath export.
- Root re-exports of loader, agent-profile, profile-service, catalog, resource-identity, render-helper values, the `forge-v1` engine, and registry readers.
- Root and `/subagent` re-exports of the 0.4 execution contract (`AgentRequest`, `createAgentExecutionPlan`, `validateAgentRequest`, `negotiateSubagentTools`, `resolveSubagentHostProfile`, `prepareSubagentHostPlan`, and friends). The execution contract now belongs to `@zihanw/pi-forge-subagents`.

See the [0.5 migration guide](../guides/migrating-to-0.5.md) for the complete breaking-change list.
