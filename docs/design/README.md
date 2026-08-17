# Architecture and design

[Documentation](../README.md)

The proposed plan defines candidate forward-looking architecture. Archived documents preserve decisions, reviews, spikes, and implementation history; they are not the authoritative description of current user behavior. Use the [guides](../README.md#guides) and [reference](../README.md#reference) for released behavior.

## Proposed 0.5 architecture

- [0.5 architecture plan](architecture-0.5.md) — target packages and components, breaking cleanup, implementation phases, open gates, and release criteria.
- [Architecture and development rules](../development/architecture-rules.md) — dependency direction, state/persistence ownership, decision triggers, and definition of done.
- [Architecture decision template](decision-template.md) — required structure for boundary and product decisions.

## Historical archive

## Subagent design history

- [Request/response design](subagents/interface-design.md) — accepted architecture and completed implementation iterations.
- [Design review](subagents/design-review.md) — issues that drove preflight, task preservation, policy, fingerprint, and response revisions.
- [Pi SDK spike findings](subagents/sdk-spike-findings.md) — historical 0.80.6 investigation; its harness was removed after findings were productized.

## Project planning history

- [0.4 roadmap and implementation log](roadmap-0.4-archive.md)

The current 0.4 exported semantics are in the [subagent adapter contract](../reference/subagent-adapter.md); accepted work ordering is in the [roadmap](../development/roadmap.md).
