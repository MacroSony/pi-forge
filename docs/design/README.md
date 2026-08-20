# Architecture and design

[Documentation](../README.md)

The active plan defines the executable forward-looking work. Archived documents preserve the long-term target, decisions, reviews, spikes, and implementation history; they are not the authoritative description of current user behavior. Use the [guides](../README.md#guides) and [reference](../README.md#reference) for released behavior.

## Active 0.5.0 plan

- [Lean 0.5.0 architecture plan](architecture-0.5.md) — executable breaking-cleanup scope, accepted decisions, implementation lanes, and release gates.
- [Architecture and development rules](../development/architecture-rules.md) — dependency direction and ownership rules for the full target.
- [Architecture decision template](decision-template.md) — structure for future boundary/product decisions.

## Archived 0.5 full proposal

The original six-phase target remains the long-term goal and is preserved here:

- [Full proposal index](archive/0.5-full-proposal/README.md)
- [Full 0.5 architecture plan](archive/0.5-full-proposal/architecture-0.5.md)
- [Migration inventory](archive/0.5-full-proposal/0.5-inventory.md)
- [Public-consumer audit](archive/0.5-full-proposal/0.5-consumer-audit.md)
- [Phase-0 decision drafts](archive/0.5-full-proposal/0.5-phase0-decision-drafts.md)
- [Template-language spike](archive/0.5-full-proposal/template-language-spike.md)
- [Pi host-discovery spike](archive/0.5-full-proposal/host-discovery-spike.md)

## Subagent design history

- [Request/response design](subagents/interface-design.md) — accepted architecture and completed implementation iterations.
- [Design review](subagents/design-review.md) — issues that drove preflight, task preservation, policy, fingerprint, and response revisions.
- [Pi SDK spike findings](subagents/sdk-spike-findings.md) — historical 0.80.6 investigation; its harness was removed after findings were productized.

## Project planning history

- [0.4 roadmap and implementation log](roadmap-0.4-archive.md)

The 0.5 host boundary is in the [subagent host port contract](../reference/subagent-host-port.md); accepted work ordering is in the [roadmap](../development/roadmap.md).
