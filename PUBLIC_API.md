# Public API Policy

pi-forge is pre-1.0. This document separates supported integration surfaces from experimental 0.4 work and compatibility paths that should not become permanent dependencies.

## Stable

- The package default export is the Pi extension entry point declared by `pi.extensions`.
- Package-root macro and slot registration APIs (`registerMacro`, `registerSlot`, their registry readers, render contexts, and declarative definition types) are supported for trusted reusable extensions.
- `ForgeExtensionApi` and related registration types are supported for trusted project-local forge extensions.

Stable means changes should preserve source compatibility within the documented supported release range unless a changelog entry explicitly announces a breaking release.

## Experimental

- Agent-profile repository, resolution, application, preview, provenance, and drift APIs are 0.4 experimental surfaces.
- The runner-neutral subagent contract, host-resolution helpers, optional empty-by-default backend registry, retained `PiSdkIsolatedBackend`, and default `PiSubprocessBackend` adapter are 0.4 experimental surfaces.
- New subagent integrations should import from `@zihanw/pi-forge/subagent`. The package root continues to re-export the current subagent names through the 0.4 prereleases for compatibility.

Experimental APIs are typed, tested, and documented, but may be revised before the 0.4 release as real adapter and parent-integration work exposes missing semantics. Changes should still be deliberate and recorded.

## Internal compatibility paths

- `@zihanw/pi-forge/src/*` subpath exports exist for compatibility with earlier source-shaped imports. They resolve to compiled `dist` modules and are not a promise that every implementation module is a permanent public API.
- `src/subagent-contract.ts` is a compatibility barrel over the focused contract modules; it does not contain a second implementation.
- Physical `src/` files are not included in the npm tarball. Runtime installation and legacy `@zihanw/pi-forge/src/*` aliases use compiled `dist` modules; source inspection or modification requires a repository clone.
- `scripts/subagent-sdk-spike*.ts` are diagnostic development interfaces, not a supported runner API.

Before removing the compatibility subpaths, check known consumers, announce the change, and provide supported package entry points for legitimate integrations.
