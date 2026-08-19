# Subagent adapter contract

Status: experimental exported pure contract and host-preparation utilities for 0.4. This is a narrow one-shot delegation boundary, not a background orchestration runner or an OS sandbox.

> **Migration note (0.4):** execution ownership — backend registration, preflight binding, plan sealing, conversation/execution fingerprint issuance, lifecycle arbitration, and both fresh-process backends (`pi-subprocess-readonly`, `pi-rpc-readonly`) — lives in [`@zihanw/pi-subagent-runtime`](https://github.com/MacroSony/pi-subagent-runtime). Forge keeps the host surface described here (profiles, compilation, approval, plan/response product types) and consumes the runtime through its public API. The former in-package `SubagentBackendRegistry`, `PiSubprocessBackend`, and `PiSdkIsolatedBackend` exports no longer ship. Sections 8-9 below describe the superseded in-package design and remain as historical context.

## Public Surface

New integrations should import this experimental 0.4 surface from `@zihanw/pi-forge/subagent`. The package root re-exports the same names through 0.4 for compatibility. Stability classifications and compatibility-path policy are recorded in the [public API policy](public-api.md).

The package root exports:

- `AgentRequest`, `AgentProfileSnapshot`, `BackendPreflightResult`, `AgentExecutionPlan`, and `AgentResponse`.
- Granular access, limit, tool, media, context, artifact, trace, usage, and diagnostic types.
- Host resolution through `resolveSubagentHostProfile()`.
- Tool negotiation through `negotiateSubagentTools()`.
- Deterministic context preparation through `budgetSubagentContext()`, `renderSubagentSelectedContext()`, and `prepareSubagentInitialMessages()`.
- Protected Pi-message helpers.
- Plan construction through `createAgentExecutionPlan()`.
- Pure request, snapshot, preflight, plan, response, artifact, and trace validators. Portable leaf validators (access, limits, prompt runtime, descriptors, enforcement) are re-exported from the runtime core so one implementation serves both packages.
- Canonical `sha256:v1` profile, stack, and prompt-runtime fingerprints.
- Host preparation through `prepareSubagentHostPlan()`.

The existing `agentProfileFingerprint()` remains unchanged. It is still the legacy JSON provenance value used for branch drift. Portable fingerprints use separately named functions and semantics.

Conversation and execution fingerprints are **not** host-computed: they are issued by `@zihanw/pi-subagent-runtime` when it seals a prepared plan and are passed into `createAgentExecutionPlan()` as required inputs. The host validates their shape and propagates them; substitution detection is the runtime's sealed-plan binding.

## Required Flow

```text
AgentRequest
    -> resolveSubagentHostProfile
    -> ExecutionRuntime.prepare (explicit backendId; backend preflight;
       backend-assisted host compilation through the compile callback)
    -> runtime sealing (conversation + execution fingerprints)
    -> createAgentExecutionPlan (host plan carrying the sealed fingerprints)
    -> host approval bound to the sealed fingerprints
    -> ExecutionRuntime.execute
    -> validateAgentResponse
```

No stage may substitute parent-runtime model objects, credentials, source file paths, or raw session history for the portable artifacts.

### 1. Request validation

`validateAgentRequest()` checks:

- Schema, IDs, task text/media references, and media digests.
- Explicit selected-context byte budgets and provenance.
- Delegation depth.
- Access-level/workspace/working-directory/network/process combinations.
- Required versus best-effort hard limits.
- Result-projection bounds and remote-egress consent.

Media references are opaque host resources with content digests. The contract does not place local absolute paths or media bytes in the portable request.

### 2. Host resolution

`resolveSubagentHostProfile()` performs only backend-independent work:

- Validates the loaded profile and exact prompt-stack reference.
- Accepts null, default/replace, append, and prepend stack modes.
- Scans prompt-stack items for custom macro and slot dependencies.
- Requires those registrations to be loaded before final resolution.
- Produces a path-free immutable profile snapshot and portable fingerprints.

It deliberately does not inspect a model registry, authentication, backend tools, mounts, or limits. Parent `/profile use` resolution remains separate.

Unknown macro commands and custom slots are treated as missing subagent dependencies. Static stack variables and built-in macros/slots are excluded. Custom registrations without a `source` still resolve but produce a warning because their dependency identity is anonymous.

### 3. Backend preflight

An accepted `BackendPreflightResult` must identify the exact model/thinking level, dynamic tool catalog, granular capabilities, effective access receipt, and accepted limit receipt.

`validateBackendPreflight()` enforces:

- Exact profile model and thinking-level agreement.
- Explicit consent for remote provider transport.
- Requested media MIME support.
- No missing, extra, upgraded, or mode-mismatched mounts.
- Working-directory containment through backend mount IDs.
- Read/write, symlink, process, and denied-network enforcement claims.
- Every required limit uses `backend-hard` enforcement.
- Best-effort limits are reported honestly, such as Pi SDK host-abort timeouts.
- Rejected preflight results contain at least one error diagnostic.

Prompt tool filtering is not accepted as an access receipt.

### 4. Tool negotiation

Each backend tool declares a stable backend ID, policy-facing name, and effects:

- `filesystem-read`
- `filesystem-write`
- `process`
- `network`

`negotiateSubagentTools()` applies prompt-stack policy to names, then removes tools whose declared effects exceed request access. Effect-free tools may remain under filesystem access `none`; network and process are independently controlled. Unmatched allow patterns remain warnings.

Adapters must classify tool effects conservatively. A tool with undeclared effects invalidates the backend's enforcement claim even if name filtering succeeds.

### 5. Context and exact preparation

`budgetSubagentContext()` measures the exact UTF-8 bytes of the rendered selected-context envelope. Required items are retained first. Optional items are considered newest-to-oldest without partial item truncation, and returned in original order. Required overflow fails preparation.

`prepareSubagentInitialMessages()` creates:

1. One quoted selected-context message when the budget retains context.
2. Host-prepared prompt-stack messages.
3. The complete protected task/media message as the final user message.

Prompt-stack messages cannot claim reserved selected-context or delegated-task markers.

Backends such as Pi SDK may expose exact base-prompt runtime inputs only in a pre-provider hook. They may call the host preparer there, but provider transport must remain blocked until `createAgentExecutionPlan()` succeeds. A `partial` prompt-runtime preflight cannot produce an execution plan.

### 6. Plan and fingerprints

`createAgentExecutionPlan()` revalidates the request, snapshot, preflight, deterministic context receipt, tool negotiation, runtime fidelity, and protected final task. It carries the runtime-issued conversation and execution fingerprints as required inputs; the host never computes either value.

The runtime's conversation fingerprint binds the exact sealed system prompt and ordered messages, so equivalent conversations on different backends compare equal. Its execution fingerprint additionally binds the accepted backend, preflight, effective tools, access and limit receipts, and runtime inputs, so the same conversation on different backends produces different execution fingerprints. Approval displays both values and execution accepts only the runtime-bound prepared handle.

Canonical serialization sorts object keys, omits undefined object fields, rejects cycles/non-finite numbers/non-JSON values, preserves array order, and normalizes negative zero.

### 7. Response validation

`validateAgentResponse()` enforces the terminal status matrix:

| Status | Required terminal field | Output rule |
|---|---|---|
| `completed` | none | absent or `partial: false` |
| `failed` | structured `error` | absent or `partial: true` |
| `cancelled` | `reason` | absent or `partial: true` |
| `timed-out` | `reason`, `enforcedTimeoutMs` | absent or `partial: true` |
| `limit-reached` | `reachedLimit` | absent or `partial: true` |

It also validates request/run/backend correlation, model and fingerprints, effective backend tool IDs, backend-produced enforcement receipts, duration, token/cost units, artifact namespaces, relative paths, cleanup ownership, and authorized trace handles. Cost requires an ISO 4217 currency code.

### 8. Optional backend registry

`SubagentBackendRegistry` starts empty and never installs a default backend. It:

- Validates backend descriptors and rejects duplicate identities.
- Binds accepted preflight IDs to the exact backend, request, and profile fingerprint used during discovery.
- Routes exact-preflight preparation directly to the host preparer and requires backend-assisted adapters to invoke the same host boundary.
- Binds the exact runtime fingerprint, compiled system/messages, effective tools, and context receipt returned by host preparation; recomputing an execution fingerprint cannot substitute a different plan.
- Routes dry-plan discard through the owning backend before forgetting the preflight binding.
- Rejects malformed, tampered, foreign, or unbound execution plans before transport.
- Arbitrates backend completion, explicit user cancellation, external abort signals, and declared host-abort timeouts through one terminal result.
- Discards prepared backend state without invoking execution when cancellation wins before backend dispatch.
- Normalizes thrown provider failures and malformed backend responses into contract-valid failed responses.
- Replaces backend-reported duration with host-observed duration.
- Keeps opaque backend trace IDs behind host-generated handles and enforces authorization scope, backend routing, expiry, and explicit forgetting during inspection.
- Refuses backend unregistration while an execution remains active or is draining after cancellation.

The registry validates receipts but does not manufacture filesystem, process, network, token, turn, or output isolation. Those remain adapter responsibilities.

Access receipts may explicitly declare `executionBoundary: "shared-user"`. This boundary means the subprocess retains the invoking user's operating-system permissions and its effective access is constrained only by the tools exposed to the model. A shared-user receipt cannot claim mount, symlink, process, or network isolation. Omitting the field preserves the legacy `isolated` interpretation.

### 9. Experimental foreground subprocess and approval path

`PiSubprocessBackend` is the extension's deliberately narrow default adapter:

- It resolves the exact profile model through Pi's existing `ModelRegistry`, reuses the host Pi `ModelRuntime` so preparation sees the same authentication, and prepares the exact prompt inside an in-process Pi session held behind a provider gate. Required host capabilities are checked and fail closed before provider transport.
- After approval, it disposes the preparation session and launches a fresh foreground Pi subprocess with the approved model, thinking level, system prompt, messages, and tool IDs. Pi's ordinary text stdout is drained separately from a dedicated newline-delimited report channel.
- Its bridge preserves the exact prepared messages and rejects tools outside the approved allowlist. Candidate tools are limited to `read`, `grep`, `find`, and `ls`, then intersected with prompt-stack policy.
- It loads no write/edit/shell tools, skills, prompt templates, context files, themes, or third-party Pi extensions and writes no child session file.
- It accepts text-only, one-shot, sequential `read-only` requests rooted at the project working directory, with no process tool and optional host-abort timeout. It advertises no artifact retention or contract trace inspection.
- It records a bounded foreground execution report containing sanitized transcript events, tool calls/results, usage, stderr, status, and execution identity. Inline images remain available to the child model but cross the report boundary only as MIME/encoded-size metadata. Base64-like text is redacted, individual strings are capped, and retained messages form a 512 KiB rolling tail so large tool histories cannot make the parent TUI/session retain unbounded data. Temporary bridge inputs are mode `0600` and removed during cleanup.
- Retained textual tool results are ordinary parent-session tool details. `/tree` can move the active branch away from them but does not erase abandoned entries from Pi's on-disk session JSONL; callers handling sensitive files must treat session-data deletion as a separate operation.

This backend declares `executionBoundary: "shared-user"`. It does not create allowed-root mount containment, symlink-safe path containment, process isolation, or agent-network isolation. The subprocess retains the invoking user's OS permissions; `read-only` describes the tools exposed to the model, not a security sandbox. Network is therefore honestly recorded as allowed even though no dedicated network or shell tool is exposed.

The model-callable `forge_subagent_profiles` tool reads the already-loaded host profile catalog without preparing a prompt or contacting a provider, then filters it through explicit trusted-project `subagents.profiles.<id>.enabled` policy. Global config supplies only general backend/timeout defaults; global profile entries warn and are ignored because the loaded profile and stack catalog is project-local. The tool exposes only delegation-enabled IDs, names, descriptions, declared model/thinking/stack metadata, effective backend/timeout and sources, ready/unavailable resolution diagnostics, and whether parent policy currently exposes the invocation tool. Disabled and unlisted profiles remain usable through ordinary profile workflows but cannot be delegated. A restrictive parent stack must allow both `forge_subagent_profiles` and `forge_subagent` for discovery followed by delegation.

The model-callable `forge_subagent` tool and `/forge-agent run` use the same runtime path. Both reject profiles that are not explicitly enabled, resolve global/project general defaults plus trusted-project per-profile backend/timeout policy, and prepare an exact immutable plan while provider transport remains closed. `/forge-agent run` always shows a compact approval summary, allows inspection of the complete prompt, and requires interactive approval bound to the execution fingerprint. The tool does the same by default, but a trusted project may set `allowAgentInvocationWithoutApproval: true` in `.pi/forge/subagents.json`; this permits non-UI model invocation pinned to the effective configured profile backend and records `trusted-project-config` in the result receipt without weakening eligibility, preflight, or plan binding. Missing, malformed, and untrusted-project settings fail closed. The tool returns bounded content to the parent model and expandable execution details to the human. `/forge-agent plan` still prepares and discards without provider transport; `/forge-agent backends` shows capabilities and effective enabled-profile settings. Fresh-process backend registration, binding, lifecycle, and execution are provided by `@zihanw/pi-subagent-runtime`.

## Adapter-Enforced Responsibilities

The exported validators cannot create isolation. Every adapter remains responsible for:

- Credential and model availability in its own runtime.
- Backend-side mount materialization and path canonicalization immediately before access.
- Symlink-race-safe containment.
- Process and agent-network isolation.
- Accurate tool effects and stable tool mappings.
- Required hard timeout, turn, token, and output limits.
- Cancellation settlement and cleanup.
- Media transport and remote-egress behavior.
- Artifact authorization, retention, and cleanup.
- Trace storage, authorization, redaction, pagination, and expiry.
- Returning actual enforcement receipts rather than echoing request fields.

An adapter must reject preflight when it cannot enforce a required field. Both shipped process adapters accept shared-user read-only access and network allow, and use best-effort host abort rather than a backend-hard timeout. Provider transport is always a separate, explicitly approved egress path.

## Deliberately Not Included

- Filesystem writes, process/shell tools, media input, or background runs in the shipped path.
- OS-level filesystem, process, or network sandboxing for the shared-user subprocess.
- Automatic parent-history/context selection; the delegated task is explicit and starts a clean conversation.
- Session resume, retries, queues, chains, or pipelines.
- Artifact/trace storage implementations.
- Automatic provider or backend fallback.

Those belong to later iterations and cannot be inferred from these pure types alone.
