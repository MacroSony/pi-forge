# Public API Policy

pi-forge is pre-1.0. This document separates supported integration surfaces from experimental 0.4 work and compatibility paths that should not become permanent dependencies.

## Stable

- The package default export is the Pi extension entry point declared by `pi.extensions`.
- Package-root macro and slot registration APIs (`registerMacro`, `registerSlot`, their registry readers, render contexts, and declarative definition types) are supported for trusted reusable extensions.
- `ForgeExtensionApi` and related registration types are supported for trusted project-local forge extensions.

Stable means changes should preserve source compatibility within the documented supported release range unless a changelog entry explicitly announces a breaking release.

## Experimental

- Agent-profile repository, resolution, application, preview, provenance, and drift APIs are 0.4 experimental surfaces.
- The runner-neutral subagent contract and host-resolution helpers are 0.4 experimental surfaces. Backend registration, sealing, lifecycle, and the fresh-process backends moved to `@zihanw/pi-subagent-runtime`; Forge consumes them through its public runtime API.
- New subagent integrations should import from `@zihanw/pi-forge/subagent`. The package root continues to re-export the current subagent names through the 0.4 prereleases for compatibility.

Experimental APIs are typed, tested, and documented, but may be revised before the 0.4 release as real adapter and parent-integration work exposes missing semantics. Changes should still be deliberate and recorded.

## Internal compatibility paths

- `@zihanw/pi-forge/src/*` subpath exports exist for compatibility with earlier source-shaped imports. They resolve to compiled `dist` modules and are not a promise that every implementation module is a permanent public API.
- Browser-only `@zihanw/pi-forge/src/web-editor/client/*` implementation paths are explicitly blocked. The editor is distributed only through its generated embedded assets; these authored modules have never been a runtime integration surface.
- The package root re-exports `@zihanw/pi-forge/subagent` contract names directly from the focused contract modules. The former `src/subagent-contract.ts` compatibility barrel and the `scripts/subagent-sdk-spike*` diagnostic harness were removed in the 0.4 cleanup.
- Physical `src/` files are not included in the npm tarball. Runtime installation and legacy `@zihanw/pi-forge/src/*` aliases use compiled `dist` modules; source inspection or modification requires a repository clone.

Before removing the compatibility subpaths, check known consumers, announce the change, and provide supported package entry points for legitimate integrations.
