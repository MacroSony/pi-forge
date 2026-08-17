# Roadmap

[Documentation](../README.md)

This file contains forward-looking product work only. Completed capability belongs in the [feature inventory](../reference/features.md), release history in the root [changelog](../../CHANGELOG.md), and completed investigation in the [design archive](../design/README.md).

## 0.5.0 architecture stabilization

0.5.0 is a deliberately breaking cleanup release. Net-new feature work is frozen while the repository establishes one-directional component boundaries, repository-owned persistence, coherent workspace state, deterministic compilation, and optional subagent packaging.

The authoritative scope, diagrams, breaking-change disposition, phases, open implementation gates, and release criteria are in the [0.5 architecture plan](../design/architecture-0.5.md). Confirmed planning decisions are recorded there; template language and cross-extension host discovery remain pending spikes. Development and agent work follow the [architecture rules](architecture-rules.md).

The implementation order is:

1. Freeze, inventory, characterize, and run the remaining spikes (template language, host discovery) before affected phases start.
2. Extract shared resource codecs and repositories.
3. Establish `ForgeWorkspace`, `PromptStackService`, and `AgentProfileService`.
4. Introduce prompt-stack schema v2 and deterministic immutable-context compilation; remove mutable variables.
5. Simplify lifecycle, command, HTTP, and browser adapters; remove rejected compatibility/features.
6. Extract `pi-forge-subagents` behind a versioned host port.
7. Freeze explicit public entry points, remove `src/*`, document migration, and release.

Only one boundary-changing initiative should be active at a time. Sandbox, staged writes, new prompt features, and richer imports remain deferred until this sequence is complete.

## 0.4 baseline

The profile UI, foreground-delegation dogfooding, dependency compatibility work, and documentation reorganization are complete and merged to `main`. Runtime beta.2 is published, and the packed 0.4.0 extension passes the full verification surface against the documented Pi versions.

The 0.4.1 release adds scoped global profiles and prompt stacks with project-over-global shadowing, exact `project:<id>`/`global:<id>` selectors, scoped delegation authorization, untrusted-project global browsing, web-editor global create/fork/import, and zh-CN documentation. The accepted resolution model is archived in [scoped global profiles and prompt stacks](scoped-global-profiles-stacks.md).

Stable 0.4 does not imply that the subagent adapter or runtime has become stable. Prompt stacks and ordinary profile use remain independent of delegation.

## Deferred candidates

### Sandbox and staged writes

Evaluate an optional backend that can honestly enforce roots, process behavior, symlink containment, and requested network policy. Keep shared-user as an explicit compatibility boundary. Design writes as a separately approved staged patch/change set; do not add write/edit/shell tools directly to the shared-user child.

### History and prompt diagnostics

Candidate history controls need concrete use cases and dangling tool-pair tests. Provider-payload rewriting and display-only streaming regex remain deferred until a stable, previewable lifecycle hook exists. SillyTavern fidelity is no longer a core roadmap goal; 0.5 removes it or retains only a separately accepted minimal stateless converter.

## Product guardrails

- Prompt-stack JSON stays declarative; executable customization stays in trusted extensions/packages.
- Prompt rendering moves toward immutable inputs and explicit outputs; do not add mutable variable behavior during 0.5.
- Profiles remain one-shot presets, not continuous runtime owners.
- Tool and skill policy stays in prompt stacks, not profiles.
- Skill filtering is model-visible prompt filtering, not an invocation or security boundary.
- Delegation remains opt-in, foreground, clean-context, and fail-closed on missing capabilities, and moves to an optional package.
- Do not report shared-user read-only policy as an OS sandbox.
- New editor product workflows are frozen; migration changes retain real-browser coverage.
- Run the full verification and package checks before release.

The detailed completed 0.4 plan is retained in the [historical roadmap](../design/roadmap-0.4-archive.md).
