# Instruction modes (system-update)

[Documentation](../README.md) · [中文](../zh-CN/reference/instruction-modes.md)

Pi-forge introduces instruction modes: session-scoped prompt directives paired with dynamic tool selection. This reference details configuration, CLI usage, Web editing, Agent controls, delivery models, recovery boundaries, and compatibility limits.

## Requirements and installation

- **Host requirement:** Pi `>=0.87.0 <0.88.0` (repository dev SDK pinned to `0.87.0`, peer range `>=0.87.0 <0.88.0`; no dual 0.86 runtime support claim; development package version remains 0.5.4; 0.5.5 is not published).
- **Project trust:** Activating instruction modes, preset bindings, or manual directives requires a trusted project (`isProjectTrusted()`).

Instruction modes are JSON files stored in:

- **Project scope:** `.pi/forge/instruction-modes/<id>.json`
- **Global scope:** `~/.pi/forge/instruction-modes/<id>.json`

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.instruction-mode",
  "id": "review",
  "name": "Review",
  "description": "Report findings and evidence before editing.",
  "content": "List findings, evidence, and risks. Do not directly edit files.",
  "tools": {
    "add": [],
    "remove": ["bash", "powershell", "write", "edit"]
  }
}
```

### Resource rules

- **Literal content:** `content` is literal text (up to 100,000 characters). It is not a file path, script, or macro; template variables are not expanded.
- **Tool identifiers:** Names in `add` and `remove` arrays must be exact tool names (up to 128 characters, no whitespace, control characters, or wildcards `*`/`?`, max 256 tools per array).
- **Tool patch constraints:** Modes support `add` and `remove` ONLY; candidate `only` or mode-level allowlists are not implemented.
- **Resolution and shadowing:** Bare selectors use project-over-global shadowing. If a project mode contains invalid JSON, resolution fails closed locally; it does not fall back to global. Exact scopes can be targeted using `project:<id>` or `global:<id>`.

## Ownership scopes and lifecycle

- **Owner scopes:** Definitions (modes) are reusable resources stored in project or global libraries. Authorizations and bindings belong to Presets (`instructionModes` array in Preset metadata). Active state and activations belong strictly to Sessions.
- **Direct vs. bound use:**
  - Direct activation via CLI (`/system-update use <[scope:]id>`) or Web library activation creates an *unbound* session activation.
  - Bound activation via CLI (`/system-update use-bound <id>`) or Web preset binding activation creates a *preset-bound* session activation tied to the active Preset.
- **Immutable snapshot semantics:** Activation captures an immutable snapshot (`content`, `tools`, `fingerprint`). Modifying or deleting mode files on disk does not mutate already active session snapshots.
- **Same-Preset reload vs. switching:** Reloading the same Preset retains immutable active snapshots. Switching Presets automatically retires (lifecycle-deactivates) old bound activations while retaining manual and unbound user rules.
- **Revocation behavior:** Revoking a binding's authorization (`modelCallable: false`) or removing the binding from the Preset does not retroactively erase active snapshots; human CLI (`/system-update off` or `/system-update reset`) or Web panel deactivation is the recovery path.
- **User vs. Agent ownership and deduplication:** Activations record actor attribution (`user` vs `agent`). Repeated `use` of an already active mode is idempotent and never performs an automatic owner takeover between user and agent. Takeover requires an explicit deactivation and reactivation cycle.

## Preset-authorized Agent controls

Preset `instructionModes` bindings support autonomous Agent activation when explicitly authorized:

- **Model-callable tool:** The fixed-schema `forge_system_update` tool is registered once. Its visibility follows the normal executable tool selection; registration alone grants no mode authorization. Calls require an active Preset and use/off recheck the specific current binding.
- **Opt-in authorization:** Only bindings with `modelCallable: true` in the active Preset may be activated by the Agent; omission defaults to `false`.
- **Fixed parameter schema:** Accepts only `{ action: "list" | "status" | "use" | "off", id?: string }` (ID ≤ 128 characters).
  - `list`: lists currently eligible bound modes for the active Preset; use `status` to inspect active snapshots.
  - `status`: returns session active mode count, presentation model, delivery state, and effective tools.
  - `use`: requires binding `id`. Activates only authorized preset-bound modes with `modelCallable: true`.
  - `off`: requires `id` (binding ID or activation UUID). Stops only activations owned by the `agent`.
- **Safety and ownership fences:**
  - Rechecks project trust, active Preset, binding identity, `modelCallable: true`, and current tool policy on every call.
  - The Agent cannot stop human-owned activations.
  - The Agent cannot invoke `reset` or add arbitrary prompt directives.
  - The Agent cannot activate a mode that removes `forge_system_update`.
  - Disposed, restoring, or cross-session re-entry requests fail closed immediately.

Agent list/status replies intentionally omit full rule bodies: list returns authored descriptions and effects; status reports activity metadata. This avoids duplicating request-only instructions into ordinary tool history and later summaries. Human CLI/Web inspection still displays the complete frozen content. Genuine dialogue and authored descriptions are not scrubbed.

## Commands

Manage active instructions through `/system-update`:

| Command | Behavior |
|---|---|
| `/system-update list` | List available modes in project and global libraries with validation status. |
| `/system-update bindings` | List instruction mode bindings declared in the active Preset with authorization status. |
| `/system-update use <[scope:]id>` | Select and activate an unbound library mode (bare ID or qualified selector). |
| `/system-update use-bound <id>` | Activate a Preset binding by ID as a human; `modelCallable` is not required. |
| `/system-update status` | Show active mode count, presentation model, delivery state, and selected tools. |
| `/system-update off <activation-or-mode-id>` | Deactivate an active mode by activation UUID or mode ID. |
| `/system-update reset` | Deactivate all active instruction modes and manual directives (user only). |
| `/system-update add <text>` | Append a manual literal instruction rule to the active session without tool changes. |

**No inference cost:** All `/system-update` commands and Web activity panel actions execute locally. They update internal session state and synchronize tool policies without starting model inference or consuming API tokens for the operation itself. Instruction text consumes input tokens on subsequent model requests when inference occurs.

## Web resource editing

### Modes surface (CRUD)

The top-level **Modes** navigation surface supports full project and global instruction mode management:

- **Browse and inspect:** View mode ID, display name, description, instruction text, and tool modifications (`+add`, `-remove`), with validation diagnostics.
- **Create:** Author new modes in explicit project (`.pi/forge/instruction-modes/`) or global (`~/.pi/forge/instruction-modes/`) scope.
- **Edit and Save:** Edit display name, description, instruction content, and tool additions/removals. Mode IDs are immutable on save.
- **Delete:** Delete mode JSON files with confirmation.
- **Stale-save protection (`sourceRevision`):** Save and delete operations require the displayed `sourceRevision` (sha256 of raw source bytes). Stale requests fail with `409 Conflict`, preserving the user's draft in the editor.
- **Resource safety:** Saving a mode updates its library definition only and never activates it into the active session. Invalid JSON fails closed locally with diagnostics. Symlink targets and directories cannot be mutated.

### Preset metadata: instruction mode bindings

In the Preset editor under **Preset metadata → Instruction mode bindings**, author bindings between the Preset and library modes:

- **Qualified mode reference:** Requires a qualified reference (`project:<id>` or `global:<id>`).
- **Binding ID:** Unique binding identifier within the Preset; activation controls accept IDs up to 128 characters.
- **Agent authorization:** Toggle `modelCallable` (defaults to `false`) to permit Agent selection via `forge_system_update`.
- **Finite overrides:**
  - **Content override:** Choose between *None (use base content)*, *Replace* (`content`), or *Append* (`appendContent`, separated by two newlines).
  - **Tool overrides:** Independently set `tools.add` and `tools.remove` to *Omitted (keep base)*, *Explicit empty []* (clears base list), or *Custom tool list*.
  - Arbitrary fields, scripts, or inheritance chains cannot be authored.
- **Source vs. effective preview:** Side-by-side comparison displays source content/tools alongside effective content/tools, resolved through the same server resolver (`resolveInstructionModeBindings`) as runtime activation.
- **Stale-save guard:** Preset saves enforce a `sourceRevision` check against disk bytes whenever bindings are present or modified, rejecting stale overwrites (409 Conflict), including when external edits added bindings.

## Web session instructions panel

The web editor provides an expandable **Session instructions** activity panel beneath the top navigation bar.

### State display and active modes

- **Active modes list:** Lists active instruction modes and manual directives for the current session. Each card provides:
  - **Identity and source:** Activation ID, display name, and resolved source (e.g. `project:review`, `global:review`, or `manual`).
  - **Actor:** Attribution indicating whether the mode was activated by the `user` or an `agent`.
  - **Frozen snapshot content:** Collapsible preview of the exact literal rule text captured upon activation.
  - **Tool deltas and effective tools:** Item tool patch deltas (`+add`, `-remove`) alongside the session's overall effective tool selection (`effectiveTools`).
- **Delivery and presentation indicators:**
  - **Delivery status:** Displays `none` (no instruction events recorded yet), `pending` (updates queued for next request), or `prepared` (request context assembled for the current turn). The panel notes that `prepared` indicates prompt context preparation only, not remote model compliance or delivery confirmation.
  - **Text presentation:** Indicates whether instructions are projected as `native` system message sections or attributed `user` timeline updates.
- **Session controls:**
  - **Individual deactivation:** Click **Deactivate** to turn off a specific mode by its `activationId`.
  - **Reset confirmation:** The **Reset all** button initiates a two-step confirmation prompt (**Confirm reset** / **Cancel**) before clearing active instructions.

### Human activation picker (guarded preview and use)

The panel includes a human activation picker section:

- **Resource discovery (`GET /api/instructions/available`):** Pure read-only endpoint returning current session state and available choices categorized into *Library modes (unbound)* and *Current preset (bound)*. Read operations never mutate tool policies or session events.
- **Explicit pre-activation preview:** Selecting a mode in the dropdown renders an immediate pre-activation preview card displaying:
  - Label, ID, kind badge (`library` or `preset binding`), and short content fingerprint (`#<hash>`).
  - Tool diff preview (`+add`, `-remove`, or `No tool changes`).
  - Problem banner if the mode fails tool policy validation.
  - Full literal instruction content.
- **Guarded activation (`POST /api/instructions/use`):**
  - Payload sends `{ guard: { sessionId, leafId, revision }, kind, id, fingerprint }`.
  - Server re-verifies session guard and content fingerprint against disk definitions before applying.
  - If the session, branch, revision, or source file changed, the server rejects with `409 Conflict`.
  - Never automatically infers or retries.
  - Modifying requires project trust (`isProjectTrusted() === true`); untrusted sessions reject with `403 Forbidden`.

### Polling, state guarding, and security

- **Visibility-based polling with zero inference:** The web client polls `GET /api/instructions` (or `/api/instructions/available` after loading choices) every 3 seconds only while visible (`document.visibilityState === "visible"`), on window focus, or via manual refresh. All queries are local reads with zero LLM inference cost.
- **Manual reconciliation on error or conflict:** Errors, stale state, or 409 Conflicts mark the view as stale and require manual review. Mutations do not blindly retry.
- **Project trust requirement:** Modifying session instructions requires an explicitly trusted project (`isProjectTrusted() === true`). Untrusted sessions reject mutations with `403 Forbidden`; CLI recovery (`/system-update reset`) remains available.
- **State guard and lifecycle protection:** Mutations enforce derived guards (`sessionId`, `leafId`, `revision`). Unmounted or disposed runtimes return `503 Service Unavailable`.

### Local developer testing and host reload

When testing in a local developer harness with local build wiring already configured:
- Hot reloading the Pi host requires the user to run `/reload` in the Pi console.
- If a web server was already active prior to `/reload`, run `/preset ui restart` in the host and open the newly returned URL. The pre-existing web server closure retains previous route handlers and will not pick up newly added routes upon host reload alone. Global host switching is not automatic.

## Lifecycle and tool synchronization

- **Unified `context_with_system` pipeline:** In Pi 0.87, standard `context` lifecycle hooks intentionally exclude System messages. Forge moves the complete compiler, base prompt replacement, and instruction mode projection pipeline to `context_with_system` without an internal two-phase split.
- **Canonical projection with `buildSessionProjection`:** Runtime, Preview, and anchor helpers build against Pi 0.87's canonical `buildSessionProjection` (handling `context_edit` omissions, replacements, and `sourceEntry`), ensuring ephemeral request assembly reflects turn edits while raw session history remains untouched on disk.
- **Leading System preservation:** SDK incoming leading System prompts remain first; Forge's own prefix plain metadata anchors are inserted immediately after it.
- **Continuation and settlement lifecycle:** `agent_end` remains an anchor opportunity after a low-level run, provided no Forge context failure or incomplete tool batch remains, but the compile cycle and busy fence reset only on `agent_settled`. This ensures `agent_before_settle` continuations preserve compiled Preset state without dropping active modes.
- **Immediate tool sync vs. next-request prompt projection:**
  - Executable tool selection synchronizes *immediately* (`pi.setActiveTools()`). Disallowed tools are blocked at execution time.
  - Prompt text and native System sections or fallback user updates apply at the *next model request* boundary.
  - Running tool batches mid-flight are never interrupted.
- **Top-level policy precedence:** Modes cannot bypass Preset policies. If an active Preset denies a tool (`tools.deny`), a mode's `add` cannot enable it. Conflicting tool removals win globally across all active modes.
- **Baseline recovery:** Forge tracks a pristine session baseline to restore tools cleanly when modes are deactivated. If a pristine baseline cannot be recovered, Forge does not guess that all registered tools were previously active.
- **Parent lifecycle and re-entry fences:** Parent safeguards maintain `disposed` flags, `lifecycleRevision` counters, and strict `sameContext` verification, preventing cross-session pollution or operations after session disposal.

## Previewing instruction updates

The **Preview** dock evaluates the selected Preset draft against current session instruction snapshots:

- Uses the same pure preset/instruction projection as the request path: native named system sections or attributed user updates, including stop notices and compaction checkpoints.
- Delivery markers are pure metadata anchors and do not appear as dialogue messages.
- System body text, native named sections, and historical tool declarations are kept separate. Text copy contains only body/section values; inspector prose (`Added tool`, `Updated system prompt section`) is not inserted into native text.
- Historical tool declarations are collapsed and explicitly marked as not the current selection.
- Preview tool selection uses the evaluated draft policy plus current mode overlays.
- Text estimates exclude tool schemas and inspector labels; genuinely empty post-projection System cards are hidden.
- History is grouped only in consecutive runs: intervening instruction updates stay in chronological position between surrounding messages.
- Pure read-only inspection: Preview never mutates tool policies, commits session events, runs inference, or marks pending instructions prepared. Full preview text is not clipped at layout limits.

## Delivery models: native vs. fallback

Forge projects instruction deltas dynamically on each request through a two-stage assembly:

1. **Materialize before compilation:** Session context entries are projected via `buildSessionProjection` and scanned for plain `custom` metadata anchors (`pi-forge-instruction-delivery`). At the request context boundary (`prepareInstructionMessages`), anchors are validated and materialized into ephemeral in-memory markers at their exact ordinal positions matching the canonical projection, without modifying stored dialogue or raw session history.
2. **Rule projection:** `projectInstructionMessages` transforms materialized deltas into the appropriate model presentation:
   - **Native delivery:** When the provider supports mid-conversation system messages (`compat.supportsMidConvoSystemMessages === true`), updates are projected as request-only `SystemMessage.sections` keyed by activation identity (`forge-instruction-<id>`). Deactivations send null patches. Native delivery depends strictly on provider capability flags and is not universally guaranteed.
   - **Fallback delivery:** When native updates are unsupported, updates are projected as attributed timeline user messages (`[pi-forge instruction update]`). Forge never folds updates into the leading system prompt; genuine user/tool dialogue is never promoted to system authority.

## Recovery and offline verification

Active state is derived deterministically from session events and delivery cursors (`throughEventId`):

- **Plain metadata delivery anchors:** Delivery markers are stored as plain `custom` session entries using the same delivery type (`pi-forge-instruction-delivery`) with cursor-only metadata payload `{ schemaVersion: 1, throughEventId }`. They are not persisted as `custom_message` dialogue and do not use `sendMessage` steering. Idle updates anchor immediately; in-flight changes safely defer until after all tool results in a running batch complete; and `agent_end` anchors uncommitted deltas after the assistant's final response when no Forge context failure or incomplete batch remains. UI status notifications (`ctx.ui.setStatus`) are decoupled and never enqueue extra model turns.
- **Offline SDK verification:** State recovery across session reloads, manual compaction checkpoints, and branch tree navigation (`session.navigateTree`) is verified offline using SDK test harnesses. This confirms prompt assembly and tool gating, but does not provide an empirical guarantee of remote model compliance or obedience.
- **Compaction input and characterization:** Compaction checkpoints remain placed after the leading system prompt (`leadingSystem`) and before the compaction `summary` (placement unchanged; the upstream Pi metadata chunking bug is an independent issue and remains unfixed). Characterization tests verify real SDK summarization request inputs with simulated summaries. In this characterization, the summarizer observes user, assistant, and peer dialogue, but does not automatically receive new control metadata or request-only rule projections. Genuine dialogue quoting rule text is retained. Test-harness simulated responses verify request plumbing and harness shape, not remote LLM semantic compaction fidelity or summarizer compliance.
- **Backward compatibility and legacy sessions:** Existing sessions containing legacy `custom_message` delivery entries can still be read and recovered for backward compatibility. Forge does not migrate old entries on disk, nor does it erase or rewrite historical compaction summaries. **Explicit warning:** If a legacy session containing old `custom_message` carriers undergoes compaction, those old carriers may still contaminate summarizer input.
- **Session disk flushing:** In fresh sessions where only slash commands execute before the first assistant turn, Pi may not have flushed JSONL entries to disk yet.

## Compatibility and security boundaries

- **Upstream Pi 0.87 required:** Upstream Pi `>=0.87.0 <0.88.0` is required. Dual 0.86 runtime support is not provided. Extensions that previously manipulated or inspected full System messages in `context` must migrate to the full `context_with_system` hook.
- **Timing with `before_agent_start`:** Any forced System prompt injection via `before_agent_start` continues to execute later than `context_with_system`.
- **Preceding extension message rewrites:** Pi permits context hooks to rewrite messages. When visible metadata anchors or unanchored events need positioning, Forge requires a unique ordered alignment with the canonical session projection and fails closed if arbitrary preceding rewrites break alignment. Pi may persist queued custom messages absent from a tool follow-up: Forge permits only uniquely alignable custom-message omissions, ignores their regenerated envelope timestamps, and preserves incoming objects without restoring omitted dialogue. A preceding rewrite can therefore conflict with this locator; moving it later does not guarantee safe composition. Broad plugin, warming, and automatic-overflow compatibility remain unverified.
- **Upstream defect status and protocol limits:** Upstream Pi metadata chunking and semantic-cut defects are NOT patched and remain unfixed upstream. Compaction checkpoint placement is unchanged. Legacy sessions containing old `custom_message` carriers remain untouched without automatic disk migration; if compacted, old carriers may still contaminate summarizer input. Oh My Pi (OMP) is not supported or promised.
- **System prompt getters:** `ctx.getSystemPrompt()` and SDK getters return Pi's raw base prompt, not Forge's compiled request. Inspect compiled requests via `/payload` or Run context diffs. Forge does not claim to synchronize SDK getters. Extensions returning a full `systemPrompt` in lifecycle hooks cause forced projection conflicts and are unsupported.
- **Provider-managed tool transport and prompt caching:** Tool transport serialization and prompt prefix cache reuse are downstream provider-managed. Tool policy additions/removals, fallback formatting, and compaction alter prompt boundaries; pi-forge issues conservative provider-managed cache warnings and makes no guarantee of zero KV cache invalidation or exact cache hits.
- **Sandbox disclaimer:** Instruction modes provide no OS-level sandboxing or process isolation. The demo `review.json` removes `bash`, `powershell`, `write`, and `edit`, but does not block external MCP tools or subagents. Configure tool removals matching your specific execution tools.

## Implementation status (0.5.5-core)

The 0.5.5 core functional implementation is delivered in source across all planned lanes:

- Foundation codecs, scoped discovery, semantic events, and immutable snapshot reducer.
- Human CLI commands (`/system-update` add, list, bindings, use, use-bound, off, status, reset).
- Formal plain metadata delivery anchor projection with pre-compilation ordinal materialization.
- Web Session instructions activity panel and guarded human activation picker (`GET /api/instructions/available`, `POST /api/instructions/use`).
- Live Preset bindings (`instructionModes`) with finite overrides and opt-in `modelCallable: true`.
- Restricted model-callable `forge_system_update` agent tool (list, status, use, off, ID ≤ 128 chars).
- Web Modes surface (CRUD) and Preset metadata binding editor with live source-effective preview and `sourceRevision` stale-save guards.
- Parent safeguards: raw source/revision coherence, external new bindings stale-save detection, and lifecycle/re-entry fences.
- Tool patch schema supports `add` and `remove` only; candidate `only`/allowlist is not implemented.
- Conservative provider-managed prompt cache warnings; no automatic legacy migration or old summary rewrites; no Pi split patch; no claims of forced prompt, warming, auto overflow, or remote acceptance.
- Core parent build and full verification passed on Pi 0.87.0 (750 Node / 35 browser); package version remains 0.5.4, and release, git push, and host reload (`/reload`) are separate user-authorized actions.


Filesystem safety checks reject symlinks present when checked. They are not isolation against another local process racing directory replacement; revision checks likewise are not cross-process locking. Do not use resource mutation against an adversarial shared filesystem.
