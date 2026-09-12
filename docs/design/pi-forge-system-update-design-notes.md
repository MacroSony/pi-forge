# pi-forge `system_update` Design Notes

**Status:** Current plan (revised 2026-09-12). Supersedes the 2026-09-10
exploration draft, which assumed pi-forge would implement the full
persistence/projection/transport stack itself. Upstream Pi has since started
building the primitive natively, so pi-forge's scope shrinks to the
workflow layer.

**Target:** 0.5.5+, blocked on an upstream Pi redo (see §2).

---

## 1. TL;DR — Current Plan

`system_update` is a **session-timeline event**, not a mutation of the
top-level system prompt. That core decision from the original draft survives.
What changed is who builds what:

- **Upstream Pi is building the primitive**: a first-class `SystemMessage`
  (`role: "system"`) appended to the transcript, rendered natively on models
  that support mid-conversation system messages and as a tagged user turn
  elsewhere. Persistence, resume, compaction, and provider rendering are all
  owned by the harness.
- **pi-forge builds only the workflow layer**: an append-only event log, a
  reducer over it, the `/system-update` command family, preset-declared
  dormant instruction blocks, and a permission-gated agent tool.
- **Integration is declarative**: pi-forge renders its active update set into
  `systemPromptOptions.sections` and lets the harness diff engine emit the
  deltas. pi-forge no longer returns a fully-compiled replacement string for
  this path.

Discarded from the original draft: the custom-entry + self-written projector
design, the `custom_message` transport, the provider transport matrix, and
the six-phase rollout. See §5 for why.

---

## 2. Upstream Landscape (snapshot 2026-09-12)

### 2.1 The PRs

- **PR #9116** (`system-role` branch, pi-ai layer): adds `SystemMessage` to
  the `Message` union. Appended to the transcript, never folded into
  `Context.systemPrompt`. Persisted as ordinary message entries; compaction
  cut points and summaries understand them (rendered as `[System]:` in
  summaries); interactive mode hides them.
- **PR #9117** (`system-tool-deltas` branch, stacked, coding-agent layer):
  the first rendered prompt of a session becomes a stored **baseline**;
  anything that changes afterwards is appended as a provider-neutral system
  message delta. On resume/tree navigation the stored baseline is reinstated
  so a resumed session sends byte-identical cached prefixes. After
  compaction, the effective prompt folds into a fresh baseline at no extra
  cost.

**Both PRs were closed by the author on 2026-09-11 with "I will redo this."**
Direction is alive; implementation is being redone; timeline unknown.
Community testing (13-scenario harness, all green) flagged two design
issues likely motivating the redo: ~10 KB per-prompt-entry session bloat
from storing rendered baselines, and silent tool disappearance on
non-supporting models across resume.

### 2.2 Verified behavior of the PR branch (local clone: `~/programming/pi-pr9117`)

Measured against the actual `system-tool-deltas` build:

- `sections: Record<string, string>` on `systemPromptOptions` renders as
  XML-wrapped blocks (`<name>\n...\n</name>`), diff-keyed as `section:name`.
- `diffSystemPrompts` behavior matrix:
  - identical pieces → `unchanged` (no cost)
  - section added → update delta: "The following `<name>` system guidance
    now applies: ..."
  - section removed → retraction: "The previous `<name>` system guidance no
    longer applies."
  - section content changed → "The `<name>` system guidance has changed. The
    following supersedes..."
  - literals changed or `forceSystemPrompt` changed → `replace`
    (deliberate full cache miss)
- **`forceSystemPrompt` short-circuits everything**: when set, pieces are
  only the forced prompt; sections are not rendered at all. Any extension
  returning a full replacement string from `before_agent_start` gets this
  path, and every content change is a full prefix miss.
- **`customPrompt` is a value piece** (keyed `customPrompt`, diff-friendly)
  and does NOT short-circuit sections. This is pi-forge's integration point
  for `mode = replace` stacks.
- Mid-run timing: the diff runs before every LLM request
  (`agent-loop.ts`), including mid-tool-loop, so an agent tool that mutates
  sections gets its delta delivered after the tool batch and before the next
  inference. The tool-call adjacency problem from the original draft is
  handled by the harness.
- Fallback rendering for unsupported providers:
  `<system_update>\n{text}\n</system_update>` as a user-role message
  (`pi-ai/utils/system-messages.ts`); Gemini confirmed user-role.
- Native support matrix (upstream compat flags): Anthropic Opus 4.8/5,
  Fable 5/5.1, Mythos 5/5.1 get real system messages (Anthropic requires a
  system message to directly precede an assistant turn; pending messages are
  held). OpenAI transports get `developer`/`system` items. Everything else
  gets the tagged user turn.
- `BeforeAgentStartEventResult.message` only accepts `CustomMessage`
  (customType/content/display/details) — there is **no imperative
  append-SystemMessage extension API** in the PR as written. The declarative
  sections path is the intended extension surface.
- The PR branch itself had two TypeScript errors (`openrouter.ts`,
  `xai.ts`) when we built it; dist artifacts were still produced.

### 2.3 Trigger to resume this work

When the redone PR appears: verify the sections/diff semantics survived the
redo (re-run the §2.2 matrix), then wire pi-forge's workflow layer to it.
If the redo removes the declarative sections surface, reassess; the escape
hatch is splicing `SystemMessage` in the context hook (see §5).

---

## 3. pi-forge Design (workflow layer)

These decisions survive from the original draft and remain the plan.

### 3.1 Event model

- Updates are **append-only custom session entries**
  (`pi-forge-system-update`, schemaVersion 1), written via the existing
  `session-adapter.ts` pattern (`pi.appendEntry` / `getCurrentBranchEntries`).
  Branch semantics come for free.
- Entry payload: `{ updateId, op: "apply" | "revoke" | "reset", source,
  presetId?, contentSnapshot, createdAt }`.
- **Snapshot content, not file paths**: file-backed presets are rendered at
  activation time and the rendered text is persisted. Editing a preset file
  tomorrow must not alter yesterday's session.
- Logical state is a **reducer view** over the branch's events, never
  canonical mutable state. Powers `/system-update status`, badges, and
  section rendering.
- Revoke/reset are new events, never history rewrites. In practice the
  harness retraction wording ("no longer applies") is generated for us once
  the section disappears; the event log only records intent.

### 3.2 Rendering (the declarative bridge)

- The reducer's active set is rendered into
  `systemPromptOptions.sections["pi-forge-update-<id>"]` during
  `before_agent_start` (and picked up mid-run by the harness's per-request
  diff).
- pi-forge's stack compilation moves off the legacy "return one big string"
  path: `mode = replace` stacks go into `systemPromptOptions.customPrompt`,
  additive content into keyed `sections`. This is a prerequisite refactor,
  and it upgrades cache behavior for the whole stack system, not just
  updates.
- Transport is not pi-forge's concern: native vs fallback rendering is the
  harness's compatibility layer.

### 3.3 Commands

- `/system-update <text>` — apply a freeform update (auto-id `update-N`).
- `/system-update status` — reducer view of active updates.
- `/system-update reset` — deactivate all (new event, append-only).
- 0.5.5+ with presets: `/system-update list|use <id>|off <id>`.
- No command deletes history. None of these trigger an agent turn.

### 3.4 Presets and the agent tool

- Presets declare dormant runtime blocks:
  `{ "systemUpdates": [{ "id", "name", "description", "modelCallable",
  "content" | "file" }] }`.
- The base system prompt carries only a compact inventory; full blocks load
  on activation (lazy privileged prompt loading).
- Agent-facing tool `forge_system_update({action, id})` references declared
  preset IDs only. **No arbitrary file elevation, no arbitrary agent-provided
  privileged text.** Repository content is untrusted; elevation requires an
  explicit preset declaration.
- Source-aware deactivation: the agent may only deactivate agent-activated
  modes; the user may deactivate anything.
- Mid-turn activation rides the harness's per-request diff — no
  pending-commit machinery on our side.

### 3.5 Compaction, resume, branching

All owned by the harness under the new architecture: update sections are part
of the effective prompt, folded into the post-compaction baseline; stored
baseline is reinstated on resume; events live on the branch. pi-forge's only
job is to re-derive the active set from the branch's event log on session
start/branch switch (same restore pattern as the active-stack state today).

---

## 4. Version Plan

- **0.5.4 (done, pushed):** web editor fixes and visual work; prompt-cache
  features — cache-impact warning on `/preset use` / `/profile use`
  (common-prefix estimate + last-request cacheRead), and compile-time
  diagnostics for cache-sensitive content (`{{time}}`, date slots with
  `includeTime`, `{{date}}` info).
- **0.5.5:** system update workflow layer per §3, gated on the upstream redo
  landing in a released Pi. Build the upstream-touching code behind a small
  isolated module so a redo API change rewrites one file, not the feature.

---

## 5. Discarded Designs (recorded so we don't re-litigate)

- **Custom entry + self-written projector** (original draft's main design):
  required replicating Pi's session-entry→context translation rules
  (compaction truncation, deferred-message filtering) to compute splice
  positions, plus a compaction checkpoint synthesizer. Real maintenance
  coupling to Pi internals. Killed by the upstream `SystemMessage`.
- **`pi.sendMessage` custom_message transport**: zero projection code, but
  `custom_message` entries evaporate at compaction (the compaction path
  doesn't recognize them) and render only as user-role. Viable fallback if
  the upstream redo dies entirely; otherwise obsolete.
- **Provider transport matrix / native lowering in pi-forge**: the wire role
  is the harness's compatibility layer. pi-forge stores semantics
  (`op`, `presetId`) so a future transport change needs no data migration.
- **Context-hook SystemMessage splicing**: possible once upstream keeps
  `role: "system"` messages, but brings back per-request projection, position
  mapping, and Anthropic placement-rule handling. Escape hatch only.

---

## 6. Open Questions for the Redo

1. Did sections survive the redo, and did their diff semantics change?
2. Is there an imperative append path for extensions after all, or is
   declarative sections still the only surface?
3. How does the redo store baselines (the session-bloat feedback)?
4. Does `customPrompt` remain a non-short-circuiting value piece?
5. Timing: which Pi release carries it, and what's our minimum-version
   dependency story for the feature?

Community posture: when the redo PR opens, comment as a downstream consumer
with the runtime-instruction-modes use case (do not file a new issue;
feature-request issues get auto-closed while a PR is in flight).
