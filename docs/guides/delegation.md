# Experimental foreground delegation

[Documentation](../README.md) · [中文](../zh-CN/guides/delegation.md)

> **Experimental:** This API and its backends may change independently of stable prompt-stack and profile behavior.

The optional `@zihanw/pi-forge-subagents` package executes an explicitly authorized agent profile through a selected backend. The default read-only backends use a separate, clean, one-shot Pi process; write-capable backends have different boundaries described below. The documented flow runs in the foreground and returns a bounded report to the parent conversation.

> **Default-tool compatibility:** Forge 0.5.5 provides `tools.initial`; the independently published optional subagents 0.5.3 is not compatible with this field. Until the optional package raises its Forge floor to `^0.5.5` and ships its separate fix, use matching local checkouts; see [tool-selection compatibility](../reference/subagent-host-port.md#tool-selection-compatibility). This optional compatibility work is not a main-package release gate.


## Enable a profile

Profiles are not delegatable by default. Enable each eligible ID in the trusted project's `.pi/forge/subagents.json`:

```json
{
  "backend": "pi-subprocess-readonly",
  "timeoutMs": 60000,
  "profiles": {
    "project:reviewer": {
      "enabled": true,
      "timeoutMs": 300000
    },
    "project:rpc-reviewer": {
      "enabled": true,
      "backend": "pi-rpc-readonly",
      "timeoutMs": 180000
    }
  }
}
```

Legacy `.pi/forge/config.json.subagents` is accepted as read-only fallback with a warning. Authorization keys should be canonical selectors: `project:<id>` or `global:<id>`. Bare keys remain a compatibility spelling for project profiles only, even inside `~/.pi/forge/subagents.json`; use an explicit key such as `global:reviewer` to authorize a global profile. Same-ID global and project profiles never inherit enablement, backend, or timeout policy from one another. Disabled or unlisted profiles are hidden from discovery and rejected even if guessed.

## Discover, plan, and run

Humans use:

```text
/forge-agent backends
/forge-agent plan reviewer Review this API design for correctness.
/forge-agent run reviewer Review this API design for correctness.
/forge-agent run reviewer --backend pi-rpc-readonly Review this API design.
```

`plan` resolves the profile and stack, compiles and validates the exact immutable provider-bound plan, displays it, and discards it without provider transport.

Profile selectors use the same grammar everywhere: `reviewer`, `project:reviewer`, or `global:reviewer`. For delegation, a bare ID selects `project:<id>`; use an explicit `global:<id>` selector for a global profile. Same-ID profiles remain separate and do not inherit delegation policy from one another.

The parent model uses `forge_subagent_profiles` to discover enabled profiles and `forge_subagent` to invoke one. A restrictive parent stack must allow both tool names. Discovery is local/no-egress and reports metadata, resolution readiness, effective backend/timeout, approval mode, and whether parent tool policy permits invocation.

Projects with only a few frequently used profiles can set `summaryInToolDescription: true` (global or trusted-project `subagents.json`). The `forge_subagent` tool description then carries a compact summary of enabled profiles—id, model, thinking level, stack, backend, and timeout—so the parent model does not need a discovery call to pick a profile. Ready profiles appear first; unavailable enabled profiles remain visible with their first resolution error so the model knows not to invoke them. The summary rides in every request, is capped at 8 profiles and 1,000 characters, and refreshes with profiles, stacks, and configuration; `forge_subagent_profiles` remains the authoritative full-detail surface.

## Parallel invocation

`forge_subagent` is a parallel-execution tool: the parent model may issue several calls in one turn, and they prepare and run concurrently. Interactive approval dialogs are serialized one at a time because Pi's selector/editor UI is a single slot—a second concurrent dialog would clear the first and leave it unresolved—so each call waits its turn for the dialog and then executes immediately, letting approved runs overlap. Unattended invocation needs no dialog and is fully concurrent. Fresh-process backends create an independent child process and provider request; `pi-inprocess` instead runs in the host runtime. A burst of parallel calls multiplies provider cost and process load, so keep the parent tool policy conservative until a configurable concurrency cap lands.

## Backends and precedence

Matching development versions of the optional subagents package and runtime expose four backend IDs. These notes describe unfinished optional-package source, not a finalized companion release; the main Forge 0.5.5 package does not require them.

- `pi-subprocess-readonly` is the default and uses `pi --mode text --print`. It exposes the `read`/`grep`/`find`/`ls` allowlist and is shared-user: the allowlist is not an OS sandbox.
- `pi-rpc-readonly` uses `pi --mode rpc` with the same shared-user read-only policy; only the process protocol differs.
- `pi-inprocess` runs in the host model runtime with the invoking user's full privileges. It is a workspace-write backend and can expose `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash` when the sealed access level and stack policy allow them; it has no OS sandbox. It is the backend for extension-registered providers that cannot be used in fresh children.
- `pi-bwrap-write` is an opt-in Linux Bubblewrap backend. It provides an isolated `workspace-write` mount for the selected workspace and can expose `read`/`grep`/`find`/`ls`/`edit`/`write`/`bash` when allowed. Writes go directly to that workspace; they are not staged for a separate approval/apply step. Bubblewrap and, by default, a git workspace are required.

There is no fallback if the selected backend is unavailable. Fresh-process backends reject extension-registered providers as non-portable; use `pi-inprocess` for those providers. Do not read the development matrix or the `tools.initial` compatibility fix as a claim that the paired companion release is already published.

For human runs, backend precedence is: explicit per-run `--backend`, matching profile override, trusted project default, global default, then the built-in `pi-subprocess-readonly`. An interactive model invocation may also supply a per-call backend override; an unattended model invocation is pinned to the effective profile/configured backend and rejects that override. Timeout follows matching profile override, trusted project default, global default, then the 60-second built-in default; valid values are 1,000–3,600,000 ms. Host timeout is best effort.

## Approval and unattended invocation

By default, the exact plan is prepared before an approval screen shows the task, profile/stack, provider/model, thinking level, tools, working directory, boundary, payload size, and fingerprint. **View full prompt** reveals the complete provider-bound system prompt and ordered messages. Editing that view cannot alter the sealed plan.

To authorize the parent model without per-run approval:

```json
{
  "allowAgentInvocationWithoutApproval": true
}
```

This affects only `forge_subagent`; `/forge-agent run` remains interactive. The flag may come from global defaults or a trusted project file, with the project value taking precedence. With the unreleased companion fix, an absent flag inherits; an explicitly non-boolean value sets that layer to `false` and emits a warning. A valid boolean in a higher-priority layer still overrides normally. If an entire config file is unreadable, malformed, or not a JSON object, that file is ignored with a warning and an earlier valid layer may remain effective. An untrusted project's project settings are ignored, and the execution trust gate blocks delegation runs from that project. Treat `subagents.json` as an authorization file: do not enable or commit unattended invocation unless every permitted parent agent may send the compiled prompt and readable file contents to the selected provider without asking again.

## Child context and output

An ordinary new child starts with a clean conversation, the exact profile model/thinking/stack, and the delegated task as a protected final user message. It does not automatically receive parent history. Explicit retained-child continuation and background execution are separate development features documented in the [companion package](https://github.com/MacroSony/pi-forge-subagents).

For `pi-subprocess-readonly` and `pi-rpc-readonly`, candidate tools are `read`, `grep`, `find`, and `ls`, further restricted by stack tool policy; these children load no write/edit/shell tools, skills, prompt templates, project context files, or third-party extensions. `pi-inprocess` and `pi-bwrap-write` can receive the write-capable tool surface described above only when their access level and stack policy allow it.

The model-visible result is bounded. Expandable human details retain normalized status, a text transcript, tool events, diagnostics, usage, approval receipt, and execution report. Retained strings are bounded, base64-like text is redacted, and the transcript keeps a 512 KiB rolling tail. Inline image bytes are replaced by MIME/encoded-size metadata before retention in the parent session.

## Security boundary

The security boundary is backend-specific:

- The subprocess and RPC read-only backends are **shared-user, not OS sandboxes**. “Read-only” is a model-tool policy; the child retains the invoking user's OS permissions. Absolute paths readable by that user may be read and sent to the selected provider.
- `pi-inprocess` is also shared-user and runs in the host process with full user privileges. Its allowlist can permit write/edit/`bash`, but it provides no OS isolation.
- `pi-bwrap-write` is the isolated Linux exception: Bubblewrap exposes the selected workspace as the writable project mount, alongside read-only runtime mounts and temporary sandbox storage. It is not a staged patch/apply workflow, and it does not provide network isolation.
- Across backends, timeout and cancellation are best effort. Text may be retained in parent tool-result details and Pi's on-disk session JSONL; `/tree` cannot undo provider requests, billing, or external effects, and abandoned entries can remain on disk. Removing sensitive retained text requires deleting the relevant Pi session data.

Choose a read-only backend when no mutation path is intended. Treat write-capable backends as explicit authorization to modify the selected workspace, not as a promise of separately approved staged changes.

For integration authors, see the [subagent host port contract](../reference/subagent-host-port.md).
