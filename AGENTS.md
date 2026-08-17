# pi-forge repository guidance

These instructions apply to the entire repository. They are intentionally strict while the 0.5 architecture is being established.

## Current development mode

pi-forge is in a 0.5.0 stabilization and architecture phase. Do not add net-new product features unless the work is explicitly listed in the [0.5 architecture plan](docs/design/architecture-0.5.md) (currently proposed) or accepted by a maintainer as a separate architecture decision.

Prefer removing accidental complexity, preserving characterized behavior, and establishing the target boundaries over expanding the 0.4 design.

## Sources of truth

- [0.5 architecture plan](docs/design/architecture-0.5.md): proposed target components, package boundaries, breaking changes, migration phases, confirmed decisions, and release gates.
- [Architecture and development rules](docs/development/architecture-rules.md): dependency rules, state ownership, decision gates, and definition of done.
- [Roadmap](docs/development/roadmap.md): accepted work ordering.
- User guides and reference documentation: current released 0.4 behavior until a 0.5 change is implemented.

When these disagree, stop and resolve the design documentation before changing code.

## Required workflow

1. Classify the change as local, boundary-affecting, or product-affecting using the development rules.
2. For boundary- or product-affecting work, update or add an architecture decision before implementation.
3. Keep one boundary-changing initiative in progress at a time.
4. Add characterization coverage before intentionally changing behavior that is not already isolated by tests.
5. Update the current/target architecture documentation when component ownership or dependency direction changes.
6. Run verification proportional to the change; run `npm run verify` before declaring a release-sized slice complete.

## Architectural constraints

- Adapters depend on application services; application services depend on domain/core abstractions. Dependencies must not point from core back to Pi lifecycle, commands, HTTP, browser, or subagent UI.
- Filesystem persistence belongs behind repositories. Commands, HTTP handlers, and browser-host adapters must not write domain resources directly.
- The future `ForgeWorkspace` is the owner of coherent stack/profile catalogs and resource reloads. Do not add new owners of the shared runtime state while it is being replaced.
- Prompt compilation must move toward a deterministic operation over immutable inputs. Do not add new mutable variable behavior or hidden render-time side effects.
- Profiles select runtime configuration and reference stacks. Profiles do not own prompt compilation or tool/skill policy.
- Optional subagent integration must use a versioned public host port. It must not depend on pi-forge internal state or web-editor modules.
- New public exports must be intentional package entry points. Do not add new `src/*` compatibility exports.
- Schema, persisted session state, public API, trust boundary, package boundary, or dependency-direction changes require an architecture decision and migration notes.

## Scope control for coding agents

- Do not turn a focused implementation task into a neighboring feature project.
- Do not introduce a new framework, state owner, registry, persistent format, or package boundary as an incidental implementation detail.
- When an accepted design is insufficient, pause implementation and propose a design amendment.
- Mechanical cleanup is welcome only when it follows the active boundary being changed and remains reviewable.

## Generated files and verification

- Edit authored browser code under `src/web-editor/client/`; regenerate embedded assets with the existing build scripts.
- Do not hand-edit generated client bundles or `dist/`.
- Preserve existing user changes in a dirty worktree.
- The normal full gate is `npm run verify`.
