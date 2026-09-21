# Instruction modes — accepted 0.5.5 design

[Documentation](../README.md) · [Lean architecture](architecture-0.5.md) · [Roadmap](../development/roadmap.md)

**Status:** implementation authorized, 2026-09-20. Foundation and human CLI core implemented, with real Pi 0.86/fake-provider tests for text/tools, disk resume, branches and manual compaction. [Current CLI reference](../reference/instruction-modes.md) states the remaining limits. Preset binding schema, Agent control and UI are not yet implemented. Package remains 0.5.4 until release preparation.

This supersedes the [September 12 upstream-blocked proposal](archive/2026-09-12-system-update-design.md). Pi 0.86.0 is released. Its actual behavior differs from the closed #9116/#9117 branches; those branch results are historical evidence, not a current contract.

## Ownership and bounded scope

**Definitions are reusable; authorization belongs to Presets; active state belongs to Sessions.** Modes contain continuing collaboration/output guidance and optional tool selection changes. Skills remain the place for procedures, scripts and reference material.

- Forge owns semantic events, activation snapshots, derived delivery anchors and request-only instruction projection.
- Pi owns ordinary transcript storage/branching, message protocols, provider encoding and actual tool execution. No fork or private `AgentSession` patches.
- `ForgeWorkspace` remains the single resource-state owner. Existing codecs/repositories/catalogs are reused. The instruction reducer is a pure view, not a second mutable workspace.
- `tool-policy-runtime` remains the only Forge owner of executable tool selection. Text saying a tool is disabled is not enforcement.
- CLI, restricted Agent tool and Web UI must share one application service. No dynamic control-tool schema, new registry/framework/package entry point, arbitrary JSON Patch, inheritance chain, mode dependencies, automatic resource bundling, or general undo/redo.

## Evidence behind the architecture

An isolated Pi 0.86 `AgentSession`/extension-runner spike used fake models/tools and intercepted adapter payload assembly; no provider HTTP was sent by that harness. Nineteen assertions and a separate smoke passed, including assertions that intentionally reproduce integration failures. They are not nineteen production features passing.

1. Keeping and mutating `before_agent_start.systemPromptOptions.sections` across a tool loop did not reliably synchronize later changes: the expected text sequence off/on/off became off/on/on while tools restored correctly. The command options getter was not a live-run setter.
2. Returning Forge's current full `systemPrompt` invokes Pi's forced request projection after context hooks; it suppresses later native system updates. `customPrompt` is not an exact replacement because the cwd contribution remains.
3. A Forge-owned marker/context projector worked in the sampled repeated toggle, native/user/native switch, branch/JSON reconstruction and manual-compaction scenarios. Those samples do not establish production crash recovery, automatic compaction, concurrency, old-Preset compatibility or tool-baseline recovery.
4. `systemPromptOptions.sections` is a prompt-building input; `SystemMessage.sections` is still useful as a native request representation. Failure of the tested thin bridge does not prove every upstream integration impossible.
5. `sendMessage` steering with explicit `triggerTurn:false` did not enter the next request in the tested live loop. Omitting it worked while streaming and did not start inference in the tested idle command. Context-hook exceptions alone are swallowed; explicit abort behavior must be accounted for.

The implemented request-base bridge preserves compiled replacement strings while retaining foreign named sections and tool declarations. Built-in base text and selected-tool macros refresh when the executable set changes.

**Production difference from the spike:** management uses `triggerTurn:false` so a command issued while the model is finishing cannot enqueue an extra paid turn. While Pi defers a carrier, request projection replays each missing semantic delta at the next naturally occurring request, including instance-specific off notices. Invalid state explicitly aborts before provider dispatch.

## Resource and binding contract

Discovered directories (read-only repository and ForgeWorkspace integration implemented):

- `.pi/forge/instruction-modes/*.json`
- `~/.pi/forge/instruction-modes/*.json`

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.instruction-mode",
  "id": "review",
  "name": "Review",
  "description": "Report findings and evidence before editing.",
  "content": "List findings, evidence and risks. Do not directly edit files.",
  "tools": {
    "add": ["grep", "find", "ls"],
    "remove": ["bash", "powershell", "write", "edit"]
  }
}
```

The definition has no Agent authorization. Content is literal text, not an executable template or file path. `name`/`description` are optional; omitted tool arrays normalize to empty arrays. At least non-whitespace text or one tool effect is required. Content is bounded to 100,000 characters, name to 1,000, each tool array to 256 names and each exact tool name to 128 characters. Tool names cannot contain whitespace, controls, `*` or `?`. Resource IDs retain the existing resource grammar. Unknown and malformed fields are errors, not silently normalized permissions.

Planned Preset field:

```json
{
  "instructionModes": [{
    "ref": "global:review",
    "id": "review",
    "modelCallable": true,
    "overrides": {
      "appendContent": "Also inspect backwards compatibility.",
      "tools": { "add": ["grep", "find"] }
    }
  }]
}
```

This field is **not yet accepted by the live Preset schema** in the current CLI slice. Saving a resource or binding must never activate it.

- Direct library selection of a bare ID uses project-over-global. Invalid or duplicate local definitions do not fall back to global.
- A bare Preset reference resolves exactly in its owner's scope. A project Preset must explicitly write `global:<id>` to use a global mode; a global Preset cannot use project modes.
- UI writes qualified references. Binding ID defaults to the referenced ID; duplicate effective binding IDs are rejected, including same-name cross-scope references unless explicitly disambiguated. At most 256 bindings per Preset.
- Only `modelCallable:true` grants eligibility for the future Agent control path; omission is false. Current tool policy and registration still apply.
- Overrides allow `content` **or** `appendContent`, never both. Nonempty paragraphs append with two newlines. Each specified `tools.add`/`tools.remove` array replaces that entire field; the other field is preserved. Identity, name, authorization and arbitrary fields cannot be overridden.
- Base resources must validate before applying overrides; an override cannot repair an invalid source silently. Effective results are defensive snapshots.

## Semantic events and snapshots

The internal schema is persisted through existing `session-adapter`/Pi custom entries, not a new persistence backend. Semantic entries carry validated snapshots; delivery messages carry only a versioned event cursor. Baseline records belong to the existing tool-policy owner.

Common event fields: `schemaVersion:1`, `eventId`, `op`, `actor`, `createdAt` (finite nonnegative milliseconds). Branch order, not timestamps, determines reduction. Opaque event/activation IDs are at most 128 characters. Resource/Preset/binding IDs keep the existing grammar rather than inheriting that opaque-ID bound.

- **activate:** actor `user` or `agent`, with an immutable `snapshot` containing `activationId`, `source`, optional name, content, normalized tool patch and content fingerprint.
- **deactivate:** targets an `activationId`; actor `user`, `agent` or `lifecycle`.
- **reset:** user only. Clears current activity, not historical events.
- Source is `{kind:"manual"}` or `{kind:"mode",key:{scope,id},binding?:{preset:{scope,id},id}}`.
- Agent activation requires a bound mode. Agent deactivation cannot close user-owned activations. Lifecycle deactivation is restricted to bound modes; it cannot clear manual or unbound user rules. These are structural/history-ownership checks, **not** verification of current `modelCallable`, registered tools or current Preset policy; the application service must do those checks before committing.
- Unknown/repeated off is a no-op. Activation IDs cannot be reused within one branch even after reset/off. Repeated identical event IDs are no-ops without moving the latest event marker backwards; conflicting reuse fails closed. Simultaneously active duplicate Preset binding IDs are rejected; the future service deduplicates repeated `use` before appending.
- Malformed owned event data fails reduction with an index/error, never a partially restored active set. Unrelated Pi entries are filtered by the adapter, not fed as fake instruction events.
- Fingerprints use Forge's existing canonical `sha256:v1` algorithm, moved into a shared internal helper without changing the subagent wire values. The payload is domain-tagged effective source/name/content/tools, excluding activation ID. It is content identity, **not a signature or protection against someone editing their own session file**.

Snapshot content never drifts with source edits. Switching Presets must append deactivations for old bound activations while retaining manual/unbound user rules; reloading the same Preset is not a switch. No event undoes file writes, kills running tools or erases historical facts. User takeover of an Agent activation must be explicit off/reapply rather than silently changing ownership on repeated use.

## Delivery, recovery and tools — implemented CLI core

Derived custom-message markers anchor delivery; they do not independently own active state or duplicate authoritative snapshot payloads. One semantic history must support both presentations:

- Native: request-only `SystemMessage.sections` keyed by activation identity; off uses a null patch and Pi's existing removal wording, without an extra duplicate user notice.
- Unsupported models: an attributed timeline user update/stop notice. Do not silently fold Forge mode updates into the leading prompt. Genuine user/tool content must never be promoted to system authority.
- Transform only clearly owned Forge rule content, never an entire mixed system message. Preserve unrelated content/sections and `toolsAdded`/`toolsRemoved` for Pi's adapters.
- Compaction requires an owned current-state checkpoint derived from semantic events; suppress pre-checkpoint carriers, including retained-tail copies, then replay later deltas. Request-only sections are not automatically saved by Pi's raw transcript checkpoint.
- Admission validates text/reference/authorization/tool effects before commit. Selected, pending and applied status must be distinct; text and executable selection change coherently at request boundaries. Already running batches are not killed.
- Compute tools from a recoverable baseline plus all remaining additions minus all remaining removals, subject to top-level policy; removal wins. Additions must be registered/permitted. Off is recomputation, not an inverse patch or restoration of a whole obsolete active-tool list. Preserve identifiable external changes.
- Restored active tools may already include effects; they cannot simply become the fresh baseline. Same-run changes, restart, branch, compaction and external changes are release gates. No OS-sandbox claim.
- Human recovery via CLI/Web must remain available; an Agent-owned mode cannot disable its own control path without a safe recovery policy.

## Staged implementation and release gates

Only one coherent lane is active at a time; workers may parallelize isolated parts within it.

1. **Foundation (verified):** JSON codec, finite overrides, scoped resolution, immutable snapshots and strict event reduction.
2. **Human CLI core (implemented):** Pi 0.86 peers/dependencies, request-base bridge, scoped discovery, session event/cursor persistence, compaction checkpoints and one executable-tool-policy owner. Real SDK tests cover same-run toggles, native/fallback switches, actual blocked/restored fake tool execution, disk reopens, branches and crash-window baseline recovery. No provider HTTP in these tests.
3. **Session activity UI (user-approved early usability lane):** read/control view derived from the existing runtime, never a second state owner. Human off/reset carries an exact session/leaf/revision guard with runtime-instance fencing; Web requires trust, pure reads never synchronize or infer, and stale pages cannot retry writes automatically. Real-SDK compaction-input tests exercise the summarization request but use fake responses: request-only Forge rules are absent from summarizer history, while generic carriers and ordinary assistant statements remain. Checkpoint placement is unchanged pending real-model comparison.
4. **Next — authorized controls:** live Preset binding schema and current authorization; restricted fixed-schema `forge_system_update` list/status/use/off. CLI and repository/service infrastructure are already present. Management alone must not initiate paid inference; human recovery remains available.
5. **Editor and release:** mode library, Preset binding/effective override diff, further activity/source-diff inspection; session/branch/revision stale-page checks; bilingual UI, migration/min-Pi notes, accurate README media and release verification.

Acceptance includes old Presets, regex/history filtering, repeated same-run toggles, native/user/native transitions, request abort/retry/concurrency, explicit and automatic compaction, disk resume/branches/crash boundaries, baseline recovery, real tool-call rejection, external tool changes, warming and payload/usage association. JSON round-trips and fake-provider tests alone do not certify these paths.

Stable prefixes may help caching, but schema changes, removals, fallback, base recompilation, model switches and compaction can invalidate it. No universal native support, obedience, zero-KV-invalidation or guaranteed cache-hit claims. Publishing, host upgrades, reloads and deployment remain separate user-authorized actions.
