# Capabilities (`/capability`)

[Documentation](../README.md) · [中文](../zh-CN/reference/capabilities.md)

Pi-forge introduces capabilities: session-scoped prompt directives paired with dynamic tool selection. `/capability` is the CLI command. This reference details configuration, CLI usage, Web editing, Agent controls, delivery models, recovery boundaries, and compatibility limits.

## Requirements and installation

- **Host requirement:** Minimum supported Pi version is 0.87.0. Published Forge 0.5.7 declared peer range `>=0.87.0 <0.88.0`; Forge 0.5.8 supports `>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || 1.0.0` (dev SDK 1.0.0, `typebox@1.3.27`; min SDK 0.87 unchanged; no dual 0.86 runtime support claim). Capabilities require Forge 0.5.5. See [Pi 1.0 compatibility guide](../guides/pi-1-compatibility.md).
- **Project trust:** Activating capabilities, preset bindings, or manual directives requires a trusted project (`isProjectTrusted()`).
- **Compatibility:** Configurations utilizing `tools.initial` require a Forge version with this support; older Forge versions may ignore `initial`, so configurations are not downgrade-compatible.

Capabilities are JSON files stored in:

- **Project scope:** `.pi/forge/capabilities/<id>.json`
- **Global scope:** `~/.pi/forge/capabilities/<id>.json`

```json
{
  "schemaVersion": 1,
  "type": "pi-forge.capability",
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
- **Tool patch constraints:** Capabilities support `add` and `remove` ONLY; candidate `only` or capability-level allowlists are not implemented.
- **Resolution and shadowing:** Bare selectors use project-over-global shadowing. If a project capability contains invalid JSON, resolution fails closed locally; it does not fall back to global. Exact scopes can be targeted using `project:<id>` or `global:<id>`.

## Ownership scopes and lifecycle

- **Owner scopes:** Definitions (capabilities) are reusable resources stored in project or global libraries. Authorizations and bindings belong to Presets (top-level `capabilities` array in the Preset JSON). Active state and activations belong strictly to Sessions.
- **Direct vs. bound use:**
  - Direct activation via CLI (`/capability enable <[scope:]id>`) or Web library activation creates an *unbound* session activation.
  - Bound activation via CLI (`/capability enable-bound <id>`) or Web preset binding activation creates a *preset-bound* session activation tied to the active Preset.
- **Immutable snapshot semantics:** Activation captures an immutable snapshot (`content`, `tools`, `fingerprint`). Modifying or deleting capability files on disk does not mutate already active session snapshots.
- **Same-Preset reload vs. switching:** Reloading the same Preset retains immutable active snapshots. Switching Presets automatically retires (lifecycle-deactivates) old bound activations while retaining manual and unbound user rules. A switch first checks the surviving capabilities against the target tool policy; a conflict rejects the switch without changing the current selection, tools, or activation events. Disable the conflicting capability before retrying. This does not retroactively modify frozen snapshots when their source files change.
- **Revocation behavior:** Revoking a binding's authorization (`modelCallable: false`) or removing the binding from the Preset does not retroactively erase active snapshots; human CLI (`/capability disable` or `/capability reset`) or Web panel deactivation is the recovery path.
- **User vs. Agent ownership and deduplication:** Activations record actor attribution (`user` vs `agent`). Repeated `enable` of an already active capability is idempotent and never performs an automatic owner takeover between user and agent. Takeover requires an explicit deactivation and reactivation cycle.

## Preset-authorized Agent controls

Preset `capabilities` bindings support autonomous Agent activation when explicitly authorized:

- **Model-callable tool:** The fixed-schema `forge_capability` tool is registered once. Its visibility follows the normal executable tool selection; registration alone grants no capability authorization. Calls require an active Preset and enable/disable recheck the specific current binding.
- **Opt-in authorization:** Only bindings with `modelCallable: true` in the active Preset may be activated by the Agent; omission defaults to `false`.
- **Fixed parameter schema:** Accepts only `{ action: "list" | "status" | "enable" | "disable", id?: string }` (ID ≤ 128 characters).
  - `list`: lists currently eligible bound capabilities for the active Preset; use `status` to inspect active snapshots.
  - `status`: returns session active capability count, presentation model, delivery state, and effective tools.
  - `enable`: requires binding `id`. Activates only authorized preset-bound capabilities with `modelCallable: true`.
  - `disable`: requires `id` (binding ID or activation UUID). Stops only activations owned by the `agent`.
- **Safety and ownership fences:**
  - Rechecks project trust, active Preset, binding identity, `modelCallable: true`, and current tool policy on every call.
  - The Agent cannot stop human-owned activations.
  - The Agent cannot invoke `reset` or add arbitrary prompt directives.
  - The Agent cannot activate a capability that removes `forge_capability`.
  - Disposed, restoring, or cross-session re-entry requests fail closed immediately.

Agent list/status replies intentionally omit full rule bodies: list returns authored descriptions and effects; status reports activity metadata. This avoids duplicating request-only instructions into ordinary tool history and later summaries. Human CLI/Web inspection still displays the complete frozen content. Genuine dialogue and authored descriptions are not scrubbed.

### Read-first Worker

A minimal main-package example pair: [Preset](../../examples/read-first-worker-prompt-stack.json) and [Write tools capability](../../examples/capabilities/write-tools.json). Use Forge 0.5.5; older published Forge may ignore `tools.initial`. Optional subagent execution remains an independent unfinished release.

1. In a trusted scratch project, copy the Preset to `.pi/forge/prompt-stacks/read-first-worker.json` and the capability to `.pi/forge/capabilities/write-tools.json`. Check for existing files first; do not overwrite your own resources. Importing the Preset alone does not install its referenced capability.
2. Start a fresh Pi session with Forge loaded, run `/preset reload`, then `/preset use project:read-first-worker`. The example has `autoActivate: false` and uses a **project-scoped** binding; a global copy needs a global capability and an updated `ref`.
3. With no other active capabilities, defaults are `read`, `ls`, and `forge_capability`. The latter is a capability-management tool, not a file-writing tool. The model can list authorized bindings with `{ "action": "list" }`, enable commands/edits with `{ "action": "enable", "id": "write-tools" }`, then disable its own activation with `{ "action": "disable", "id": "write-tools" }`.
4. Observe `read, ls, forge_capability` → plus `bash, edit` → defaults again in **Current session** or `/capability status`. Other active capabilities still participate. If a human enabled the capability instead, the model cannot turn that human-owned activation off; stop it from the UI or `/capability disable <activation-id>`.

`allow` is the ceiling; `initial` selects defaults; `modelCallable: true` explicitly authorizes this binding without a new human approval prompt on each use. Change it to `false` if you want human-only activation. Off is requested by the sample prompt, not automatically enforced at task completion. It neither undoes changes nor terminates running tools. **Read-first is not a read-only sandbox:** `bash` can execute arbitrary commands, not just write files; these settings provide no filesystem/process isolation. This deliberately minimal replacement prompt omits Pi's normal project-context, skill and guidance slots; fork the default Pi mirror when you need them.

## Commands

Manage active instructions through the `/capability` command:

| Command | Behavior |
|---|---|
| `/capability list` | Explicitly reload the capability library and list available capabilities with validation status. |
| `/capability bindings` | List capability bindings declared in the active Preset, including human-only bindings. |
| `/capability enable <[scope:]id>` | Select and activate an unbound library capability (bare ID or qualified selector). |
| `/capability enable-bound <id>` | Activate a Preset binding by ID as a human; `modelCallable` is not required. |
| `/capability status` | Show active capability count, presentation model, delivery state, and selected tools. |
| `/capability disable <activation-or-capability-id>` | Deactivate an active capability by activation UUID or capability ID. |
| `/capability reset` | Deactivate all active capabilities and manual directives (user only). |
| `/capability add <text>` | Append a manual literal instruction rule to the active session without tool changes. |
| `/capability help` | Show command usage and command details. |

Completions use the current session and last published workspace snapshot. They do not perform discovery on every keystroke. Run `/capability list` when an explicit discovery refresh is needed. `/capability enable` completions offer bare IDs when unique, and qualified selectors on same-ID collision or when typing a `:` scope prefix (with labels always qualified by source and name). Human-only bindings remain in `bindings`; `modelCallable: false` prevents Agent control but does not filter the binding from human inspection or activation.

**No inference cost:** All `/capability` commands and Web activity panel actions execute locally. They update internal session state and synchronize tool policies without starting model inference or consuming API tokens for the operation itself. Instruction text consumes input tokens on subsequent model requests when inference occurs.

## Web resource editing

### Capabilities surface (CRUD)

The top-level **Capabilities** navigation surface supports full project and global capability management. Its library API is `GET /api/capabilities`, with selector and effective variants at `/api/capabilities/<selector>` and `/api/capabilities/effective`.

- **Browse and inspect:** View capability ID, display name, description, instruction text, and tool modifications (`+add`, `-remove`), with validation diagnostics.
- **Create:** Author new capabilities in explicit project (`.pi/forge/capabilities/`) or global (`~/.pi/forge/capabilities/`) scope.
- **Edit and Save:** Edit display name, description, instruction content, and tool additions/removals. Capability IDs are immutable on save.
- **Grouped tool picker:** Capability tool selection (`+add` / `-remove`) includes a grouped picker organized by SDK `sourceInfo` (Pi built-in tools, packages, and top-level entry points). The picker saves exact concrete tool names: it does not persist package references or auto-install packages, and newly introduced tools from packages are not automatically added. Inactive registered tools remain visible in the picker; unloaded tools are unavailable in the session, but manually saved references are not discarded.
- **Delete:** Delete capability JSON files with confirmation.
- **Stale-save protection (`sourceRevision`):** Save and delete operations require the displayed `sourceRevision` (sha256 of raw source bytes). Stale requests fail with `409 Conflict`, preserving the user's draft in the editor.
- **Resource safety and save execution impact:** Saving a capability updates its library definition only and never activates it into the active session. Invalid JSON fails closed locally with diagnostics. Symlink targets and directories cannot be mutated.

### Preset Capability bindings tab

In the Preset editor, capability bindings are configured under the dedicated peer **Capability bindings** tab (`bindings`); Preset metadata no longer contains bindings:

- **Qualified capability reference:** Requires a qualified reference (`project:<id>` or `global:<id>`).
- **Binding ID and metadata:** Unique binding identifier within the Preset; activation controls accept IDs up to 128 characters.
- **Agent authorization:** Toggle `modelCallable` (defaults to `false`) to permit Agent selection via `forge_capability`.
- **Collapsed advanced section:** Overrides and source-effective preview are collapsed under an advanced section to keep the primary binding list clear.
- **Finite overrides:**
  - **Content override:** Choose between *None (use base content)*, *Replace* (`content`), or *Append* (`appendContent`, separated by two newlines).
  - **Tool overrides:** Independently choose *Inherit* (omit the field) or *Custom override* (literal list, including explicit `[]` to clear the source list), with the integrated tool picker.
  - Arbitrary fields, scripts, or inheritance chains cannot be authored.
- **Source vs. effective preview:** Side-by-side comparison displays source content/tools alongside effective content/tools, resolved through the same server resolver (`resolveCapabilityBindings`) as runtime activation.
- **Stale-save guard:** Preset saves enforce a `sourceRevision` check against disk bytes whenever bindings are present or modified, rejecting stale overwrites (409 Conflict), including when external edits added bindings.
- **Preset save execution impact:** Saving an inactive Preset updates its definition and does not select or activate it. Crucially, saving the currently active Preset immediately reloads and synchronizes its live tool and capability authorization policy in the session, without replacing frozen active capability snapshots. If the proposed policy conflicts with those snapshots, saving or overwriting the active Preset is rejected before writing the file; disable the conflicting capability and retry. Editing files outside Forge bypasses this preflight and may require manual recovery after reload.

## Web session capabilities panel

The web editor retains a global **Session capabilities** summary linking to the non-modal **Current session** workspace: capability/tool controls beside the current session projection. The Preset editing workspace retains its own Preview/Draft diff/Run diff dock; navigation preserves unsaved edits and inspection layout.

### State display and active capabilities

- **Active capabilities list:** Lists active capabilities and manual directives for the current session. Each card provides:
  - **Identity and source:** Activation ID, display name, and resolved source (e.g. `project:review`, `global:review`, or `manual`).
  - **Actor:** Attribution indicating whether the capability was activated by the `user` or an `agent`.
  - **Frozen snapshot content:** A visible excerpt plus an expandable view of the exact literal rule text captured upon activation.
  - **Tool adjustments and effective tools:** Cards label configured patches separately from current effective tools. The latest successful action in this browser shows observed net additions/removals; overlapping Capabilities can leave the effective set unchanged.
- **Delivery and presentation indicators:**
  - **Delivery status:** Displays `none` (no capability events recorded yet), `pending` (updates queued for next request), or `prepared` (request context assembled for the current turn). The panel notes that `prepared` indicates prompt context preparation only, not remote model compliance or delivery confirmation.
  - **Text presentation:** Indicates whether capability instructions are projected as `native` system message sections or attributed `user` timeline updates.
- **Session controls:**
  - **Individual deactivation:** Click **Deactivate** to turn off a specific capability by its `activationId`.
  - **Reset confirmation:** The **Reset all** button initiates a two-step confirmation prompt (**Confirm reset** / **Cancel**) before clearing active capabilities and manual directives.
- **Prompt cache usage:** When prompt caching statistics exist on the current branch, the panel renders prompt-cache hit rates and request counts for the current turn and session, maintaining visible separation between main assistant requests and nested tool runs. See [Session cache usage](session-cache.md).

### Human activation picker (guarded preview and use)

The panel includes a human activation picker section:

- **Session projection (`GET /api/capability-state/preview`):** Read-only inspection of the active saved Preset and current capability snapshots, with session/leaf/revision and active-Preset fingerprint checks before and after compilation. The Preview sidecar links actual projected update blocks to activation IDs without modifying prompt messages. Requires a trusted session and active Preset; missing/stale context fails explicitly. This does not prepare a request, synchronize tools, or prove provider delivery/cache reuse.
- **Resource discovery (`GET /api/capability-state/available`):** Pure read-only endpoint returning current session state and available choices categorized into *Library capabilities (unbound)* and *Current preset (bound)*. Read operations never mutate tool policies or session events.
- **Explicit pre-activation preview:** Selecting a capability in the dropdown renders an immediate pre-activation preview card displaying:
  - Label, ID, kind badge (`library` or `preset binding`), and short content fingerprint (`#<hash>`).
  - Tool diff preview (`+add`, `-remove`, or `No tool changes`).
  - Problem banner if the capability fails tool policy validation.
  - Full literal instruction content.
- **Guarded activation (`POST /api/capability-state/enable`):**
  - Payload sends `{ guard: { sessionId, leafId, revision }, kind, id, fingerprint }`.
  - Server re-verifies session guard and content fingerprint against disk definitions before applying.
  - If the session, branch, revision, or source file changed, the server rejects with `409 Conflict`.
  - Never automatically infers or retries.
  - Modifying requires project trust (`isProjectTrusted() === true`); untrusted sessions reject with `403 Forbidden`.

### Polling, state guarding, and security

- **Visibility-based polling with zero inference:** The web client quietly polls `GET /api/capability-state` every 3 seconds only while visible (`document.visibilityState === "visible"`), on window focus, or via manual refresh. Catalog reads (`/api/capability-state/available`) happen on workspace entry, explicit refresh and mutation follow-up, not every status poll. Unchanged background checks do not toggle loading/disable controls. The session projection follows semantic state changes and ignores late responses after leaving. All queries are local reads with zero LLM inference cost.
- **Manual reconciliation on error or conflict:** Errors, stale state, or 409 Conflicts mark the view as stale and require manual review. Mutations do not blindly retry.
- **Project trust requirement:** Modifying session capabilities requires an explicitly trusted project (`isProjectTrusted() === true`). Untrusted sessions reject mutations with `403 Forbidden`; CLI recovery via `/capability reset` remains available.
- **State guard and lifecycle protection:** Mutations enforce derived guards (`sessionId`, `leafId`, `revision`). Unmounted or disposed runtimes return `503 Service Unavailable`.

### Local developer testing and host reload

When testing in a local developer harness with local build wiring already configured:
- Hot reloading the Pi host requires the user to run `/reload` in the Pi console.
- If a web server was already active prior to `/reload`, run `/preset ui restart` in the host and open the newly returned URL. The pre-existing web server closure retains previous route handlers and will not pick up newly added routes upon host reload alone. Global host switching is not automatic.

## Lifecycle and tool synchronization

- **Unified `context_with_system` pipeline:** In Pi 0.87, standard `context` lifecycle hooks intentionally exclude System messages. Forge moves the complete compiler, base prompt replacement, and capability projection pipeline to `context_with_system` without an internal two-phase split.
- **Canonical projection with `buildSessionProjection`:** Runtime, Preview, and anchor helpers build against Pi 0.87's canonical `buildSessionProjection` (handling `context_edit` omissions, replacements, and `sourceEntry`), ensuring ephemeral request assembly reflects turn edits while raw session history remains untouched on disk.
- **Leading System preservation:** SDK incoming leading System prompts remain first; Forge's own prefix plain metadata anchors are inserted immediately after it.
- **Continuation and settlement lifecycle:** `agent_end` remains an anchor opportunity after a low-level run, provided no Forge context failure or incomplete tool batch remains, but the compile cycle and busy fence reset only on `agent_settled`. This ensures `agent_before_settle` continuations preserve compiled Preset state without dropping active capabilities.
- **Immediate tool sync vs. next-request prompt projection:**
  - Executable tool selection synchronizes *immediately* (`pi.setActiveTools()`). Disallowed tools are blocked at execution time.
  - Prompt text and native System sections or fallback user updates apply at the *next model request* boundary.
  - Running tool batches mid-flight are never interrupted.
- **Top-level policy precedence:** Capabilities cannot bypass Preset policies. If an active Preset denies a tool (`tools.deny`), a capability's `add` cannot enable it. Conflicting tool removals win globally across all active capabilities.
- **Baseline recovery:** Turning off a capability recomputes Preset defaults plus remaining active capabilities. When neither Preset tool selection nor capability overlays apply, Forge restores the reconciled session baseline, including preserved external changes. If a baseline cannot be recovered, Forge does not guess that all registered tools were previously active.
- **Parent lifecycle and re-entry fences:** Parent safeguards maintain `disposed` flags, `lifecycleRevision` counters, and strict `sameContext` verification, preventing cross-session pollution or operations after session disposal.

## Previewing capability updates

The **Preview** dock evaluates the selected Preset draft against current session capability snapshots:

- Uses the same pure preset/capability projection as the request path: native named system sections or attributed user updates, including stop notices and compaction checkpoints.
- Delivery markers are pure metadata anchors and do not appear as dialogue messages.
- System body text, native named sections, and historical tool declarations are kept separate. Text copy contains only body/section values; inspector prose (`Added tool`, `Updated system prompt section`) is not inserted into native text.
- Historical tool declarations are collapsed and explicitly marked as not the current selection.
- Preview tool selection uses the evaluated draft policy plus current capability overlays.
- Text estimates exclude tool schemas and inspector labels; genuinely empty post-projection System cards are hidden.
- History is grouped only in consecutive runs: intervening capability updates stay in chronological position between surrounding messages.
- Pure read-only inspection: Preview never mutates tool policies, commits session events, runs inference, or marks pending capabilities prepared. Full preview text is not clipped at layout limits.

## Delivery models: native vs. fallback

Forge projects capability deltas dynamically on each request through a two-stage assembly:

1. **Materialize before compilation:** Session context entries are projected via `buildSessionProjection` and scanned for plain `custom` metadata anchors (`pi-forge-capability-delivery`). At the request context boundary (`prepareCapabilityMessages`), anchors are validated and materialized into ephemeral in-memory markers at their exact ordinal positions matching the canonical projection, without modifying stored dialogue or raw session history.
2. **Rule projection:** `projectCapabilityMessages` transforms materialized deltas into the appropriate model presentation:
   - **Native delivery:** When the provider supports mid-conversation system messages (`compat.supportsMidConvoSystemMessages === true`), updates are projected as request-only `SystemMessage.sections` keyed by activation identity (`forge-capability-<id>`). Deactivations send null patches. Native delivery depends strictly on provider capability flags and is not universally guaranteed.
   - **Fallback delivery:** When native updates are unsupported, updates are projected as attributed timeline user messages (`[pi-forge capability update]`). Forge never folds updates into the leading system prompt; genuine user/tool dialogue is never promoted to system authority.
   - **Tool-only capabilities:** A capability whose text is empty or whitespace-only sends no text update in either path — no section on activation, no removal notice when it stops, and nothing in compaction checkpoints. Only its tool changes reach the request, and **Current session** offers no Locate action for it.
   - **Which path applies:** The choice is made on each request from the current model's `compat` entry in Pi's model catalog, which Pi fetches and caches locally and may change with updates. The provider name, authentication method, or an auth extension does not decide it, and models from one provider can differ. For example, the catalog observed on 2026-09-26 with Pi 0.87.1 flagged `anthropic/claude-opus-4-8`, `claude-opus-5`, and `claude-opus-5-5`, but not `anthropic/claude-sonnet-5`. Switching with `/model` changes delivery for later requests. `/capability status` and the Agent `status` action report `native system sections` or `attributed user updates`; check this before testing native updates or cache behavior. See [Provider support](provider-support.md) for the per-API behavior and flagged models recorded for Pi 0.87.1.
   - **Fallback side effects:** For unflagged models, Pi also folds its own tool-change declarations into the leading system message and top-level tool list, so a tool change rewrites the start of the next request and its cached prefix is not reused. Some models may treat the labeled user update as untrusted text and question it before using the new tools.

## Recovery and offline verification

Active state is derived deterministically from session events and delivery cursors (`throughEventId`):

- **Plain metadata delivery anchors:** Delivery markers are stored as plain `custom` session entries using the same delivery type (`pi-forge-capability-delivery`) with cursor-only metadata payload `{ schemaVersion: 1, throughEventId }`. They are not persisted as `custom_message` dialogue and do not use `sendMessage` steering. Idle updates anchor immediately; in-flight changes safely defer until after all tool results in a running batch complete; and `agent_end` anchors uncommitted deltas after the assistant's final response when no Forge context failure or incomplete batch remains. UI status notifications (`ctx.ui.setStatus`) are decoupled and never enqueue extra model turns.
- **Offline SDK verification:** State recovery across session reloads, manual compaction checkpoints, and branch tree navigation (`session.navigateTree`) is verified offline using SDK test harnesses. This confirms prompt assembly and tool gating, but does not provide an empirical guarantee of remote model compliance or obedience.
- **Compaction input and characterization:** Compaction checkpoints remain placed after the leading system prompt (`leadingSystem`) and before the compaction `summary` (placement unchanged; the upstream Pi metadata chunking bug is an independent issue and remains unfixed). Characterization tests verify real SDK summarization request inputs with simulated summaries. In this characterization, the summarizer observes user, assistant, and peer dialogue, but does not automatically receive new control metadata or request-only rule projections. Genuine dialogue quoting rule text is retained. Test-harness simulated responses verify request plumbing and harness shape, not remote LLM semantic compaction fidelity or summarizer compliance.
- **Breaking pre-release boundary:** This rename has no legacy aliases or readers. Existing development configs using instruction-mode keys, schemas, directories, or tool names must be converted to the new capability names, and sessions that contain the old capability state are unsupported for continuing that state. Forge does not rewrite old JSONL or historical summaries; start a new session after conversion rather than relying on partial restoration.
- **Session disk flushing:** In fresh sessions where only slash commands execute before the first assistant turn, Pi may not have flushed JSONL entries to disk yet.

## Compatibility and security boundaries

- **Upstream Pi minimum required:** Pi 0.87.0 is the minimum supported host (Forge 0.5.8 supports `>=0.87.0 <0.88.0 || 0.99.0 || 0.99.1 || 0.99.2 || 1.0.0`; published 0.5.7 peer metadata remains `>=0.87.0 <0.88.0`). Dual 0.86 runtime support is not provided. Extensions that previously manipulated or inspected full System messages in `context` must migrate to the full `context_with_system` hook. See [Pi 1.0 compatibility](../guides/pi-1-compatibility.md).
- **Timing with `before_agent_start`:** Any forced System prompt injection via `before_agent_start` continues to execute later than `context_with_system`.
- **Preceding extension message rewrites:** Pi permits context hooks to rewrite messages. When visible metadata anchors or unanchored events need positioning, Forge requires a unique ordered alignment with the canonical session projection and fails closed if arbitrary preceding rewrites break alignment. Pi may persist queued custom messages absent from a tool follow-up: Forge permits only uniquely alignable custom-message omissions, ignores their regenerated envelope timestamps, and preserves incoming objects without restoring omitted dialogue. A preceding rewrite can therefore conflict with this locator; moving it later does not guarantee safe composition. Broad plugin, warming, and automatic-overflow compatibility remain unverified.
- **Upstream defect status and protocol limits:** Upstream Pi metadata chunking and semantic-cut defects are NOT patched and remain unfixed upstream. Compaction checkpoint placement is unchanged. Old sessions and former delivery carriers remain untouched and unsupported for continuing capability state; Forge does not migrate old JSONL or rewrite historical summaries. Oh My Pi (OMP) is not supported or promised.
- **System prompt getters:** `ctx.getSystemPrompt()` and SDK getters return Pi's raw base prompt, not Forge's compiled request. Inspect compiled requests via `/forge payload` (bare `/payload` remains compatible) or Run context diffs. Forge does not claim to synchronize SDK getters. Extensions returning a full `systemPrompt` in lifecycle hooks cause forced projection conflicts and are unsupported.
- **Provider-managed tool transport and prompt caching:** Tool transport serialization and prompt prefix cache reuse are downstream provider-managed. Tool policy additions/removals, fallback formatting, and compaction alter prompt boundaries. For compatible Codex transports, clean first-time tool additions can retain request prefixes; removals or same-name redeclarations anywhere in retained history switch to full-current-tool serialization. Anthropic native tool changes and other per-API behavior are summarized in [Provider support](provider-support.md). Provider cache hits are not guaranteed. Pi-forge issues conservative provider-managed cache warnings and makes no permission bypass or caching guarantees (zero KV cache invalidation is not guaranteed).
- **Sandbox disclaimer:** Capabilities provide no OS-level sandboxing or process isolation. The demo `review.json` removes `bash`, `powershell`, `write`, and `edit`, but does not block external MCP tools or subagents. Configure tool removals matching your specific execution tools.

## Implementation status (0.5.5)

The 0.5.5 core functional implementation is delivered in source across all planned lanes:

- Foundation codecs, scoped discovery, semantic events, and immutable snapshot reducer.
- Human CLI commands (`/capability` add, list, bindings, enable, enable-bound, disable, status, reset).
- Formal plain metadata delivery anchor projection with pre-compilation ordinal materialization.
- Web Session capabilities activity panel and guarded human activation picker (`GET /api/capability-state/available`, `POST /api/capability-state/enable`).
- Live Preset bindings (`capabilities`) in dedicated peer Capability bindings tab, with finite overrides, collapsed advanced view, and opt-in `modelCallable: true`.
- Restricted model-callable `forge_capability` agent tool (list, status, enable, disable, ID ≤ 128 chars).
- Web Capabilities surface (CRUD) with SDK-grouped tool picker and `sourceRevision` stale-save guards.
- Preset policy custom default tools editor (`tools.initial?: string[]`) with concrete names, zero-default support (`[]`), and legacy fallback on omission.
- Parent safeguards: raw source/revision coherence, external new bindings stale-save detection, and lifecycle/re-entry fences.
- Tool patch schema supports `add` and `remove` only; candidate `only`/allowlist is not implemented.
- Conservative provider-managed prompt cache warnings; compatible Codex additional-tool delivery can preserve prefixes for new names when retained history has no removals/redeclarations; tool removal/redeclaration falls back to the current full tool list (not guaranteed cache hits); no automatic legacy migration or old summary rewrites; no Pi split patch; no claims of forced prompt, warming, auto overflow, or remote acceptance.
- Local build and full Node/browser/package verification passed at the 2026-09-24 UI closeout (commit `89c6ba2`); this is a dated local result, not current CI evidence, remote-provider acceptance, or npm publication. That historical check used Pi `>=0.87.0 <0.88.0`; current source host policy is in the [compatibility guide](../guides/pi-1-compatibility.md). Optional runtime/subagent integration and its producer work are independently tested and released.


Filesystem safety checks reject symlinks present when checked. They are not isolation against another local process racing directory replacement; revision checks likewise are not cross-process locking. Do not use resource mutation against an adversarial shared filesystem.
