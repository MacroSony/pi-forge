# Roadmap

[Documentation](../README.md)

This file contains forward-looking product work only. Completed capability belongs in the [feature inventory](../reference/features.md), release history in the root [changelog](../../CHANGELOG.md), and completed investigation in the [design archive](../design/README.md).

## 0.5.0 breaking cleanup (lean)

0.5.0 is a deliberately breaking cleanup release plus the minimum foundation for 0.5.x. Net-new feature work is frozen.

The authoritative scope, accepted decisions, implementation lanes, and release gates are in the [lean 0.5 architecture plan](../design/architecture-0.5.md). The original six-phase architecture target remains the long-term goal and is archived in the [full proposal](../design/archive/0.5-full-proposal/README.md).

Current stabilization includes the accepted 0.5.1 generic-settings amendment and the accepted 0.5.2 message-merge, localization, regex-frequency, and finalize-role amendment recorded in that plan.

Implementation order:

0. Documentation convergence: archive the full proposal and make the lean plan active.
1a. Removals only: remove SillyTavern, mutable variable state/macros/slot, variable session entries, and regex `display`/`both`.
1b. Compiler, schema v2, and extension contract: implement `forge-v1`, frozen `PromptEnvironment`, immutable `parameters`, and the redesigned trusted extension port; retain `finalize` under lifecycle-adapter ownership.
1c. Migration and documentation: v1-to-v2 utility, example migration, and English/Chinese breaking notes.
1d. Compiler/extension conformance: pure slot contract symmetry, slot dependency resolution, shared dependency analysis/compilation context, lazy extension evaluation, nested conditionals, parser fixes, and focused conformance tests.
2a. Minimal repositories and codecs: make repositories/codecs the only stack/profile read/write path; defer fingerprint and atomic writes.
2b. ForgeWorkspace and host port v1: minimal snapshot owner plus `/subagent` discovery, profile listing/snapshot, and prepare with mandatory lifecycle semantics.
3. Subagent extraction: move subagent code into `pi-forge-subagents`; remove the main-package hard dependency and delegation UI; optional package owns dedicated `subagents.json` files.
3.5. Host-neutrality hardening: host-neutral prompt compiler, `ForgeWorkspace` as the single resource-state owner, optional-package docs/config alignment, and portable packed smoke.
4. Public surface and release: (4a) Forge-native host contract — main drops the runtime dependency and the synthetic preparation model, and the 0.4 execution contract moves to the optional package; (4b) public-surface cut — root default, root named extension API, and `/subagent` only, `src/*` aliases removed, package checks flipped to the allowlist; (4c) optional-package packed smoke over a loopback transport; (4d) migration notes and English/Chinese docs; (4e) packed-install verification and the 0.5.0 release.

Only one lane is active at a time. Sandbox, staged writes, new prompt features, richer imports, and the remaining full-plan architecture work remain deferred until after this sequence.

## 0.5.x continuation

After 0.5.0, continue toward the archived full target in small increments:

- expected-fingerprint writes, codec fingerprinting, and atomic persistence;
- full `PromptStackService` / `AgentProfileService` / `ForgeWorkspace` ownership;
- physical `pi-forge-core` boundaries and dependency-direction checking;
- complete host RPC catalogue, progress events, and optional subagent UI;
- public-surface classification and rolling Pi compatibility matrix.

## 0.4 baseline

The profile UI, foreground-delegation dogfooding, dependency compatibility work, and documentation reorganization are complete and merged to `main`. Runtime beta.2 is published, and the packed 0.4.0 extension passes the full verification surface against the documented Pi versions.

The 0.4.1 release adds scoped global profiles and prompt stacks with project-over-global shadowing, exact `project:<id>`/`global:<id>` selectors, scoped delegation authorization, untrusted-project global browsing, web-editor global create/fork/import, and zh-CN documentation. The accepted resolution model is archived in [scoped global profiles and prompt stacks](scoped-global-profiles-stacks.md).

Stable 0.4 does not imply that the subagent adapter or runtime has become stable. Prompt stacks and ordinary profile use remain independent of delegation.

## Deferred candidates

### Naming convergence (preset/stack)

Target model: **stack** names the composition section (ordered blocks/slots), **preset** names the file that bundles composition with tool/skill/regex policy, **profile** remains the model/thinking/preset bundle. The `/preset` command family already matches the target.

0.5.3 starts with the non-breaking user-visible layer: the web editor calls the complete resource a **Preset**, calls its ordered Block/Slot composition the **Stack**, and labels the old whole-resource Stack tab **Advanced**. User-facing diagnostics follow the same terminology. Compatibility identifiers remain unchanged in this phase: `/api/stacks`, TypeScript `PromptStack` names, `.pi/forge/prompt-stacks/`, JSON type `pi-forge.prompt-stack`, profile field `promptStack`, and the subagent wire contract.

The remaining storage/schema convergence must be bundled with breaking cleanup, never shipped as an implicit patch migration:

- Migrate `.pi/forge/prompt-stacks/` to `.pi/forge/presets/` byte-preserving, reusing the legacy stack-migration path; read-compat for the `"pi-forge.prompt-stack"` type, write `"pi-forge.preset"`.
- Profile field `promptStack` becomes `preset` with read-compat for the old field.
- Do **not** change the `/subagent` wire contract: keep `promptStackId` / `ForgeWirePromptStack` names as aliases; no port version bump, no coordinated pi-forge-subagents release, fingerprints unchanged.
- Do **not** split composition and policy into separate files (referential-integrity and activation-matrix complexity); fork covers "same layout, different policy".
- User-visible layer first: storage dirs, JSON type, web-editor labels, EN/zh-CN docs. Internal type names converge gradually via aliases.

### Sandbox and staged writes

Evaluate an optional backend that can honestly enforce roots, process behavior, symlink containment, and requested network policy. Keep shared-user as an explicit compatibility boundary. Design writes as a separately approved staged patch/change set; do not add write/edit/shell tools directly to the shared-user child.

### History and prompt diagnostics

Candidate history controls need concrete use cases and dangling tool-pair tests. Provider-payload rewriting and display-only streaming regex remain deferred until a stable, previewable lifecycle hook exists. SillyTavern fidelity is no longer a core roadmap goal; 0.5 removes it.

## Product guardrails

- Prompt-stack JSON stays declarative; executable customization stays in trusted extensions/packages.
- Prompt rendering moves toward immutable inputs and explicit outputs; do not add mutable variable behavior during 0.5.
- Profiles remain one-shot presets, not continuous runtime owners.
- Tool and skill policy stays in prompt stacks, not profiles.
- Skill filtering is model-visible prompt filtering, not an invocation or security boundary.
- Delegation remains opt-in, foreground, clean-context, and fail-closed on missing capabilities, and lives in the optional package.
- Do not report shared-user read-only policy as an OS sandbox.
- New editor product workflows are frozen; migration changes retain real-browser coverage.
- Run the full verification and package checks before release.

The detailed completed 0.4 plan is retained in the [historical roadmap](../design/roadmap-0.4-archive.md).
