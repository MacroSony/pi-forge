# Scoped global profiles and prompt stacks

[Documentation](../README.md) · [Roadmap](roadmap.md)

Status: accepted design; implementation complete for 0.4.1 (identity, catalogs, scoped stacks/profiles, persistence, auto-activation, delegation, zh-CN docs, and web-editor global create/fork/import with explicit scope).

## Confirmed design decisions

Recorded before implementation started; these resolve the options left open by the analysis above.

- **D1** Unified resource ID grammar: `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` for both profiles and stacks. `:` is reserved for scope qualification and rejected in JSON IDs (with a diagnostic, not a load failure).
- **D2** When capturing/saving a profile, `promptStack` is serialized relative to the target profile scope: same scope writes a bare ID, a different scope writes a qualified selector (`global:<id>`), and a global profile is never allowed to reference a project stack (the save is rejected).
- **D3** Global profiles/stacks are loaded and can be browsed/previewed in untrusted projects, but applying a profile or stack still requires project trust.
- **D4** Subagent delegation remains entirely disabled in untrusted projects, including for global profiles.
- **D5** `default.json` has no special auto-activation role anymore. Only `autoActivate: true` participates in standalone stack activation. A `default.json` without an explicit `autoActivate` field receives a one-time migration warning; `autoActivate: false` remains an explicit opt-out. Multiple `autoActivate: true` stacks in the same scope fail closed.
- **D6** Legacy provenance records without a scope field are interpreted as project-scoped.
- **D7** `forge_subagent` accepts a bare `profileId` through effective lookup (project first) and `global:<id>` for exact global access; tool descriptions and `forge_subagent_profiles` explain the canonical selectors.
- **D8** New session entries and provenance persist the string selector form (`project:<id>` / `global:<id>`); `none` stays a scope-independent bare opt-out.
- **D9** Runtime state keeps flat `Loaded*[]` arrays whose entries carry `scope`/`key`; a shared catalog module owns `all`/`effective`/exact resolution.
- **D10** Web editor API routes encode scope as a single path segment (`scope:id`, e.g. `/api/stacks/global:reviewer`).
- **D11** A new `PI_FORGE_GLOBAL_DIR` environment override replaces the real `~/.pi/forge` for tests and embedders; loaders accept an explicit global Forge directory, and `globalForgeDir()` is only the default.
- **D12** Slice 5 is split into 5a (forge-config data model, scoped authorization, and unit tests) and 5b (discovery, tool descriptions, approval display, commands, docs, and browser verification).
- **D13** The web editor may edit/delete global resources when the route uses an explicit scope; unqualified routes remain project-only.


This note defines the resource identity, lookup, activation, persistence, and delegation model for adding user-global agent profiles and prompt stacks without weakening project shadowing or authorization boundaries.

## Goals

- Reuse profiles and prompt stacks across projects.
- Keep common commands concise through project-over-global shadowing.
- Preserve an explicit way to address either scope when IDs collide.
- Make stored profile dependencies deterministic rather than dependent on later shadowing.
- Keep global and project delegation authorization separate.
- Preserve existing project-only files and unqualified commands where no collision exists.

## Non-goals

- Do not add inheritance or merging between two profile or stack definitions.
- Do not make profiles continuously own runtime state.
- Do not move tool or skill policy from prompt stacks into profiles.
- Do not let a global profile depend on project-controlled prompt content.
- Do not add writable subagents, compaction settings, or a concurrency cap as part of this feature.

## Storage and identity

Global resources use the existing user-owned Forge root:

```text
~/.pi/forge/prompt-stacks/*.json
~/.pi/forge/agent-profiles/*.json
```

Project resources keep their current locations:

```text
<project>/.pi/forge/prompt-stacks/*.json
<project>/.pi/forge/agent-profiles/*.json
```

The JSON `id` remains an unqualified value such as `reviewer`. Scope comes from the storage location and must not be duplicated as an editable field in the file.

Every loaded resource must carry a first-class scoped identity:

```ts
type ResourceScope = "global" | "project";

interface ResourceKey {
	scope: ResourceScope;
	id: string;
}
```

Do not repeatedly infer scope from `filePath`. Loaded profiles and stacks should expose their scope/key directly, and runtime state should compare keys rather than bare IDs.

Duplicate IDs are errors only within one scope. A project and global resource with the same ID form a valid shadow pair.

## Selector syntax

Commands, completion candidates, profile stack references, persisted diagnostics, and delegation discovery use one selector grammar:

```text
reviewer
project:reviewer
global:reviewer
```

Existing resource IDs cannot contain `:`, so qualification is unambiguous. Reject unknown scope prefixes, empty IDs, and malformed selectors with a specific diagnostic.

The canonical formatter should return:

- `reviewer` only when presenting the effective unqualified resource;
- `project:reviewer` or `global:reviewer` when exact identity matters;
- qualified selectors for both resources when a collision must be shown.

Internally, parse selectors into `{ scope?: ResourceScope; id: string }` and resolve them to a required `ResourceKey` before mutation, application, persistence, or delegation.

## Two lookup modes

Unqualified interactive selection and unqualified profile dependencies deliberately use different lookup rules.

### Effective lookup

Commands such as `/preset use` and `/profile use` use effective lookup:

1. A qualified selector resolves only the named scope.
2. An unqualified selector resolves the project resource when present.
3. Otherwise it resolves the global resource.
4. A project definition shadows the same-ID global definition even when the project definition is invalid. The invalid shadow fails closed; it must not silently fall back to the global resource.

Examples:

```text
/profile use reviewer          # project first, otherwise global
/profile use global:reviewer   # exact global profile
/preset use project:reviewer   # exact project stack
```

Both colliding resources remain inspectable and explicitly selectable. Shadowing is an ergonomic default, not deletion of the global definition.

### Profile dependency lookup

A profile's `promptStack` is a stored dependency and must remain stable when unrelated files are later added. Its unqualified reference therefore resolves relative to the profile's own scope rather than through effective lookup.

| Profile scope | `"reviewer"` | `"project:reviewer"` | `"global:reviewer"` |
|---|---|---|---|
| Project | project stack | project stack | global stack |
| Global | global stack | rejected | global stack |

Consequences:

- A project profile may use either a project stack or an explicitly qualified global stack.
- A project profile with `"promptStack": "reviewer"` does not fall back to a global stack when the project stack is missing. The diagnostic should suggest `global:reviewer` when that global stack exists.
- A global profile may use only global stacks. `project:*` is rejected even if the project is trusted.
- Adding a project stack later cannot silently change the dependency of a project profile that explicitly uses `global:reviewer`.
- A project cannot replace the prompt or tool policy of a user-authorized global profile.

The string form remains sufficient for profile schema v1 because qualification expands the accepted reference syntax without adding a new field or object shape. Existing project profiles keep resolving their unqualified stack IDs to project stacks.

## Loading and catalogs

Global definitions are user-owned and may load independently of project trust. Project definitions load only when the project is trusted.

Pure loaders and tests must not accidentally read the developer's real home directory. Prefer an explicit catalog/repository input for the global Forge directory over relying on a process-wide environment variable. Existing project-only public loader functions may remain as compatibility wrappers while the extension runtime adopts scoped catalog loaders.

Maintain both views:

- `all`: every loaded scoped definition, including shadowed resources;
- `effective`: one resource per unqualified ID after project-over-global shadowing.

Centralize resolution helpers instead of continuing to use bare `array.find(candidate.id === id)` calls. Application, preview, mutation, auto-activation, subagent preparation, and the editor must resolve through the same catalog semantics.

## Selection and persistence

New session entries must persist the exact scoped key, not just the bare ID. This prevents a restored global selection from changing to a newly created project shadow after reload or tree navigation.

For compatibility:

- Read legacy branch entries containing only `activeStackId` using effective lookup.
- Write new entries with a scoped active-stack reference.
- Preserve the explicit `none`/`off` selection as a scope-independent opt-out.
- Profile provenance should add the profile scope/key while continuing to accept older provenance that has only `profileId` and `sourcePath`.
- Drift snapshots should store the resolved scoped stack reference so status can distinguish definition changes from a scope change.

Profile application remains transactional and one-shot. Later manual model/thinking changes remain respected; the selected stack continues enforcing its existing policy exactly as it does now.

## Auto-activation

Restored branch state and explicit opt-out continue to take precedence over all fresh-session defaults.

For agent profiles:

1. Inspect project `autoActivate: true` candidates first.
2. If any project candidate exists, do not fall back to a global candidate.
3. Exactly one usable project candidate applies; an invalid or ambiguous project selection fails closed.
4. If no project candidate exists, apply the same rules to global candidates.
5. A project and global auto-activation candidate are not a conflict because project scope has explicit precedence.

For standalone prompt-stack activation, apply the same scope precedence after profile auto-activation has declined to select a profile:

1. Only stacks with `autoActivate: true` participate; `default.json` has no filename-based activation role (D5).
2. Resolve project candidates before global candidates.
3. A same-ID project stack shadows the global stack, including an invalid shadow or `autoActivate: false` opt-out.
4. Exactly one usable candidate applies; multiple `autoActivate: true` stacks in the same scope fail closed.
5. Do not silently activate the global same-ID stack through an invalid or opted-out project shadow.
6. Preserve the existing rule that agent-profile auto-activation takes precedence over standalone stack activation, including profiles whose `promptStack` is `null`.

## Commands and editor behavior

Unqualified commands use effective lookup. Qualified commands address exact scope.

Recommended command behavior:

```text
/preset use reviewer
/preset use global:reviewer
/profile use project:reviewer
/profile preview global:reviewer
/profile save reviewer                 # project by default
/profile save global:reviewer          # explicit global mutation
```

Mutations must resolve the target scope before computing a path. Existing overwrite, changed-file, containment, and symbolic-link protections apply independently to each storage root. Global mutation must always be explicit; an unqualified save/fork/import continues to target project storage.

The web editor should:

- show global/project badges on profiles and stacks;
- show `shadows global:<id>` and `shadowed by project:<id>` states;
- retain both resources in navigation when IDs collide;
- require explicit scope for create, fork, import, save-as, and delete targets;
- prevent editing a shadowed global resource through an unqualified project route;
- keep the current token, trust, idle-state, overwrite, and browser-test protections for mutations.

Completions may prefer concise unqualified effective selectors, but must also offer qualified selectors when a collision exists or when the user has begun typing a scope prefix.

## Delegation boundary

Delegation authorization follows the profile's scope, not the effective unqualified ID:

- `~/.pi/forge/config.json` `subagents.profiles.<id>` authorizes only `global:<id>`.
- `<project>/.pi/forge/config.json` `subagents.profiles.<id>` authorizes only `project:<id>`.
- Same-ID global and project profiles never inherit enablement, backend, or timeout policy from one another.
- General backend, timeout, and summary defaults retain their current global-then-project layering.
- Deleting a profile clears delegation policy only from the matching scope's config.
- A global profile remains bound to global prompt content even when a project profile or stack shadows the same ID.

`forge_subagent_profiles` should return canonical callable selectors. When both scopes expose the same ID, the project profile may use the concise effective selector and the global profile must remain callable as `global:<id>`. The `forge_subagent` parameter, `/forge-agent` commands, embedded description summary, preparation lookup, approval display, fingerprints, and reports must retain exact scope.

Global profiles are user-owned, but ordinary delegation safety does not change: profiles remain disabled unless authorized in the matching config, unattended invocation remains a separate trusted-project decision, and read-only still does not imply an OS sandbox.

## Compatibility and migration

- No files move automatically.
- Existing `.pi/forge` and legacy `.pi/prompt-stacks` resources remain project-scoped.
- Existing project profile `promptStack` strings remain project-relative.
- Existing unqualified commands behave the same when no global collision exists.
- Legacy bare-ID session entries restore through effective lookup; all new entries record scope.
- Same-ID cross-scope definitions are valid and must not receive duplicate-ID errors.
- Duplicate IDs within one scope keep the current fail-closed diagnostics.
- Global `subagents.profiles` entries, which currently warn and are ignored, become scoped authorization for global profiles only. Document this behavior change prominently.
- Public loaded-resource types may add scope/key metadata without removing existing fields; compatibility helpers should continue accepting legacy bare IDs where persisted data requires them.

## Implementation slices

Each slice should land with focused tests and leave the full verification surface green.

### Slice 1: scoped identity and storage

- Add `ResourceScope`, `ResourceKey`, selector parsing/formatting, and exact/effective resolution primitives.
- Add global profile/stack directory and safe mutation-path helpers.
- Add scope/key metadata to loaded resources.
- Keep JSON IDs unqualified and validate selector syntax separately from ID syntax.
- Add table-driven parser, formatter, storage-containment, and same-ID-key tests.

Exit criterion: scoped resources can be represented and addressed without changing runtime loading behavior.

### Slice 2: scoped stack catalog and persistence

- Load global stacks plus trusted project/legacy stacks into `all` and `effective` views.
- Implement project shadowing, exact qualified selection, and invalid-shadow fail-closed behavior.
- Replace bare-ID runtime lookups with catalog resolution.
- Persist scoped active-stack references and restore legacy bare-ID entries.
- Apply scoped standalone stack auto-activation and explicit opt-out rules.

Exit criterion: `/preset` runtime behavior, branch restoration, tool policy, preview, and stack diagnostics operate correctly across both scopes before profiles are migrated.

### Slice 3: scoped profiles and dependency resolution

- Load global and trusted-project profiles with duplicate and auto-activation diagnostics scoped correctly.
- Implement the profile-to-stack resolution matrix.
- Extend preview, application, rollback, provenance, drift, save, delete, and reload with exact scoped keys.
- Preserve profile auto-activation precedence over standalone stacks.
- Extend host/subagent profile snapshots and fingerprints with resolved scope where required without changing legacy provenance fingerprint interpretation.

Exit criterion: global and project profiles apply deterministically, including explicit project-to-global stack reuse and rejection of global-to-project references.

### Slice 4: commands and web editor

- Add qualified parsing and completions to `/preset`, `/profile`, and editor APIs.
- Make unqualified mutations project-scoped and global mutations explicit.
- Show scope, collisions, shadow relationships, exact dependencies, and scoped drift in human surfaces.
- Add real-browser coverage for browsing, applying, editing, forking, deleting, collision handling, and failed scoped preflight.

Exit criterion: users can understand and manage both scopes without an unqualified action mutating a global resource.

### Slice 5: scoped delegation, documentation, and release verification

- Accept global profile authorization from global config and project profile authorization from project config.
- Update discovery, embedded summaries, callable selectors, `/forge-agent`, preparation, approval, reports, and policy cleanup.
- Test same-ID profiles with independent enablement/backend/timeout settings and no authority inheritance.
- Update English and Chinese concepts, guides, commands, configuration, schema/reference, feature inventory, changelog, and roadmap.
- Regenerate tracked browser assets and `dist`, then run `npm run verify` and a packed-install smoke test.

Exit criterion: scoped ordinary use and scoped delegation are documented, fail closed, package-clean, and verified end to end.

## Required scenario coverage

At minimum, automated tests should cover:

- Global-only, project-only, and same-ID collision lookup.
- Exact global access while shadowed.
- Invalid project shadow without global fallback.
- Global profile to global stack.
- Project profile to unqualified project stack.
- Project profile to explicitly qualified global stack.
- Missing project stack with a same-ID global suggestion but no fallback.
- Rejected global profile to project stack.
- Project auto-activation precedence, global fallback, ambiguity, invalid candidate, restored branch, and explicit opt-out.
- `default.json` no longer auto-activates by filename; missing `autoActivate` yields a migration warning (D5).
- Scoped session restoration after a new shadow appears.
- Scoped provenance and drift after source edits or scope changes.
- Independent global/project delegation authorization for the same ID.
- Deletion clearing only matching-scope delegation policy.
- Untrusted projects loading global resources but not project resources.
- Web-editor collision navigation and explicit-scope mutation safeguards.

## Architectural guardrails

- Keep resolution in shared catalog/services; do not duplicate shadow rules across commands, the editor, and subagent code.
- Never use project-over-global effective lookup for a stored global profile dependency.
- Never infer delegation authority from a bare ID after profile resolution.
- Never persist a new active selection or provenance record without exact scope.
- Never silently fall back across scopes after an explicit selector or an invalid shadow.
- Keep profile application transactional and tool/skill policy owned by the resolved prompt stack.
- Require the complete unit, browser, type, generated-output, documentation, and package verification surface for the final slice.
