# pi-forge repository guidance

These instructions apply to humans and coding agents.

## Current mode

pi-forge is delivering the lean 0.5.0 breaking-cleanup release. Do not add net-new product features. The executable scope is [docs/design/architecture-0.5.md](docs/design/architecture-0.5.md); the long-term target is archived in [docs/design/archive/0.5-full-proposal/](docs/design/archive/0.5-full-proposal/README.md).

Prefer removal and simplification. Move code when splitting packages; do not rewrite working behavior unless the lean plan requires it.

## Working rules

1. One implementation lane at a time, in the order listed in the lean plan and [roadmap](docs/development/roadmap.md).
2. Add characterization tests before changing behavior that is not already isolated by tests.
3. Each lane ends in a coherent, verified state: `npm run verify` for release-sized or cross-cutting work.
4. Breaking changes require a changelog entry and migration note in the same change; do not create compatibility layers without a named consumer.
5. New public exports must be intentional package entry points. Do not add `src/*` compatibility exports.
6. Do not introduce a new framework, state owner, registry, package boundary, or persistent format as an incidental detail. If the lean plan is insufficient, pause and propose an amendment.
7. Generated browser assets and `dist/` are built, not hand-edited.

## Architecture invariants

- The full target remains: adapters depend on application services, services depend on domain/core abstractions, and infrastructure implements ports.
- Prompt compilation is deterministic over immutable inputs; no new mutable variable or render-time side-effect behavior.
- In lean 0.5.0 all stack/profile persistence goes through minimal repositories and codecs. Fingerprint conflicts and atomic writes are 0.5.x work.
- Main pi-forge owns stacks/profiles and prompt preparation. Optional subagent integration uses only the versioned `/subagent` host port.
- Main pi-forge owns `webEditor.*` only. The optional package owns `.pi/forge/subagents.json` and its global equivalent; main pi-forge does not read, write, validate, or clean subagent configuration.
