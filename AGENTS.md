# pi-forge repository guidance

These instructions apply to humans and coding agents.

## Current mode

pi-forge is continuing the lean 0.5 line through the accepted amendments in [docs/design/architecture-0.5.md](docs/design/architecture-0.5.md), including the authorized [0.5.5 instruction-mode lanes](docs/design/pi-forge-system-update-design-notes.md). The codec/event foundation and human CLI core are implemented: Pi 0.86 request projection, scoped mode discovery, semantic session recovery and real tool overlays. See docs/reference/instruction-modes.md for current capability and limitations. The user-approved follow-up adds the Web Session activity read/control panel and real-SDK compaction-input characterization before the full binding editor. The next lane is live Preset binding/current authorization and restricted Agent control; mode library/binding UI and release remain later. Compaction checkpoint placement is still under evaluation, not silently changed. Do not confuse the usable CLI slice with a completed 0.5.5 release. Do not add unrelated product features. The long-term target is archived in [docs/design/archive/0.5-full-proposal/](docs/design/archive/0.5-full-proposal/README.md).

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
- Main pi-forge owns stacks/profiles and prompt preparation. Optional subagent integration uses the versioned `/subagent` host port for those capabilities and the generic `/ui-contribution` port only for schema-driven settings UI; no package-internal registry or component crosses either boundary.
- Main pi-forge owns `webEditor.*` only. The optional package owns `.pi/forge/subagents.json` and its global equivalent; main pi-forge does not read, write, validate, or clean subagent configuration.
