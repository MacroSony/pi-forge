# Instruction modes (system-update)

## Preset-authorized Agent controls

Preset `instructionModes` bindings are now live. Use `modelCallable: true` only for modes the Agent may select; it is false by default. `forge_system_update` accepts only `{action: "list" | "status" | "use" | "off", id?: string}` (ID ≤128 chars). It rechecks current trust, Preset binding identity, authorization and tool policy for every call. Use takes a binding ID; off takes its own Agent-owned activation/binding ID. It cannot write arbitrary rules, reset, stop human-owned rules or activate a mode that removes its control tool.

Humans can run `/system-update bindings` and `/system-update use-bound <id>`. Direct `/system-update use <[scope:]id>` remains unbound. Saving modes/bindings does not activate them; same-Preset reload retains immutable active snapshots. Switching Presets retires old bound activations, retaining manual/unbound rules. Revoked authorization does not retroactively erase snapshots: the human CLI/Web off/reset remains the recovery path.


[Documentation](../README.md) · [中文](../zh-CN/reference/instruction-modes.md)

Pi-forge introduces instruction modes: session-scoped prompt directives paired with dynamic tool selection. This reference details configuration, CLI usage, delivery models, recovery boundaries, and compatibility limits.

## Requirements and installation

- **Host requirement:** Pi `>= 0.86.0`.
- **Project trust:** Activating instruction modes or manual directives requires a trusted project (`isProjectTrusted()`).

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
- **Resolution and shadowing:** Bare selectors use project-over-global shadowing. If a project mode contains invalid JSON, resolution fails closed locally; it does not fall back to global. Exact scopes can be targeted using `project:<id>` or `global:<id>`.

## Commands

Manage active instructions through `/system-update`:

| Command | Behavior |
|---|---|
| `/system-update list` | List available modes in project and global libraries with validation status. |
| `/system-update use <[scope:]id>` | Select and activate a mode (e.g. `/system-update use project:review` or bare ID). |
| `/system-update status` | Show active mode count, presentation model, delivery state, and selected tools. |
| `/system-update off <activation-or-mode-id>` | Deactivate an active mode by activation UUID or mode ID. |
| `/system-update reset` | Deactivate all active instruction modes and manual directives. |
| `/system-update add <text>` | Append a manual literal instruction rule to the active session without tool changes. |

**No inference cost:** All `/system-update` commands and Web activity panel actions execute locally. They update internal session state without starting model inference or consuming API tokens for the operation itself. Their instruction text still consumes input tokens on subsequent model requests when inference occurs. Delivery anchors are recorded as plain `custom` session entries carrying strictly cursor-only metadata (`schemaVersion: 1`, `throughEventId`) under the same delivery type (`pi-forge-instruction-delivery`), replacing previous `sendMessage` steering and transcript `custom_message` carriers. Idle changes anchor immediately; running changes defer until after an in-flight tool batch completes safely or commit at `agent_end` after the assistant's final response, without enqueueing an extra model turn. UI status notifications remain independent.

## Previewing instruction updates

The existing **Preview** dock evaluates the selected Preset draft against current session instruction snapshots. It uses the same pure preset/instruction projection as the normal request path: native named system sections or attributed user updates, including stop notices and compaction checkpoints. Delivery markers are pure metadata anchors and do not appear as dialogue messages or generic custom-message tasks. Named sections and tool declaration changes are readable rather than blank System cards. Ordinary history keeps its configured slot name (for example, a slot named `Delegated Task` still labels ordinary history that way).

System body text, native named sections and historical tool declarations are separate fields. The code blocks and per-section text copy contain only body/section values; inspector-generated `Added tool` or `Updated system prompt section` prose is not inserted into native System text. Fallback user-update wording remains literal request text. Historical declarations are collapsed and explicitly **not the current selection**. The separate **Preview tool selection** uses the evaluated draft policy plus current mode overlays, not old transcript declarations. Text estimates exclude tool schemas and inspector labels; structural-only updates remain inspectable but genuinely empty post-projection System cards are hidden. Empty non-system messages and real text containing these phrases are not removed. Draft diffs still detect structural/tool-selection changes even when body text is unchanged. History is grouped only in consecutive runs: an intervening instruction update stays between the surrounding messages, not after all history.

After changing modes, refresh Preview to inspect the new projection. This is a draft/session-context preview, not an exact provider payload or delivery acknowledgment; reading/copying it does not run inference, change tools or mark updates prepared. Full preview text is no longer clipped at the old 8,000-character message-layout limit. Source edits do not change active snapshots. Existing natural-language summaries, including quotations of old notifications, are preserved; this change does not rewrite historical summaries or alter Pi's compaction cut selection.

## Web session instructions panel

In addition to the `/system-update` CLI, the web editor provides an expandable **Session instructions** activity panel positioned directly beneath the top navigation bar.

### State display and active modes

- **Active modes list:** Lists all active instruction modes and manual directives for the current session. Each card provides:
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

### Polling, state guarding, and security

- **Visibility-based polling with zero inference:** The web client polls `GET /api/instructions` every 3 seconds only while the document is visible (`document.visibilityState === "visible"`). Polling also triggers upon window focus or via the manual **Refresh** button. Queries are pure local reads with no LLM inference cost.
- **Manual reconciliation on error or conflict:** If a request fails, state becomes stale, or a `409 Conflict` occurs, the panel marks the view as stale and requires manual review. Write mutations do not automatically retry.
- **Project trust requirement:** Modifying session instructions from the web UI requires an explicitly trusted project (`isProjectTrusted() === true`). Untrusted sessions reject mutations with `403 Forbidden`; the human CLI (`/system-update reset`) remains available for recovery.
- **State guard and lifecycle protection:** Web mutations send a derived guard (`sessionId`, `leafId`, and a hash `revision` incorporating runtime generation / `instanceId`). If the session branch, leaf, or runtime instance changes, mutations fail with `409 Conflict` to prevent stale page overwrites. If the instruction runtime is unmounted or disposed, requests return `503 Service Unavailable`.

### Operational boundaries and non-goals

- **Session activity panel, not a mode editor:** This panel is exclusively a live session activity viewer and controller. It is **not** a mode library editor (it does not author or save JSON mode files to disk), **not** a source file diff viewer, **not** a per-tool "why" explainer (it displays effective tools and item patches, not a root-cause attribution engine), and **not** a preset-binding UI.
- **No extra tool schema or cache warnings:** Modes still use `add/remove`; the panel does not introduce `only` or mode-level allow/deny fields, and it provides no tool transport or prompt-cache impact warnings.
- **Unimplemented capabilities:** Preset `instructionModes` configuration bindings and the model-callable `forge_system_update` agent tool remain unimplemented in this milestone.

### Local developer testing and host reload

When testing in a local developer harness with local build wiring already configured:
- Hot reloading the Pi host requires the user to run `/reload` in the Pi console.
- If a web server was already active prior to `/reload`, run `/preset ui restart` in the host and open the newly returned URL. The pre-existing web server closure retains previous route handlers and will not pick up newly added routes upon host reload alone. Global host switching is not automatic.

## Lifecycle and tool synchronization

- **Request boundary:** Active instructions and tool changes apply at the next model request boundary. Running tool batches mid-flight are never killed.
- **Snapshot semantics:** Mode activation captures an immutable snapshot. Editing the JSON file on disk causes no live session drift. To apply edits, run `/system-update off <id>` then `/system-update use <id>`.
- **Top-level policy precedence:** Modes cannot bypass Preset policies. If an active Preset denies a tool, a mode's `add` cannot enable it. Conflicting tool removals win globally across all active modes.
- **Baseline recovery:** Forge tracks a pristine baseline to restore tools cleanly when modes are deactivated. For legacy sessions without a recorded baseline, Forge adopts a conservative baseline rather than granting all registered tools.

## Delivery models: native vs. fallback

Forge projects instruction deltas dynamically on each request through a two-stage assembly:

1. **Materialize before compilation:** Session context entries are scanned for plain `custom` metadata anchors (`pi-forge-instruction-delivery`). At the request context boundary (`prepareInstructionMessages`), anchors are validated and materialized into ephemeral in-memory markers at their exact ordinal positions, matching the session transcript without modifying stored dialogue.
2. **Rule projection:** `projectInstructionMessages` transforms materialized deltas into the appropriate model presentation:
   - **Native delivery:** When the provider supports mid-conversation system messages (`compat.supportsMidConvoSystemMessages === true`), updates are projected as request-only `SystemMessage.sections` keyed by activation identity (`forge-instruction-<id>`). Deactivations send null patches. Native delivery depends strictly on provider capability flags and is not universally guaranteed.
   - **Fallback delivery:** When native updates are unsupported, updates are projected as attributed timeline user messages (`[pi-forge instruction update]`). Forge never folds updates into the leading system prompt; genuine user/tool dialogue is never promoted to system authority.

## Recovery and offline verification

Active state is derived deterministically from session events and delivery cursors (`throughEventId`):

- **Plain metadata delivery anchors:** Delivery markers are stored as plain `custom` session entries using the same delivery type (`pi-forge-instruction-delivery`) with cursor-only metadata payload `{ schemaVersion: 1, throughEventId }`. They are not persisted as `custom_message` dialogue and do not use `sendMessage` steering. Idle updates anchor immediately; in-flight changes safely defer until after all tool results in a running batch complete; and `agent_end` anchors uncommitted deltas after the assistant's final response when no Forge context failure or incomplete batch remains. UI status notifications (`ctx.ui.setStatus`) are decoupled and never enqueue extra model turns.
- **Offline SDK verification:** State recovery across session reloads, manual compaction checkpoints, and branch tree navigation (`session.navigateTree`) is verified offline using SDK test harnesses. This confirms prompt assembly and tool gating, but does not provide an empirical guarantee of remote model compliance or obedience.
- **Compaction input and characterization:** Compaction checkpoints remain placed after the leading system prompt (`leadingSystem`) and before the compaction `summary` (placement unchanged; the upstream Pi metadata chunking bug is an independent issue and remains unfixed). Characterization tests verify real SDK summarization request inputs with simulated summaries. In this characterization, the summarizer observes user, assistant, and peer dialogue, but does not automatically receive new control metadata or request-only rule projections. Genuine dialogue quoting rule text is still retained. Test-harness simulated/mock responses verify request plumbing and harness shape, not remote LLM semantic compaction fidelity or summarizer compliance.
- **Backward compatibility and legacy sessions:** Existing sessions containing legacy `custom_message` delivery entries can still be read and recovered for backward compatibility. Forge does not migrate old entries on disk, nor does it erase or rewrite historical compaction summaries. **Explicit warning:** If a legacy session containing old `custom_message` carriers undergoes compaction, those old carriers may still contaminate summarizer input.
- **Session disk flushing:** In fresh sessions where only slash commands execute before the first assistant turn, Pi may not have flushed JSONL entries to disk yet.

## Compatibility and security boundaries

- **Preceding extension message rewrites:** Pi permits `context` hooks to rewrite messages. When visible metadata anchors or unanchored events need positioning, Forge requires a unique ordered alignment with the session-derived context and aborts rather than guessing. Pi may persist queued custom messages absent from a tool follow-up: Forge permits only uniquely alignable custom-message omissions, ignores their regenerated envelope timestamps, and preserves the incoming objects without restoring omitted dialogue. A preceding rewrite can therefore conflict with this locator. Adjust the conflicting extension's order or behavior after review; moving it later does not guarantee safe composition. Broad plugin, warming and automatic-overflow compatibility remain unverified.
- **System prompt getters:** `ctx.getSystemPrompt()` and SDK getters return Pi's raw base prompt, not Forge's compiled request. Inspect compiled requests via `/payload` or Run context diffs. Forge does not claim to synchronize SDK getters. Extensions returning a full `systemPrompt` in lifecycle hooks cause forced projection conflicts and are unsupported.
- **Sandbox disclaimer:** Instruction modes provide no OS-level sandboxing or process isolation. The demo `review.json` removes `bash`, `powershell`, `write`, and `edit`, but does not block external MCP tools or subagents. Configure tool removals matching your specific execution tools.

## Implementation status (0.5.5-core)

The 0.5.5 release is in staged development and is not yet complete:

- The human CLI slice (`/system-update`), projection runtime, read/control Web session instructions activity panel, and formal plain metadata anchor projection fix are implemented.
- Preset `instructionModes` configuration fields, live Preset binding with current authorization, mode library file editing in the Web UI, and the model-callable `forge_system_update` agent tool (list/status/use/off) are not yet shipped.
- Direct human activation via CLI is not bound to a Preset (the Web panel can stop/reset existing activations); switching Presets preserves human-activated modes, though top-level Preset tool policies still apply. Complete demo media and video walkthroughs have not been released. The package version remains 0.5.4 until release preparation.
