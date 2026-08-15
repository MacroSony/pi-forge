# Roadmap

[Documentation](../README.md)

This file contains forward-looking product work only. Completed capability belongs in the [feature inventory](../reference/features.md), release history in the root [changelog](../../CHANGELOG.md), and completed investigation in the [design archive](../design/README.md).

## 0.4 baseline

The profile UI, foreground-delegation dogfooding, dependency compatibility work, and documentation reorganization are complete and merged to `main`. Runtime beta.2 is published, and the packed 0.4.0 extension passes the full verification surface against the documented Pi versions.

Stable 0.4 does not imply that the subagent adapter or runtime has become stable. Prompt stacks and ordinary profile use remain independent of delegation.

## Near-term candidates

### Scoped global profiles and stacks

If cross-project presets are added, introduce global profiles and stacks together. Preserve source scope, let same-ID project resources shadow global resources, and apply delegation policy only within the matching scope. Define discovery, auto-activation, reference, and editor behavior before implementation.

### Sandbox and staged writes

Evaluate an optional backend that can honestly enforce roots, process behavior, symlink containment, and requested network policy. Keep shared-user as an explicit compatibility boundary. Design writes as a separately approved staged patch/change set; do not add write/edit/shell tools directly to the shared-user child.

### Import, history, and prompt diagnostics

Add SillyTavern fidelity only from real unsupported fixtures. Candidate history controls need concrete use cases and dangling tool-pair tests. Provider-payload rewriting and display-only streaming regex remain deferred until a stable, previewable lifecycle hook exists.

## Product guardrails

- Prompt-stack JSON stays declarative; executable customization stays in trusted extensions/packages.
- Profiles remain one-shot presets, not continuous runtime owners.
- Tool and skill policy stays in prompt stacks, not profiles.
- Skill filtering is model-visible prompt filtering, not an invocation or security boundary.
- Delegation remains opt-in, foreground, clean-context, and fail-closed on missing capabilities.
- Do not report shared-user read-only policy as an OS sandbox.
- New editor workflows require real-browser coverage.
- Run the full verification and package checks before release.

The detailed completed 0.4 plan is retained in the [historical roadmap](../design/roadmap-0.4-archive.md).
