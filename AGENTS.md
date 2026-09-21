# pi-forge repository guidance

These instructions apply to humans and coding agents.

## Current mode

pi-forge is continuing the lean 0.5 line through the accepted amendments in [docs/design/architecture-0.5.md](docs/design/architecture-0.5.md), including the authorized [0.5.5 instruction-mode lanes](docs/design/pi-forge-system-update-design-notes.md). Functional source is delivered across all planned instruction-mode lanes: the codec/event foundation, human CLI core (`/system-update`), plain metadata anchor projection with ordinal materialization, Web Session activity read/control panel, live Preset bindings (`instructionModes`) with finite overrides and opt-in `modelCallable: true`, restricted Agent control (`forge_system_update` with list/status/use/off, ID ≤128 chars), Web Modes CRUD with `sourceRevision` stale-save protection, Preset binding editor with source-effective preview, and guarded human Web activation (`GET /api/instructions/available`, `POST /api/instructions/use` with guard and fingerprint checks). Parent safeguards enforce raw source/revision coherence, external new-binding stale-save detection, and lifecycle/re-entry fences (`disposed`, `lifecycleRevision`, `sameContext`). Read-only resource discovery and Preview never mutate tool policy, session events, or prepared state. Modes support `add`/`remove` only; candidate `only`/allowlist is not implemented. Tool transport and prompt caching are downstream provider-managed; conservative warnings apply without zero-KV-invalidation promises. Upstream Pi metadata chunking remains an independent unfixed issue; compaction checkpoint placement is unchanged, and legacy sessions are recovered without automatic migration or old summary rewrites. Functional source is delivered, with parent full verification passed (730 Node / 33 browser); package version remains 0.5.4, and release, git push, and user host reload (`/reload`) remain separate user-authorized actions. Do not confuse delivered source with a completed 0.5.5 package release. Do not add unrelated product features. The long-term target is archived in [docs/design/archive/0.5-full-proposal/](docs/design/archive/0.5-full-proposal/README.md).

Prefer removal and simplification. Move code when splitting packages; do not rewrite working behavior unless the lean plan requires it.

## Working rules

1. One implementation lane at a time, in the order listed in the lean plan and [roadmap](docs/development/roadmap.md).
2. Add characterization tests before changing behavior that is not already isolated by tests.
3. Each lane ends in a coherent, verified state: `npm run verify` for release-sized or cross-cutting work.
4. Breaking changes require a changelog entry and migration note in the same change; do not create compatibility layers without a named consumer.
5. New public exports must be intentional package entry points. Do not add `src/*` compatibility exports.
6. Do not introduce a new framework, state owner, registry, package boundary, or persistent format as an incidental detail. If the lean plan is insufficient, pause and propose an amendment.
7. Generated browser assets and `dist/` are built, not hand-edited.
8. Frequent, small, coherent, verified local commits: commit locally as soon as each lane or verified work unit is completed; do not accumulate large dirty working trees. Remote push and package publishing remain separately authorized.

## Architecture invariants

- The full target remains: adapters depend on application services, services depend on domain/core abstractions, and infrastructure implements ports.
- Prompt compilation is deterministic over immutable inputs; no new mutable variable or render-time side-effect behavior.
- In lean 0.5.0 all stack/profile persistence goes through minimal repositories and codecs. Fingerprint conflicts and atomic writes are 0.5.x work.
- Main pi-forge owns stacks/profiles and prompt preparation. Optional subagent integration uses the versioned `/subagent` host port for those capabilities and the generic `/ui-contribution` port only for schema-driven settings UI; no package-internal registry or component crosses either boundary.
- Main pi-forge owns `webEditor.*` only. The optional package owns `.pi/forge/subagents.json` and its global equivalent; main pi-forge does not read, write, validate, or clean subagent configuration.
