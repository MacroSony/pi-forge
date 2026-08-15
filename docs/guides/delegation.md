# Experimental foreground delegation

[Documentation](../README.md) · [中文](../zh-CN/guides/delegation.md)

> **Experimental:** This API and its backends may change independently of stable prompt-stack and profile behavior.

pi-forge can execute an explicitly authorized agent profile as a separate, clean, one-shot Pi process. It runs in the foreground and returns a bounded report to the parent conversation.

## Enable a profile

Profiles are not delegatable by default. Enable each eligible ID in the trusted project's `.pi/forge/config.json`, or use the profile's delegation card in `/preset ui`:

```json
{
  "subagents": {
    "backend": "pi-subprocess-readonly",
    "timeoutMs": 60000,
    "profiles": {
      "reviewer": {
        "enabled": true,
        "timeoutMs": 300000
      },
      "rpc-reviewer": {
        "enabled": true,
        "backend": "pi-rpc-readonly",
        "timeoutMs": 180000
      }
    }
  }
}
```

Enablement and per-profile overrides are project-only because profiles are project-local. A global `~/.pi/forge/config.json` may define general `backend` and `timeoutMs` defaults; global `profiles` entries warn and are ignored. Disabled or unlisted IDs are hidden from discovery and rejected even if guessed.

## Discover, plan, and run

Humans use:

```text
/forge-agent backends
/forge-agent plan reviewer Review this API design for correctness.
/forge-agent run reviewer Review this API design for correctness.
/forge-agent run reviewer --backend pi-rpc-readonly Review this API design.
```

`plan` resolves the profile and stack, compiles and validates the exact immutable provider-bound plan, displays it, and discards it without provider transport.

The parent model uses `forge_subagent_profiles` to discover enabled profiles and `forge_subagent` to invoke one. A restrictive parent stack must allow both tool names. Discovery is local/no-egress and reports metadata, resolution readiness, effective backend/timeout, approval mode, and whether parent tool policy permits invocation.

Projects with only a few frequently used profiles can set `subagents.summaryInToolDescription: true` (global or trusted-project config). The `forge_subagent` tool description then carries a compact summary of enabled profiles—id, model, thinking level, stack, backend, and timeout—so the parent model does not need a discovery call to pick a profile. Ready profiles appear first; unavailable enabled profiles remain visible with their first resolution error so the model knows not to invoke them. The summary rides in every request, is capped at 8 profiles and 1,000 characters, and refreshes with profiles, stacks, and configuration; `forge_subagent_profiles` remains the authoritative full-detail surface.

## Parallel invocation

`forge_subagent` is a parallel-execution tool: the parent model may issue several calls in one turn, and they prepare and run concurrently. Interactive approval dialogs are serialized one at a time because Pi's selector/editor UI is a single slot—a second concurrent dialog would clear the first and leave it unresolved—so each call waits its turn for the dialog and then executes immediately, letting approved runs overlap. Unattended invocation needs no dialog and is fully concurrent. Each run is an independent `pi` subprocess and provider request; a burst of parallel calls multiplies provider cost and process load, so keep the parent tool policy conservative until a configurable concurrency cap lands.

## Backends and precedence

Two fresh-process backends are registered:

- `pi-subprocess-readonly` is the default and uses `pi --mode text --print`.
- `pi-rpc-readonly` uses `pi --mode rpc`.

Both execute the same sealed prompt and shared-user read-only policy; only their process protocol differs. There is no fallback if the selected backend is unavailable.

Interactive backend precedence is: per-run override, project profile override, project default, user default, built-in default. Unattended model invocation is pinned to the effective configured backend and rejects a per-call override. Timeout follows profile, project, user, then the 60-second built-in default; valid values are 1,000–3,600,000 ms. Host timeout is best effort.

## Approval and unattended invocation

By default, the exact plan is prepared before an approval screen shows the task, profile/stack, provider/model, thinking level, tools, working directory, boundary, payload size, and fingerprint. **View full prompt** reveals the complete provider-bound system prompt and ordered messages. Editing that view cannot alter the sealed plan.

To authorize the parent model without per-run approval:

```json
{
  "subagents": {
    "allowAgentInvocationWithoutApproval": true
  }
}
```

This affects only `forge_subagent`; `/forge-agent run` remains interactive. It is ignored in untrusted projects and malformed values fail closed. Treat this project config as an authorization file: do not enable or commit it unless every parent agent allowed to call `forge_subagent` may send the compiled prompt and readable file contents to the selected provider without asking again.

## Child context and output

The child receives a clean conversation, the exact profile model/thinking/stack, and the delegated task as a protected final user message. It does not automatically receive parent history.

Candidate tools are `read`, `grep`, `find`, and `ls`, further restricted by stack tool policy. The child loads no write/edit/shell tools, skills, prompt templates, project context files, or third-party extensions.

The model-visible result is bounded. Expandable human details retain normalized status, a text transcript, tool events, diagnostics, usage, approval receipt, and execution report. Retained strings are bounded, base64-like text is redacted, and the transcript keeps a 512 KiB rolling tail. Inline image bytes are replaced by MIME/encoded-size metadata before retention in the parent session.

## Security boundary

The current backends are **shared-user, not operating-system sandboxes**.

- “Read-only” is a model-tool policy. The process retains the invoking user's OS permissions.
- Absolute paths readable by that user may be read and sent to the selected provider.
- Text may be retained in parent tool-result details and Pi's on-disk session JSONL.
- Timeout and cancellation are best effort.
- `/tree` changes the active conversation branch; abandoned entries can remain on disk.
- `/tree` cannot undo provider requests, billing, or external effects.
- Removing sensitive retained text requires deleting the relevant Pi session data.

The default tools intentionally provide no mutation path. Do not add write, edit, or shell access to this shared-user design. OS isolation and separately approved staged writes remain future work.

For integration authors, see the [experimental adapter contract](../reference/subagent-adapter.md).
