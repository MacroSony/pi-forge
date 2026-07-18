# pi-forge Complexity Review

Date: 2026-07-18

## Executive Summary

The structural refactor recommended by the original 2026-07-12 review is complete:

- The browser editor is authored as typed modules and bundled only for distribution.
- The subagent contract is split into focused modules behind compatibility barrels.
- `src/index.ts` is a small composition root over dedicated runtime services.
- Package contents and stable, experimental, and compatibility exports are explicitly classified.

pi-forge is still a reasonable size for its feature set. The main engineering risk has moved from a few monolithic files to the safety and lifecycle seams of the experimental subagent backend. The narrow parent-agent integration is now complete; the next iteration should harden the shared-user boundary and evaluate an optional sandbox without adding orchestration breadth.

## Current Size

Measured from the current `feature/0.4-subagents-prep` working tree:

| Area | Files | Lines of TypeScript |
|---|---:|---:|
| Production source (`src`) | 72 | 16,355 |
| Core tests and helpers (`tests`) | 23 | 7,271 |
| Browser tests (`tests-browser`) | 1 | 139 |
| Internal TypeScript scripts (`scripts`) | 2 | 628 |

Additional observations:

- `dist/` is generated output and is about 2.1 MB; verification rejects stale generated files.
- Runtime dependency count remains low.
- The implementation checkpoint passes 184 core tests, one browser test, TypeScript typecheck, generated-client and `dist` consistency, and npm package-layout checks.
- The npm package resolves both entry points to compiled output and contains no physical `src/` files.

## Completed Structural Work

### Typed browser client

The previous 2,253-line embedded browser script is now a generated one-line compatibility wrapper. Typed source modules under `src/web-editor/client/` own API transport, DOM access, policy editing, regex editing, inspection, and orchestration. `src/web-editor/client/main.ts` is still large, but it is type-checked and can be split incrementally as profile UI introduces clear component boundaries.

### Modular subagent contract

The previous 1,373-line `src/subagent-contract.ts` implementation is now a seven-line compatibility barrel. Types, canonicalization, request validation, preflight, tools, context, plans, response handling, and validation live in focused `src/subagent/` modules with import-surface tests preserving the experimental API.

### Small composition root

`src/index.ts` remains a small composition root and primarily wires prompt-stack, profile, tool-policy, web-editor, lifecycle, subagent runtime, command, and tool registration. Operational behavior lives in dedicated modules.

### Package and API boundaries

`PUBLIC_API.md` classifies stable, experimental, and compatibility surfaces. `@zihanw/pi-forge/subagent` is the preferred experimental integration entry point, while legacy `src/*` aliases resolve to compiled modules without publishing source files.

## Current Complexity Hotspots

| File | Lines | Current assessment |
|---|---:|---|
| `src/web-editor/client/main.ts` | 1,491 | Largest remaining orchestration module; split along profile UI boundaries when that work begins |
| `src/web-editor/styles.ts` | 995 | Large but mostly presentation logic |
| `src/compiler.ts` | 578 | Mature core compiler; change cautiously |
| `src/subagent/backend-registry.ts` | 575 | Highest semantic risk: dispatch, cancellation, timeout, binding, and trace routing |
| `src/subagent/pi-subprocess-backend.ts` | 773 | Foreground child lifecycle, exact bridge inputs, sanitized report transport, cancellation, and cleanup |
| `src/subagent-tool.ts` | 453 | Approval UX, bounded model projection, and expandable human report rendering |
| `src/loader.ts` | 518 | Broad input normalization and validation surface |
| `src/regex.ts` | 500 | Mature transformation engine with focused tests |
| `src/subagent/pi-sdk-backend.ts` | 450 | Experimental provider/session lifecycle boundary |

The registry, subprocess backend, and approval tool are not concerning solely by line count, but they carry the strongest correctness and egress guarantees. Prefer focused helpers and end-to-end lifecycle tests over broad rewrites.

## Near-Term Priorities

1. Keep provider egress fail-closed in interactive, non-UI, cancelled, and timed-out paths.
2. Dogfood the model-callable foreground path without creating a second runner or allowing a tool call to grant its own egress consent.
3. Preserve read-only defaults, bounded result projection, no automatic parent-history export, and honest shared-user receipts while evaluating bubblewrap-style isolation.
4. Add profile UI by reusing the existing profile repository/application services and splitting browser orchestration only where the new UI creates stable boundaries.
5. Re-run the complete verification suite for every release candidate and keep generated output synchronized.

## Guardrails

Do not remove strict validation, immutable preparation binding, task preservation, access/limit receipts, rollback, provenance, or drift reporting merely to reduce line count. These mechanisms make the experimental runtime's behavior inspectable and enforceable.

Avoid building retries, queues, chains, background execution, direct write/shell access, media routing, or artifact/trace storage into the 0.4 foreground path. Evaluate sandbox and external orchestration packages behind the existing backend contract before expanding pi-forge into a general runner.

## Final Assessment

The original concentration problems and narrow parent-agent integration are addressed. Future complexity control should be incremental: isolate lifecycle-sensitive backend logic, split the browser client along real product boundaries, and resist turning pi-forge into a general orchestration framework without demonstrated need.
