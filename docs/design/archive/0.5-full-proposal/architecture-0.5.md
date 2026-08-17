# pi-forge 0.5.0 architecture plan

[Documentation](../../../README.md) · [Development rules](../../../development/architecture-rules.md) · [Roadmap](../../../development/roadmap.md)

Status: proposed

Date: 2026-08-17

0.5 is a deliberately breaking stabilization release. Its purpose is to make the extension understandable and evolvable before adding more features. Compatibility is preserved only where it has a demonstrated consumer and does not compromise the target boundaries.

## Problem statement

The 0.4 implementation is well tested, but feature throughput has outpaced architectural consolidation. Prompt stacks, profiles, web editing, mutable variables, imports, payload debugging, and subagents share state and orchestration paths. Several adapters perform application or persistence work directly, and internal file-shaped exports constrain reorganization.

The problem is not primarily file size. It is unclear ownership and too many ways to load, validate, mutate, compile, or present the same resources.

## Release goals

0.5 will:

- establish a one-directional architecture with explicit domain, application, port, infrastructure, and adapter layers;
- make a `ForgeWorkspace` the owner of coherent prompt-stack/profile resource state;
- unify stack/profile persistence behind scoped repositories and codecs while keeping their domain models separate;
- make prompt compilation deterministic over a normalized immutable environment;
- remove mutable turn/session variables and render-time variable mutation;
- replace the macro implementation only through an explicit template-engine contract, preserving a legacy reader only when migration requires it;
- extract optional subagent integration from the main extension through a versioned host port;
- remove or sharply reduce SillyTavern-specific functionality;
- replace wildcard internal exports with intentional package entry points;
- simplify commands and the web editor into adapters over shared application services.

## Non-goals

0.5 will not add orchestration, background agents, pipelines, retries, queues, new regex modes, richer imports, or new editor product surfaces. Sandbox and staged-write work remains deferred until the package and host boundaries are stable.

The refactor does not merge profiles, stacks, and compilation into one domain object. They share infrastructure and an application facade, but retain distinct responsibilities.

## Accepted architectural decisions

### Breaking cleanup is preferred to indefinite compatibility

0.5 may change JSON schema, public TypeScript APIs, commands, package exports, and internal storage coordination. Every user-visible break must have an explicit migration note; not every 0.4 feature requires a compatibility implementation.

### Mutable variables are removed

The following 0.4 behavior is removed from the 0.5 core design:

- turn and session variable stores;
- `setvar`, `setturnvar`, `setsessionvar`, and clear-variable macros;
- variable persistence in Pi session entries;
- the `variables` slot;
- render-time mutation through custom macro/slot contexts.

Templates receive an immutable context containing built-in runtime values. Static reusable values are retained as an immutable `parameters` object in stack schema v2; the v1 `stack.variables` string/JSON inconsistency is resolved by the v2 codec.

### SillyTavern is not a core architecture driver

The current fidelity-oriented importer, regex translation, report surface, command, guide, and dedicated example are removed from the core 0.5 scope.

Decision: **complete removal**. 0.4 is documented as the last supported conversion path. A richer converter can later live in a separate package without shaping the prompt compiler.

### Subagents become optional integration

The main extension retains profile/stack resolution and prompt preparation. A separate `pi-forge-subagents` extension owns delegation configuration, tools, commands, approval/progress UI, execution adaptation, and its dependency on `@zihanw/pi-subagent-runtime`.

The extraction must use a versioned Forge host port. It may not import internal runtime state, duplicate the active resource workspace, or make ordinary stack/profile usage depend on a subagent package.

Confirmed decisions:

- `@zihanw/pi-forge/subagent` remains a main-package entry point, but is cleaned into a versioned host port / host-neutral contract rather than re-exporting internal host preparation modules.
- The main package removes the hard dependency on `@zihanw/pi-subagent-runtime`; that dependency moves to `pi-forge-subagents` or becomes an optional peer dependency.
- The optional package may depend on the main package only through documented public ports.

### Schemas and public APIs restart deliberately

Prompt-stack schema v2 describes the cleaned compiler and template model. Agent-profile v2 is introduced only if its stored shape must change. The package no longer exports implementation modules through `src/*`; public surfaces are explicit entry points with documented stability.

## Confirmed 0.5.0 planning decisions

The following decisions were confirmed while this plan was in proposed status. Items still open are marked explicitly.

### Architecture direction

- A1: Target diagrams use port dependencies: `PromptStackService` / `AgentProfileService` depend on repository/host ports; `StackRepo` / `ProfileRepo` implement those ports.
- A2: Add an automatic dependency-direction check (`check:architecture`) during Phase 1/2.
- A3: When `src/*` exports are removed, update `scripts/check-package.mjs`, `docs/reference/public-api.md`, and public-API tests in the same change.
- A4: The release is referred to consistently as 0.5.0.

### Component ownership

- B1: `@zihanw/pi-forge/subagent` remains in the main package as a versioned host port / host-neutral contract, but its internal implementation surface is cleaned.
- B2: Remove the main package hard dependency on `@zihanw/pi-subagent-runtime`.
- B3: Forge extension loading/unloading and registry coordination are owned by `ForgeWorkspace`.
- B4: Tool-policy synchronization is defined as a port (`ToolPolicyPort`), called by `PromptStackService`; Pi adapter implements it.
- B5: Debug/payload/browser presentation state is a separate state slice, not part of the `ForgeWorkspace` resource snapshot.

### Schema and feature decisions

- B6: SillyTavern is removed completely from 0.5.0 core; 0.4 is the last supported conversion path.
- B7: Template language is still open; it will be decided after a spike.
- B8: Static reusable values are retained as immutable `parameters` in stack schema v2; the v1 `variables` codec inconsistency is fixed in v2.
- B9: Cross-extension host discovery will be decided after a focused spike; no final mechanism is assumed yet.

### Process decisions

- C1: Phase 0 produces an explicit inventory deliverable (for example `docs/design/0.5-inventory.md` or a comparable checklist).
- C2: Chinese documentation is updated for user-facing breaking changes; internal architecture documentation is not required to be fully synchronized.
- C3: No formal owner field is used; maintainer and agents together drive and review decisions.

## Current 0.4 architecture

```mermaid
flowchart TB
    Pi["Pi host"] --> Entry["index.ts composition root"]
    Entry --> Lifecycle["Lifecycle"]
    Entry --> StackRuntime["Stack runtime"]
    Entry --> ProfileRuntime["Profile runtime"]
    Entry --> PolicyRuntime["Policy runtime"]
    Entry --> WebRuntime["Web-editor runtime"]
    Entry --> SubRuntime["Subagent runtime"]

    State[("Shared PiForgeRuntimeState")]
    Lifecycle --> State
    StackRuntime --> State
    ProfileRuntime --> State
    PolicyRuntime --> State
    WebRuntime --> State
    SubRuntime --> State

    StackRuntime --> StackLoader["Stack loader + validation"]
    ProfileRuntime --> ProfileLoader["Profile loader + resolution"]
    ProfileRuntime --> StackRuntime
    StackRuntime --> ProfileRuntime

    Lifecycle --> Compiler["Compiler"]
    Compiler --> Macros["Stateful macros + variables"]
    Compiler --> Slots["Slot registry"]
    Compiler --> Regex["Regex transforms"]

    WebRuntime --> WebHost["Web host"]
    WebHost --> DirectIO["Direct stack filesystem mutations"]
    WebHost --> ProfileService["Profile service"]
    WebHost --> SubRuntime

    SubRuntime --> SubHost["Forge host preparation"]
    SubHost --> Compiler
    SubRuntime --> ExternalRuntime["pi-subagent-runtime"]
```

The high-risk connections are shared state ownership, circular stack/profile coordination, direct persistence in adapters, and optional subagent concerns reaching the core editor and composition root.

## Target package and component architecture

```mermaid
flowchart TB
    subgraph Main["@zihanw/pi-forge"]
        PiAdapters["Pi lifecycle + command adapters"]
        WebAdapters["HTTP + browser adapters"]
        Workspace["ForgeWorkspace"]
        StackService["PromptStackService"]
        ProfileService["AgentProfileService"]
        PiPorts["Pi runtime/environment adapters"]

        PiAdapters --> Workspace
        WebAdapters --> Workspace
        Workspace --> StackService
        Workspace --> ProfileService
        ProfileService --> StackService
    end

    subgraph Core["@zihanw/pi-forge-core"]
        ResourceCore["Scoped resources + catalogs"]
        StackDomain["Prompt-stack schema + codec"]
        ProfileDomain["Agent-profile schema + codec"]
        Compiler["PromptCompiler"]
        Templates["TemplateEngine registry"]
        Diagnostics["Common diagnostics"]
        Ports["Repository + host ports"]

        Compiler --> StackDomain
        Compiler --> Templates
        StackDomain --> ResourceCore
        ProfileDomain --> ResourceCore
    end

    subgraph Infra["Main extension infrastructure"]
        StackRepo["PromptStackRepository"]
        ProfileRepo["AgentProfileRepository"]
        AtomicFiles["Atomic scoped file store"]

        StackRepo --> AtomicFiles
        ProfileRepo --> AtomicFiles
    end

    StackService --> StackDomain
    StackService --> Compiler
    StackService --> Ports
    ProfileService --> ProfileDomain
    ProfileService --> Ports
    PiPorts --> Ports
    StackRepo -.->|implements| Ports
    ProfileRepo -.->|implements| Ports

    subgraph Optional["pi-forge-subagents"]
        SubAdapters["Commands + tools + approval UI"]
        SubHost["ForgeHostPort client"]
        SubRuntime["pi-subagent-runtime"]

        SubAdapters --> SubHost
        SubAdapters --> SubRuntime
    end

    Workspace -. "versioned host capability" .-> SubHost
```

`pi-forge-core` is host-neutral: it does not import the Pi extension API, HTTP, browser, TUI, or subagent runtime. If physical package extraction would delay boundary work, the same structure may land first as enforced internal modules and become a package before the subagent split.

## Target responsibilities

### ForgeWorkspace

- Own one immutable workspace snapshot containing scoped stack/profile catalogs and active selection/provenance references.
- Own Forge extension loading/unloading and registry coordination; coordinate resource reload and snapshot publication without circular runtime callbacks.
- Expose application services and resource-change subscriptions to adapters.
- Keep payload debugging and browser presentation state outside the resource snapshot.

### PromptStackService

- List, resolve, validate, create, update, fork, delete, activate, preview, and compile stacks.
- Own auto-activation selection and active-stack state transitions.
- Coordinate tool-policy changes through a `ToolPolicyPort` rather than calling UI, Pi API, or persistence code directly.

### AgentProfileService

- List, resolve, validate, create, update, delete, preflight, apply, and report provenance/drift.
- Apply model, thinking, and stack transactionally through a runtime-controller port.
- Resolve stack references through the workspace catalog, not through a separate loader.

### Repositories and codecs

- Repositories implement scoped discovery and safe mutation.
- Codecs are the only schema parsing, normalization, validation, serialization, and fingerprint source.
- Updates/deletes carry expected fingerprints to prevent overwriting unseen external changes.
- Filesystem writes use atomic replacement where the platform permits it.

### PromptCompiler and TemplateEngine

- Consume a normalized immutable `PromptEnvironment`, not a live Pi context.
- Return system prompt, prepared messages, sources, diagnostics, template dependencies, and an explicit variable/parameter receipt if parameters are retained.
- Keep history placement, structured runtime slots, tool/skill selection, and outgoing deterministic transforms as separate compiler stages.
- Use an engine contract with parse, analyze, and render operations. A restricted Jinja-like engine is a candidate, not yet an accepted dependency.

### Adapters

- Parse external input and render typed service results.
- Contain no resource persistence or duplicated schema validation.
- Browser view models and HTTP status mapping remain outside application/domain state.

## Proposed source layout

The exact filenames may evolve, but ownership should converge on:

```text
packages/
  core/
    src/resources/
    src/prompt-stacks/
    src/profiles/
    src/compiler/
    src/templates/
    src/ports/
  pi-forge/
    src/application/
    src/infrastructure/
    src/adapters/pi/
    src/adapters/commands/
    src/adapters/web/
  pi-forge-subagents/
    src/host/
    src/runtime/
    src/adapters/commands/
    src/adapters/tools/
```

Moving to a workspace is an implementation choice, not permission to move files before their interfaces and ownership are characterized.

## Feature disposition

| 0.4 capability | 0.5 disposition |
|---|---|
| Ordered prompt blocks and runtime slots | Keep and move into the v2 compiler |
| Scoped global/project resources | Keep behind common repositories/catalogs |
| Tool policy and model-visible skill filtering | Keep stack-owned |
| One-shot profiles, transactional apply, provenance, drift | Keep in `AgentProfileService` |
| Web stack/profile editor | Keep as adapters over services; simplify during migration |
| Prompt preview and redacted payload debugging | Keep; isolate debugging state |
| Turn/session variables and mutation macros | Remove |
| Static stack variables | Keep as immutable `parameters` in schema v2; fix the v1 string/JSON codec inconsistency |
| Current custom macro API | Break and replace with the template/slot extension contract |
| SillyTavern fidelity importer and regex emulation | Remove completely; 0.4 is the last supported conversion path |
| Regex history/compiled transforms | Keep initially; no new modes during 0.5 |
| Destructive finalized-transcript regex | Audit separately before schema v2 is frozen |
| Foreground subagent integration | Move to optional `pi-forge-subagents`; `@zihanw/pi-forge/subagent` remains as a versioned host port/contract |
| `src/*` package exports | Remove; update `check-package.mjs`, public API docs/tests in the same change |
| Legacy prompt-stack storage migration command | Remove after documenting the required pre-0.5 migration path |

## Implementation phases

### Phase 0: freeze and characterize

- Announce the 0.5 feature freeze in repository guidance and roadmap.
- Produce an explicit inventory deliverable covering public exports, persisted entries, commands, schemas, examples, and real internal consumers.
- Add characterization tests around any behavior that will move before changing ownership.
- Run the template-language spike and cross-extension host-discovery spike; record their findings before the affected phases start.
- Decide the remaining implementation gates listed under open decisions.

Exit: the removal/migration inventory is reviewed, and no unplanned feature work is in flight.

### Phase 1: resource core and repositories

- Introduce common diagnostic and loaded-resource envelopes.
- Extract stack/profile codecs.
- Implement repository ports and guarded filesystem repositories.
- Add the automatic dependency-direction check (`check:architecture`) so adapter/domain boundaries are enforced from this phase onward.
- Move all stack mutations out of `web-host.ts` and import commands.

Exit: every domain resource mutation uses a repository and has consistent stale-write/path-safety behavior.

### Phase 2: application services and workspace

- Consolidate stack operations into `PromptStackService`.
- Consolidate profile operations into `AgentProfileService`.
- Introduce `ForgeWorkspace` and publish coherent reload snapshots.
- Split debug/browser state away from resource state into a separate state slice.
- Replace circular stack/profile runtime wiring with workspace-owned services and ports.

Exit: commands, lifecycle, and web host use services; `PiForgeRuntimeState` is removed or reduced to adapter-owned state with no domain ownership.

### Phase 3: compiler and schema v2

- Define normalized `PromptEnvironment`, compiler result, and template-engine contracts.
- Remove mutable variables and session variable persistence.
- Select and implement the v2 template syntax.
- Make template dependency analysis authoritative.
- Decide the retained regex surface and freeze prompt-stack schema v2.

Exit: compilation is deterministic over immutable inputs, previews and runtime use the same entry point, and v1-to-v2 migration behavior is documented and tested.

### Phase 4: adapter cleanup

- Reduce Pi lifecycle modules to event adaptation.
- Reduce commands and HTTP handlers to parsing/result rendering.
- Split web view-model construction from application workflows.
- Remove SillyTavern surfaces from commands, web editor, docs, examples, and tests; update Chinese user docs for user-facing breaking changes.

Exit: dependency checks show adapters pointing inward with no direct resource persistence.

### Phase 5: subagent extraction and packages

- Validate cross-extension capability discovery with a focused spike.
- Publish the versioned Forge host port and clean `@zihanw/pi-forge/subagent` into that stable surface.
- Remove the main package hard dependency on `@zihanw/pi-subagent-runtime`.
- Move subagent configuration, commands, tools, UI, and runtime adaptation into `pi-forge-subagents`.
- Ensure main pi-forge installs and runs without subagent dependencies.
- Remove subagent UI/configuration from the core web editor unless an explicit contribution port is accepted.

Exit: ordinary stacks/profiles have no dependency on the optional package, and the optional extension consumes only documented public ports.

### Phase 6: public surface and release

- Replace root re-export sprawl with explicit package entry points.
- Remove `src/*` aliases and 0.4 compatibility barrels; update `check-package.mjs`, public API docs, and public API tests in the same change.
- Complete migration guide, changelog, package checks, and documentation rewrite; use 0.5.0 naming consistently.
- Run packed-install tests against supported Pi versions with and without `pi-forge-subagents`.

Exit: all release gates below pass.

## Open implementation-gate decisions

These are the remaining decisions that must be resolved before their affected implementation phases begin:

1. **Template language (spike completed; decision pending):** the Phase-0 [template-language spike](template-language-spike.md) rejects a broad Jinja-like engine and recommends a closed `forge-v1` AST grammar. Accept the exact grammar, environment schema, filter/condition set, extension-port disposition, schema representation, and migration behavior before Phase 3.
2. **Static parameters (decided):** retain a JSON-compatible immutable `parameters` object in stack schema v2; do not remove static reusable values.
3. **SillyTavern migration (decided):** complete removal; 0.4 is the last supported conversion path. No converter is retained in 0.5.0 core.
4. **Cross-extension host discovery (spike completed; decision pending):** the Phase-0 [Pi host-discovery spike](host-discovery-spike.md) validated Pi's shared in-process event bus across both extension load orders. It recommends a versioned, session-scoped event-bus RPC port with explicit duplicate-host detection and disposal; accept the protocol, operation catalogue, and package versioning before Phase 5.
5. **Pi session custom-entry versioning (open):** define explicit version, restoration, branch-navigation, malformed-entry, and migration semantics for prompt-stack selection and profile provenance entries. Define how removed variable entries are handled without recreating mutable state. Resolve before Phase 2/3 changes session restoration.
6. **Configuration ownership after subagent extraction (open):** `webEditor.*` remains owned by the main package. Decide whether `subagents.*`, which must be owned and written only by `pi-forge-subagents`, remains a namespaced section of `.pi/forge/config.json` or moves to dedicated optional-package configuration files; include migration and behavior when the optional package is absent. Resolve before Phase 4/5 changes configuration adapters.
7. **Final public-surface classification (open):** before Phase 6, use the Phase-0 inventory to classify every root and subpath surface as stable, experimental, internal, or removed; record named consumers, target entry points, and migration notices. Phase 6 must implement this accepted register rather than decide exports during removal.
8. **Pi compatibility policy (open):** define the minimum supported Pi version and rolling tested-version release matrix separately from wildcard host peers. Include packed main-only and main-plus-optional-package tests, plus a release-time npm `latest` probe. Resolve before Phase 1 establishes the supported CI matrix.

## Migration policy

- Provide a v1-to-v2 stack migration command or standalone script for mechanically convertible fields.
- Mutable variable behavior that cannot be preserved becomes an explicit migration diagnostic, not a silent approximation.
- Recommend running the final 0.4 release to convert legacy `.pi/prompt-stacks` storage before upgrading if 0.5 removes that migration command.
- Agent profiles retain IDs and scoped stack references where possible; migration rewrites only schema fields that actually change.
- SillyTavern users must convert with 0.4 before upgrading; 0.5.0 core does not retain a converter.
- No compatibility shim is accepted without a named consumer, test, warning/removal version, and owner.

## Release gates

0.5 is ready only when:

- dependency direction is checked automatically;
- all resource persistence is repository-owned;
- workspace reload and profile application have transactional/integration coverage;
- runtime and preview compilation share one compiler entry point;
- mutable variables and their persisted entries are removed or explicitly migrated;
- schema v2 and public entry points are documented without `src/*` exports;
- main pi-forge passes verification without installing the subagent extension/runtime;
- the optional subagent package passes host-version, preparation, approval, cancellation, and packed-install tests;
- current and target architecture diagrams match the implementation;
- English user documentation is updated and Chinese user-facing documentation is updated for breaking changes (internal architecture docs are not required to be fully synchronized);
- `npm run verify` and packed-install smoke tests pass on the documented Pi compatibility range.

## Deferred until after 0.5

- New prompt composition features.
- New import formats or high-fidelity external-preset emulation.
- Sandbox and staged subagent writes.
- Background/resumable agents, chains, queues, or orchestration.
- New web-editor surfaces unrelated to the migration.
- Additional regex or transcript-rewriting behavior.
