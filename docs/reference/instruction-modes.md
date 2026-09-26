# Instruction modes (`/instruction`; `/system-update` compatibility alias)

[Documentation](../README.md) · [中文](../zh-CN/reference/instruction-modes.md)

Pi-forge introduces instruction modes: session-scoped prompt directives paired with dynamic tool selection. `/instruction` is the canonical CLI name; `/system-update` remains an exact compatibility alias. This reference details configuration, CLI usage, Web editing, Agent controls, delivery models, recovery boundaries, and compatibility limits.

## Requirements and installation

- **Host requirement:** Pi `>=0.87.0 <0.88.0` (repository dev SDK pinned to `0.87.0`, peer range `>=0.87.0 <0.88.0`; min SDK 0.87 unchanged; no dual 0.86 runtime support claim; development package version remains 0.5.4; target release 0.5.5, version bump pending).
- **Project trust:** Activating instruction modes, preset bindings, or manual directives requires a trusted project (`isProjectTrusted()`).
- **Compatibility:** Configurations utilizing `tools.initial` require a Forge version with this support; older Forge versions may ignore `initial`, so configurations are not downgrade-compatible.

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

- **Owner scopes:** Definitions (modes) are reusable resources stored in project or global libraries. Authorizations and bindings belong to Presets (top-level `instructionModes` array in the Preset JSON). Active state and activations belong strictly to Sessions.
- **Direct vs. bound use:**
  - Direct activation via CLI (`/instruction use <[scope:]id>`) or Web library activation creates an *unbound* session activation.
  - Bound activation via CLI (`/instruction use-bound <id>`) or Web preset binding activation creates a *preset-bound* session activation tied to the active Preset.
- **Immutable snapshot semantics:** Activation captures an immutable snapshot (`content`, `tools`, `fingerprint`). Modifying or deleting mode files on disk does not mutate already active session snapshots.
- **Same-Preset reload vs. switching:** Reloading the same Preset retains immutable active snapshots. Switching Presets automatically retires (lifecycle-deactivates) old bound activations while retaining manual and unbound user rules.
- **Revocation behavior:** Revoking a binding's authorization (`modelCallable: false`) or removing the binding from the Preset does not retroactively erase active snapshots; human CLI (`/instruction off` or `/instruction reset`) or Web panel deactivation is the recovery path.
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

### Read-first Worker

A minimal paired example: [Preset](../../examples/read-first-worker-prompt-stack.json) and [Write tools mode](../../examples/instruction-modes/write-tools.json). Use the matching 0.5.5-development build; older published Forge may ignore `tools.initial`.

1. In a trusted scratch project, copy the Preset to `.pi/forge/prompt-stacks/read-first-worker.json` and the mode to `.pi/forge/instruction-modes/write-tools.json`. Check for existing files first; do not overwrite your own resources. Importing the Preset alone does not install its referenced mode.
2. Start a fresh Pi session with Forge loaded, run `/preset reload`, then `/preset use project:read-first-worker`. The example has `autoActivate: false` and uses a **project-scoped** binding; a global copy needs a global mode and an updated `ref`.
3. With no other active modes, defaults are `read`, `ls`, and `forge_system_update`. The latter is a mode-management tool, not a file-writing tool. The model can list authorized bindings with `{ "action": "list" }`, enable commands/edits with `{ "action": "use", "id": "write-tools" }`, then stop its own activation with `{ "action": "off", "id": "write-tools" }`.
4. Observe `read, ls, forge_system_update` → plus `bash, edit` → defaults again in **Current session** or `/instruction status`. Other active modes still participate. If a human enabled the mode instead, the model cannot turn that human-owned activation off; stop it from the UI or `/instruction off <activation-id>`.

`allow` is the ceiling; `initial` selects defaults; `modelCallable: true` explicitly authorizes this binding without a new human approval prompt on each use. Change it to `false` if you want human-only activation. Off is requested by the sample prompt, not automatically enforced at task completion. It neither undoes changes nor terminates running tools. **Read-first is not a read-only sandbox:** `bash` can execute arbitrary commands, not just write files; these settings provide no filesystem/process isolation. This deliberately minimal replacement prompt omits Pi's normal project-context, skill and guidance slots; fork the default Pi mirror when you need them.

## Commands

Manage active instructions through the canonical `/instruction` command. `/system-update` remains an exact compatibility alias with the same handler and completions:

| Command | Behavior |
|---|---|
| `/instruction list` | Explicitly reload the instruction-mode library and list available modes with validation status. |
| `/instruction bindings` | List instruction mode bindings declared in the active Preset, including human-only bindings. |
| `/instruction use <[scope:]id>` | Select and activate an unbound library mode (bare ID or qualified selector). |
| `/instruction use-bound <id>` | Activate a Preset binding by ID as a human; `modelCallable` is not required. |
| `/instruction status` | Show active mode count, presentation model, delivery state, and selected tools. |
| `/instruction off <activation-or-mode-id>` | Deactivate an active mode by activation UUID or mode ID. |
| `/instruction reset` | Deactivate all active instruction modes and manual directives (user only). |
| `/instruction add <text>` | Append a manual literal instruction rule to the active session without tool changes. |
| `/instruction help` | Show command usage and compatibility notes. |

Completions use the current session and last published workspace snapshot. They do not perform discovery on every keystroke. Run `/instruction list` when an explicit discovery refresh is needed. Human-only bindings remain in `bindings`; `modelCallable: false` prevents Agent control but does not filter the binding from human inspection or activation.

**No inference cost:** All `/instruction` commands and Web activity panel actions execute locally. They update internal session state and synchronize tool policies without starting model inference or consuming API tokens for the operation itself. Instruction text consumes input tokens on subsequent model requests when inference occurs.

## Web resource editing

### Modes surface (CRUD)

The top-level **Modes** navigation surface supports full project and global instruction mode management:

- **Browse and inspect:** View mode ID, display name, description, instruction text, and tool modifications (`+add`, `-remove`), with validation diagnostics.
- **Create:** Author new modes in explicit project (`.pi/forge/instruction-modes/`) or global (`~/.pi/forge/instruction-modes/`) scope.
- **Edit and Save:** Edit display name, description, instruction content, and tool additions/removals. Mode IDs are immutable on save.
- **Grouped tool picker:** Mode tool selection (`+add` / `-remove`) includes a grouped picker organized by SDK `sourceInfo` (Pi built-in tools, packages, and top-level entry points). The picker saves exact concrete tool names: it does not persist package references or auto-install packages, and newly introduced tools from packages are not automatically added. Inactive registered tools remain visible in the picker; unloaded tools are unavailable in the session, but manually saved references are not discarded.
- **Delete:** Delete mode JSON files with confirmation.
- **Stale-save protection (`sourceRevision`):** Save and delete operations require the displayed `sourceRevision` (sha256 of raw source bytes). Stale requests fail with `409 Conflict`, preserving the user's draft in the editor.
- **Resource safety and save execution impact:** Saving an instruction mode updates its library definition only and never activates it into the active session. Invalid JSON fails closed locally with diagnostics. Symlink targets and directories cannot be mutated.

### Preset Mode bindings tab

In the Preset editor, instruction mode bindings are configured under the dedicated peer **Mode bindings** tab (`bindings`); Preset metadata no longer contains bindings:

- **Qualified mode reference:** Requires a qualified reference (`project:<id>` or `global:<id>`).
- **Binding ID and metadata:** Unique binding identifier within the Preset; activation controls accept IDs up to 128 characters.
- **Agent authorization:** Toggle `modelCallable` (defaults to `false`) to permit Agent selection via `forge_system_update`.
- **Collapsed advanced section:** Overrides and source-effective preview are collapsed under an advanced section to keep the primary binding list clear.
- **Finite overrides:**
  - **Content override:** Choose between *None (use base content)*, *Replace* (`content`), or *Append* (`appendContent`, separated by two newlines).
  - **Tool overrides:** Independently choose *Inherit* (omit the field) or *Custom override* (literal list, including explicit `[]` to clear the source list), with the integrated tool picker.
  - Arbitrary fields, scripts, or inheritance chains cannot be authored.
- **Source vs. effective preview:** Side-by-side comparison displays source content/tools alongside effective content/tools, resolved through the same server resolver (`resolveInstructionModeBindings`) as runtime activation.
- **Stale-save guard:** Preset saves enforce a `sourceRevision` check against disk bytes whenever bindings are present or modified, rejecting stale overwrites (409 Conflict), including when external edits added bindings.
- **Preset save execution impact:** Saving an inactive Preset updates its definition and does not select or activate it. Crucially, saving the currently active Preset immediately reloads and synchronizes its live tool and mode authorization policy in the session, without replacing frozen active mode snapshots.

## Web session instructions panel

The web editor retains a global **Session instructions** summary linking to the non-modal **Current session** workspace: mode/tool controls beside the current session projection. The Preset editing workspace retains its own Preview/Draft diff/Run diff dock; navigation preserves unsaved edits and inspection layout.

### State display and active modes

- **Active modes list:** Lists active instruction modes and manual directives for the current session. Each card provides:
  - **Identity and source:** Activation ID, display name, and resolved source (e.g. `project:review`, `global:review`, or `manual`).
  - **Actor:** Attribution indicating whether the mode was activated by the `user` or an `agent`.
  - **Frozen snapshot content:** A visible excerpt plus an expandable view of the exact literal rule text captured upon activation.
  - **Tool adjustments and effective tools:** Cards label configured patches separately from current effective tools. The latest successful action in this browser shows observed net additions/removals; overlapping Modes can leave the effective set unchanged.
- **Delivery and presentation indicators:**
  - **Delivery status:** Displays `none` (no instruction events recorded yet), `pending` (updates queued for next request), or `prepared` (request context assembled for the current turn). The panel notes that `prepared` indicates prompt context preparation only, not remote model compliance or delivery confirmation.
  - **Text presentation:** Indicates whether instructions are projected as `native` system message sections or attributed `user` timeline updates.
- **Session controls:**
  - **Individual deactivation:** Click **Deactivate** to turn off a specific mode by its `activationId`.
  - **Reset confirmation:** The **Reset all** button initiates a two-step confirmation prompt (**Confirm reset** / **Cancel**) before clearing active instructions.

### Human activation picker (guarded preview and use)

The panel includes a human activation picker section:

- **Session projection (`GET /api/instructions/preview`):** Read-only inspection of the active saved Preset and current mode snapshots, with session/leaf/revision and active-Preset fingerprint checks before and after compilation. The Preview sidecar links actual projected update blocks to activation IDs without modifying prompt messages. Requires a trusted session and active Preset; missing/stale context fails explicitly. This does not prepare a request, synchronize tools, or prove provider delivery/cache reuse.
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

- **Visibility-based polling with zero inference:** The web client quietly polls `GET /api/instructions` every 3 seconds only while visible (`document.visibilityState === "visible"`), on window focus, or via manual refresh. Catalog reads (`/api/instructions/available`) happen on workspace entry, explicit refresh and mutation follow-up, not every status poll. Unchanged background checks do not toggle loading/disable controls. The session projection follows semantic state changes and ignores late responses after leaving. All queries are local reads with zero LLM inference cost.
- **Manual reconciliation on error or conflict:** Errors, stale state, or 409 Conflicts mark the view as stale and require manual review. Mutations do not blindly retry.
- **Project trust requirement:** Modifying session instructions requires an explicitly trusted project (`isProjectTrusted() === true`). Untrusted sessions reject mutations with `403 Forbidden`; CLI recovery (`/instruction reset`, with `/system-update` retained as an alias) remains available.
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
- **Baseline recovery:** Turning off a mode recomputes Preset defaults plus remaining active modes. When neither Preset tool selection nor mode overlays apply, Forge restores the reconciled session baseline, including preserved external changes. If a baseline cannot be recovered, Forge does not guess that all registered tools were previously active.
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
   - **Tool-only modes:** A mode whose text is empty or whitespace-only sends no text update in either path — no section on activation, no removal notice when it stops, and nothing in compaction checkpoints. Only its tool changes reach the request, and **Current session** offers no Locate action for it.
   - **Which path applies:** The choice is made on each request from the current model's `compat` entry in Pi's model catalog, which Pi fetches and caches locally and may change with updates. The provider name, authentication method, or an auth extension does not decide it, and models from one provider can differ. For example, the catalog observed on 2026-09-26 with Pi 0.87.1 flagged `anthropic/claude-opus-4-8`, `claude-opus-5`, and `claude-opus-5-5`, but not `anthropic/claude-sonnet-5`. Switching with `/model` changes delivery for later requests. `/instruction status` and the Agent `status` action report `native system sections` or `attributed user updates`; check this before testing native updates or cache behavior.
   - **Fallback side effects:** For unflagged models, Pi also folds its own tool-change declarations into the leading system message and top-level tool list, so a tool change rewrites the start of the next request and its cached prefix is not reused. Some models may treat the labeled user update as untrusted text and question it before using the new tools.

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
- **System prompt getters:** `ctx.getSystemPrompt()` and SDK getters return Pi's raw base prompt, not Forge's compiled request. Inspect compiled requests via `/forge payload` (bare `/payload` remains compatible) or Run context diffs. Forge does not claim to synchronize SDK getters. Extensions returning a full `systemPrompt` in lifecycle hooks cause forced projection conflicts and are unsupported.
- **Provider-managed tool transport and prompt caching:** Tool transport serialization and prompt prefix cache reuse are downstream provider-managed. Tool policy additions/removals, fallback formatting, and compaction alter prompt boundaries. For compatible Codex transports, clean first-time tool additions can retain request prefixes; removals or same-name redeclarations anywhere in retained history switch to full-current-tool serialization. Provider cache hits are not guaranteed. Pi-forge issues conservative provider-managed cache warnings and makes no permission bypass or caching guarantees (zero KV cache invalidation is not guaranteed).
- **Sandbox disclaimer:** Instruction modes provide no OS-level sandboxing or process isolation. The demo `review.json` removes `bash`, `powershell`, `write`, and `edit`, but does not block external MCP tools or subagents. Configure tool removals matching your specific execution tools.

## Implementation status (0.5.5-core)

The 0.5.5 core functional implementation is delivered in source across all planned lanes:

- Foundation codecs, scoped discovery, semantic events, and immutable snapshot reducer.
- Human CLI commands (`/instruction` add, list, bindings, use, use-bound, off, status, reset; `/system-update` remains an alias).
- Formal plain metadata delivery anchor projection with pre-compilation ordinal materialization.
- Web Session instructions activity panel and guarded human activation picker (`GET /api/instructions/available`, `POST /api/instructions/use`).
- Live Preset bindings (`instructionModes`) in dedicated peer Mode bindings tab, with finite overrides, collapsed advanced view, and opt-in `modelCallable: true`.
- Restricted model-callable `forge_system_update` agent tool (list, status, use, off, ID ≤ 128 chars).
- Web Modes surface (CRUD) with SDK-grouped tool picker and `sourceRevision` stale-save guards.
- Preset policy custom default tools editor (`tools.initial?: string[]`) with concrete names, zero-default support (`[]`), and legacy fallback on omission.
- Parent safeguards: raw source/revision coherence, external new bindings stale-save detection, and lifecycle/re-entry fences.
- Tool patch schema supports `add` and `remove` only; candidate `only`/allowlist is not implemented.
- Conservative provider-managed prompt cache warnings; compatible Codex additional-tool delivery can preserve prefixes for new names when retained history has no removals/redeclarations; tool removal/redeclaration falls back to the current full tool list (not guaranteed cache hits); no automatic legacy migration or old summary rewrites; no Pi split patch; no claims of forced prompt, warming, auto overflow, or remote acceptance.
- Local build and full Node/browser/package verification passed at the 2026-09-24 UI closeout (commit `89c6ba2`); this is not remote-provider acceptance or publication. The target release is 0.5.5; development package metadata remains 0.5.4 pending coordinated release preparation. Pi `>=0.87.0 <0.88.0` remains required. Publishing, git push and host reload are separate user-authorized actions.


Filesystem safety checks reject symlinks present when checked. They are not isolation against another local process racing directory replacement; revision checks likewise are not cross-process locking. Do not use resource mutation against an adversarial shared filesystem.
