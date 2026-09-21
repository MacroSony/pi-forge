# Instruction modes — accepted 0.5.5 design

[Documentation](../README.md) · [Lean architecture](architecture-0.5.md) · [Roadmap](../development/roadmap.md)

**Status:** implementation authorized, 2026-09-20. Functional source is delivered across all planned lanes: foundation codecs, human CLI core (`/system-update`), plain metadata anchor projection, Web Session instructions activity panel, live Preset bindings (`instructionModes`) with finite overrides and opt-in `modelCallable: true`, restricted model-callable Agent control (`forge_system_update`), Web Modes surface CRUD with `sourceRevision` stale-save protection, Preset binding editor with source-effective preview, guarded human Web activation picker (`GET /api/instructions/available`, `POST /api/instructions/use`), and Pi 0.87 transcript/projection migration. Parent safeguards enforce raw source/revision coherence, external new-bindings stale-save protection, and lifecycle/re-entry fences (`disposed`, `lifecycleRevision`, `sameContext`). [Current reference](../reference/instruction-modes.md) states operational boundaries. Modes support `add`/`remove` only; candidate `only`/allowlist is not implemented. Parent build and full verification passed on Pi 0.87.0 (754 Node / 35 browser); development package version remains 0.5.4; 0.5.5 is not published; repo dev SDK is pinned to `0.87.0` with peer range `>=0.87.0 <0.88.0` (no dual 0.86 support claim).

This supersedes the [September 12 upstream-blocked proposal](archive/2026-09-12-system-update-design.md). Historical spike notes below reflect dated 0.86 exploration; current production architecture builds directly on Pi 0.87 APIs.

## Ownership and bounded scope

**Definitions are reusable; authorization belongs to Presets; active state belongs to Sessions.** Modes contain continuing collaboration/output guidance and optional tool selection changes. Skills remain the place for procedures, scripts and reference material.

- Forge owns semantic events, activation snapshots, derived delivery anchors and request-only instruction projection.
- Pi owns ordinary transcript storage/branching, message protocols, provider encoding and actual tool execution. No fork or private `AgentSession` patches.
- `ForgeWorkspace` remains the single resource-state owner. Existing codecs/repositories/catalogs are reused. The instruction reducer is a pure view, not a second mutable workspace.
- `tool-policy-runtime` remains the only Forge owner of executable tool selection. Text saying a tool is disabled is not enforcement.
- CLI, restricted Agent tool and Web UI share one application service. No dynamic control-tool schema, new registry/framework/package entry point, arbitrary JSON Patch, inheritance chain, mode dependencies, automatic resource bundling, or general undo/redo.

## Evidence behind the architecture

An isolated Pi 0.86 `AgentSession`/extension-runner spike used fake models/tools and intercepted adapter payload assembly; no provider HTTP was sent by that harness. Nineteen assertions and a separate smoke passed, including assertions that intentionally reproduce integration failures. They are not nineteen production features passing.

1. Keeping and mutating `before_agent_start.systemPromptOptions.sections` across a tool loop did not reliably synchronize later changes: the expected text sequence off/on/off became off/on/on while tools restored correctly. The command options getter was not a live-run setter.
2. Returning Forge's current full `systemPrompt` invokes Pi's forced request projection after context hooks; it suppresses later native system updates. `customPrompt` is not an exact replacement because the cwd contribution remains.
3. A Forge-owned marker/context projector worked in the sampled repeated toggle, native/user/native switch, branch/JSON reconstruction and manual-compaction scenarios. Those samples do not establish production crash recovery, automatic compaction, concurrency, old-Preset compatibility or tool-baseline recovery.
4. `systemPromptOptions.sections` is a prompt-building input; `SystemMessage.sections` is still useful as a native request representation. Failure of the tested thin bridge does not prove every upstream integration impossible.
5. `sendMessage` steering with explicit `triggerTurn:false` did not enter the next request in the tested live loop. Omitting it worked while streaming and did not start inference in the tested idle command. Context-hook exceptions alone are swallowed; explicit abort behavior must be accounted for.

The implemented request-base bridge preserves compiled replacement strings while retaining foreign named sections and tool declarations. Built-in base text and selected-tool macros refresh when the executable set changes.

**Production architecture:** management completely avoids transcript `sendMessage` and `custom_message` carriers, preventing dialogue contamination and spurious model turns. Under Pi 0.87, standard `context` hooks intentionally exclude System messages; Forge moves the entire compiler, base prompt replacement, and instruction mode projection pipeline to `context_with_system` without an internal two-phase split. Delivery is anchored using plain `custom` session entries under the same delivery type (`pi-forge-instruction-delivery`) carrying strictly cursor-only metadata (`{ schemaVersion: 1, throughEventId: string }`).

- **Anchor persistence points:**
  - **Idle:** persisted immediately upon `/system-update` execution or synchronization.
  - **Running session:** safely deferred while a tool loop is busy; anchors are never inserted between an in-flight tool call and its matching result.
  - **On `agent_end`:** uncommitted pending anchors are committed after the assistant's final response when no Forge context failure or incomplete batch remains, before the next user turn.
  - **Cycle reset on `agent_settled`:** while `agent_end` commits anchors, compile cycles and the busy fence reset only on `agent_settled`. This ensures `agent_before_settle` continuations preserve compiled Preset inputs and active modes across low-level runs.
- **Context assembly via canonical projection:**
  - Runtime, Preview, and anchor helpers build against Pi 0.87's `buildSessionProjection` (handling `context_edit` omissions, replacements, and `sourceEntry`). Raw session history on disk is never modified.
  - `prepareInstructionMessages` materializes before Preset compilation plain metadata anchors into ephemeral in-memory markers at their exact ordinal positions, verifying a unique ordered alignment against the canonical session projection.
  - Incoming SDK leading System prompts always remain first; Forge's own prefix plain metadata anchors are inserted after it.
  - `projectInstructionMessages` then projects active instruction deltas into native request-only `SystemMessage.sections` or fallback attributed timeline user messages.
- **Decoupled UI notification:** UI status notifications (`ctx.ui.setStatus` and Web activity panel) are completely independent and never enqueue turns to the model.

Preceding extension message rewrites (modifying messages in context hooks) are a legal and valid Pi SDK capability. However, Forge's anchor materialization requires a unique ordered alignment with canonical session entries. Content/protocol rewrites, inserted messages, non-custom omissions and ambiguous custom-message omissions fail closed. Prior full-System context extensions must move to `context_with_system`; `before_agent_start` forced System prompt injection continues to execute later in Pi's lifecycle; and final request arbitrary preceding rewrites still fail closed. Users may adjust conflicting extension order or extension behavior, but this is an operational suggestion only; Forge does not guarantee post-extension rewrite safety, nor can it guarantee generic plugin compatibility, prompt cache retention, warming, or automatic overflow handling. Upstream Pi metadata chunking and semantic-cut defects are NOT patched and remain unfixed upstream; legacy session carriers remain untouched, and Oh My Pi (OMP) is not supported or promised.

The SDK queue exception is explicit: persisted custom messages can be absent from the current tool follow-up and have different live/persisted envelope timestamps. Compare full content/protocol fields, ignore only the regenerated custom timestamp, and permit custom-message omissions only when earliest/latest ordered alignments agree. Identical ambiguous omissions fail closed. Never rebuild/overwrite incoming context or reinsert omitted peer messages.

## Resource and binding contract

Discovered directories:

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

The definition has no Agent authorization. Content is literal text, not an executable template or file path. `name`/`description` are optional; omitted tool arrays normalize to empty arrays. At least non-whitespace text or one tool effect is required. Content is bounded to 100,000 characters, name to 1,000, each tool array to 256 names and each exact tool name to 128 characters. Tool names cannot contain whitespace, controls, `*` or `?`. Modes support `add` and `remove` only; candidate `only` or mode-level allowlists are not implemented. Unknown and malformed fields fail closed.

Preset binding field:

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

The `instructionModes` field is live in the Preset schema and validated by codecs and editors. Saving a resource or binding never activates it.

- Direct library selection of a bare ID uses project-over-global. Invalid or duplicate local definitions do not fall back to global.
- A bare Preset reference resolves in its owner's scope. A project Preset must explicitly write `global:<id>` to use a global mode; a global Preset cannot use project modes.
- UI writes qualified references. Binding ID defaults to the referenced ID; duplicate effective binding IDs are rejected, including same-name cross-scope references unless explicitly disambiguated. At most 256 bindings per Preset.
- Only `modelCallable: true` grants eligibility for the Agent control path; omission defaults to `false`. Current tool policy and registration still apply on every call.
- Overrides allow `content` (replace) **or** `appendContent` (paragraph append with two newlines), never both. Each specified `tools.add`/`tools.remove` array replaces that entire field; the other field is preserved. Identity, name, authorization, and arbitrary fields cannot be overridden.
- Base resources must validate before applying overrides; an override cannot repair an invalid source silently. Effective results are defensive snapshots.

## Semantic events and snapshots

The internal schema is persisted through existing `session-adapter`/Pi custom entries, not a new persistence backend. Semantic entries carry validated snapshots; delivery messages carry only a versioned event cursor. Baseline records belong to the existing tool-policy owner.

Common event fields: `schemaVersion: 1`, `eventId`, `op`, `actor`, `createdAt` (finite nonnegative milliseconds). Branch order, not timestamps, determines reduction. Opaque event/activation IDs are at most 128 characters. Resource/Preset/binding IDs keep the existing grammar.

- **activate:** actor `user` or `agent`, with an immutable `snapshot` containing `activationId`, `source`, optional name, content, normalized tool patch, and content fingerprint.
- **deactivate:** targets an `activationId`; actor `user`, `agent` or `lifecycle`.
- **reset:** user only. Clears current activity, not historical events.
- Source is `{ kind: "manual" }` or `{ kind: "mode", key: { scope, id }, binding?: { preset: { scope, id }, id } }`.
- Agent activation requires an authorized bound mode (`modelCallable: true`). Agent deactivation cannot close user-owned activations. Lifecycle deactivation is restricted to bound modes; it cannot clear manual or unbound user rules.
- Unknown/repeated off is a no-op. Activation IDs cannot be reused within one branch even after reset/off. Repeated identical event IDs are no-ops without moving the latest event marker backwards; conflicting reuse fails closed.
- Repeated `use` is deduplicated and idempotent; it never performs an automatic owner takeover between user and agent. Takeover requires explicit deactivation and reactivation.
- Malformed owned event data fails reduction with an index/error, never a partially restored active set. Unrelated Pi entries are filtered by the adapter, not fed as fake instruction events.
- Fingerprints use Forge's canonical `sha256:v1` algorithm. The payload is domain-tagged effective source/name/content/tools, excluding activation ID. It represents content identity, not a cryptographic signature.

Snapshot content never drifts with source edits. Switching Presets appends deactivations for old bound activations while retaining manual and unbound user rules; reloading the same Preset retains immutable active snapshots. Revoked authorization does not retroactively erase active snapshots; human recovery via CLI or Web off/reset is the recovery path.

## Delivery, recovery, tools, and parent safeguards

Derived plain `custom` metadata entries anchor delivery; they do not independently own active state, duplicate authoritative snapshot payloads, or pollute conversation dialogue. One semantic history supports both presentations:

- Native: request-only `SystemMessage.sections` keyed by activation identity; off uses a null patch and Pi's existing removal wording, without an extra duplicate user notice.
- Unsupported models: an attributed timeline user update/stop notice. Do not silently fold Forge mode updates into the leading prompt. Genuine user/tool content is never promoted to system authority.
- Transform only clearly owned Forge rule content, never an entire mixed system message. Preserve unrelated content/sections and `toolsAdded`/`toolsRemoved` for Pi's adapters.
- Compaction requires an owned current-state checkpoint derived from semantic events; suppress pre-checkpoint anchors, including retained-tail copies, then replay later deltas. Request-only sections are not automatically saved by Pi's raw transcript checkpoint. Checkpoint placement remains unchanged (precedes summary, follows leading system prompt); the upstream Pi metadata chunking bug is an independent issue and remains unfixed.
- Compaction input characterization: in real SDK compaction, summarizers receive no metadata anchors and no Forge rule bodies (projection is request-only), while user, assistant, and peer dialogue are preserved. Simulated responses in test harnesses characterize request plumbing and harness shape, not remote LLM semantic compaction fidelity or summarizer compliance.
- Backward compatibility: legacy `custom_message` delivery entries can still be read and recovered for backward compatibility, but they are not migrated on disk, and historical compaction summaries are not erased or rewritten. **Warning:** legacy sessions containing old `custom_message` carriers may still contaminate summarizer input if compacted.
- Immediate tool synchronization vs. next-request prompt projection: admission validates text/reference/authorization/tool effects before commit. Executable tool policy synchronizes *immediately* (`sync()` / `setActiveTools()`), whereas prompt text and native sections or user updates take effect at the *next model request* boundary. Running tool batches are not interrupted.
- Tool policy calculation: tools are computed from a recoverable baseline plus all remaining additions minus all remaining removals, subject to top-level Preset deny policy; removal wins globally across active modes. Additions must be registered and permitted by the active Preset.
- Read-only resource discovery and Preview: inspecting modes, calling `GET /api/instructions/available`, or inspecting the Preview dock never mutates tool policies, commits session events, or marks pending instructions prepared.
- Parent safeguards:
  - Raw source and revision coherence: GET operations couple editable data and `sourceRevision` from the same raw file bytes.
  - External new bindings stale save detection: Preset saves enforce `sourceRevision` checks whenever bindings are present or modified, rejecting stale overwrites (409 Conflict) if the file changed on disk (including externally added bindings).
  - Lifecycle and re-entry fences: explicit `disposed` flag, `lifecycleRevision` increment, and `sameContext` verification prevent cross-session pollution or operations after session disposal.
- Provider-managed cache warning: prompt caching, tool transport, and KV cache hits are downstream provider-managed. Stable prefixes may help caching, but schema changes, removals, fallback, base recompilation, model switches, and compaction alter cache boundaries; pi-forge provides no guarantees of zero KV invalidation or exact cache hits.
- Human recovery: human CLI (`/system-update off`, `/system-update reset`) and Web panel controls remain available; an Agent-owned mode cannot disable its own control path without a safe recovery policy.

## Staged implementation and release gates

1. **Foundation (verified):** JSON codec, finite overrides, scoped resolution, immutable snapshots, and strict event reduction.
2. **Human CLI core and metadata anchor projection (implemented):** Pi 0.87 dependency upgrade, `context_with_system` full pipeline, `buildSessionProjection` canonical alignment, request-base bridge, scoped discovery, session event persistence, plain `custom` cursor-only metadata anchors (replacing transcript carriers), ordinal materialization, compaction checkpoints, and executable tool-policy coordination. Real SDK tests cover same-run toggles, native/fallback switches, fake tool execution, disk reopens, branches, crash-window baseline recovery, and legitimate preceding extension rewrite fail-closed safety.
3. **Session activity UI and compaction characterization (implemented):** read/control view derived from the existing runtime, never a second state owner. Human off/reset carries an exact session/leaf/revision guard with runtime-instance fencing; Web requires trust, pure reads never synchronize or infer, and stale pages cannot retry writes automatically. Real-SDK compaction-input characterization confirms Forge metadata and request-only rules are absent from summarizer history while user, assistant, and peer dialogue remain intact; fake test responses are plumbing characterization, not remote semantic validation.
4. **Preset authorization and restricted Agent control (implemented):** live Preset binding schema (`instructionModes`), opt-in `modelCallable: true`, and restricted fixed-schema `forge_system_update` (list, status, use, off, ID ≤ 128 chars). Per-call trust, binding identity, authorization, and tool policy checks prevent privilege escalation. CLI additions `/system-update bindings` and `/system-update use-bound <id>` provide human parity. Management operations do not initiate paid inference.
5. **Modes library CRUD, binding editor, and guarded human Web activation picker (delivered in functional source):** dedicated **Modes** surface for project/global mode CRUD with `sourceRevision` stale-save guards; Preset metadata bindings editor with finite overrides and live source-effective preview; guarded human Web activation picker (`GET /api/instructions/available`, `POST /api/instructions/use`) with pre-activation preview and session/leaf/revision plus content fingerprint validation. Parent safeguards enforce raw source/revision coherence, external new bindings stale-save detection, and lifecycle/re-entry fences.
6. **Release closeout (pending release review and user authorization):** Pi 0.87 migration passed parent build and full verification (754 Node / 35 browser). Development package version remains 0.5.4; 0.5.5 is not published; repo dev SDK is pinned to `0.87.0` with peer range `>=0.87.0 <0.88.0` (no dual 0.86 support claim); release, git push, and host reload (`/reload`) are separate user-authorized actions.

Acceptance includes old Presets, regex/history filtering, repeated same-run toggles, native/user/native transitions, request abort/retry/concurrency, explicit and automatic compaction, disk resume/branches/crash boundaries, baseline recovery, real tool-call rejection, external tool changes, warming, and payload/usage association.

No universal native support, obedience, zero-KV-invalidation, or guaranteed cache-hit claims. No automatic legacy migration, no old summary rewrites, and no Pi split patch. Publishing, host upgrades, reloads, and deployment remain separate user-authorized actions.
