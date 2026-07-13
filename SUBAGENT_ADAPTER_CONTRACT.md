# Subagent Adapter Contract

Status: exported pure contract and host-preparation utilities for the 0.4 development branch. This is an adapter boundary, not a runner, backend registry, or parent-agent tool.

## Public Surface

The package root exports:

- `AgentRequest`, `AgentProfileSnapshot`, `BackendPreflightResult`, `AgentExecutionPlan`, and `AgentResponse`.
- Granular access, limit, tool, media, context, artifact, trace, usage, and diagnostic types.
- Host resolution through `resolveSubagentHostProfile()`.
- Tool negotiation through `negotiateSubagentTools()`.
- Deterministic context preparation through `budgetSubagentContext()`, `renderSubagentSelectedContext()`, and `prepareSubagentInitialMessages()`.
- Protected Pi-message helpers used by the SDK spike.
- Plan construction through `createAgentExecutionPlan()`.
- Pure request, snapshot, preflight, plan, response, artifact, and trace validators.
- Canonical `sha256:v1` profile, stack, and execution fingerprints.

The existing `agentProfileFingerprint()` remains unchanged. It is still the legacy JSON provenance value used for branch drift. New portable fingerprints use separately named functions and semantics.

## Required Flow

```text
AgentRequest
    -> resolveSubagentHostProfile
    -> backend discovery/preflight
    -> backend-assisted exact preparation
    -> createAgentExecutionPlan
    -> backend execution
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

`createAgentExecutionPlan()` revalidates the request, snapshot, preflight, deterministic context receipt, tool negotiation, runtime fidelity, and protected final task. It creates the run ID correlation and execution fingerprint before provider transport.

The execution fingerprint covers all serialized plan fields except itself, including compiled system/messages, profile/stack/dependency provenance, the complete preflight receipt and adapter version, exact model/thinking, effective backend tool IDs, access and limit receipts, prompt-runtime fingerprint, context receipt, and result-projection bound.

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

An adapter must reject preflight when it cannot enforce a required field. The current Pi SDK spike can execute only access `none`; its host-abort timeout is best-effort, not backend-hard.

## Deliberately Not Included

- Backend registration or dispatch.
- A shipped Pi SDK backend.
- Parent run/inspect tools or result projection insertion.
- Session resume, retries, queues, chains, or pipelines.
- Artifact/trace storage implementations.
- Automatic provider fallback.
- Automatic parent-context selection.

Those belong to later iterations and cannot be inferred from these pure types alone.
