# Subagent Request/Response Design

Status: implemented pure adapter contract for the 0.4 development branch. The Pi SDK spike is recorded in [`SUBAGENT_SDK_SPIKE_FINDINGS.md`](SUBAGENT_SDK_SPIKE_FINDINGS.md), and the concrete exported semantics are documented in [`SUBAGENT_ADAPTER_CONTRACT.md`](SUBAGENT_ADAPTER_CONTRACT.md). Backend registration and execution remain deferred.

## Goals

- Make pi-forge profiles usable by native, subprocess, package-provided, or remote backends without requiring every backend to reproduce the parent Pi runtime.
- Start every subagent with a clean conversational context while allowing explicit, bounded context seeding.
- Keep prompt stacks as the profile-level source of prompt layout, visible-tool policy, and model-visible skills.
- Keep access, limits, cancellation, trace storage, and result reporting outside reusable profiles.
- Return a compact parent-visible tool result while retaining normalized execution history for authorized inspection.
- Export the demonstrated pure request/resolution/preflight/plan/response boundary while keeping backend registration and execution out of the package surface.

## Execution Flow

The portable caller request is not itself executable. Execution has five stages:

```text
AgentRequest
    -> host profile/stack/dependency resolution
    -> backend discovery and preflight
    -> backend-assisted host plan preparation
    -> backend execution
    -> AgentResponse
```

### 1. AgentRequest

The parent supplies intent: profile selection, task/media, explicit selected context, access requirements, limits, and parent-depth provenance. It does not contain parent runtime model objects, loaded files, credentials, raw session entries, or a compiled prompt.

### 2. Host resolution

pi-forge validates profile syntax, resolves the referenced prompt stack, identifies required custom macro/slot registrations, resolves selected parent-context references, and creates immutable declarative provenance. This stage does not claim that the target backend has the model, credentials, tools, isolation, or limit support needed to execute it.

Current parent-runtime resolution used by `/profile use` remains valid for applying profiles to the parent. Subagent host resolution must be a separate operation rather than reusing parent model/auth diagnostics as backend truth.

### 3. Backend discovery and preflight

Before prompt compilation, the selected backend reports:

- Model availability, authentication, thinking-level support, and media support.
- A stable tool catalog with backend tool IDs, policy-facing names, prompt snippets, and optional adapter mappings.
- Prompt-runtime inputs needed for Pi-compatible base prompts, tool guidance, skills, and context resources.
- Workspace/mount materialization support and granular access enforcement.
- Supported hard limits, cancellation behavior, trace support, and artifact behavior.
- Remote data-egress requirements.

The host applies the prompt stack's tool policy to the backend catalog. An allow pattern that matches nothing remains a warning unless separate dependency metadata marks that tool or capability as required.

### 4. Backend-assisted plan preparation and AgentExecutionPlan

The host combines the resolved profile, backend preflight receipt, selected context, and prompt-stack compiler into an immutable execution plan. The plan contains prepared system text/messages, exact model and thinking level, effective backend tool IDs, materialized workspace handles, enforced limits, diagnostics, provenance, and a stable execution fingerprint.

Some backends cannot expose exact prompt-runtime inputs during passive preflight. Pi SDK 0.80.6, for example, exposes its exact base prompt, tool snippets, skills, and context options through `before_agent_start`, immediately before provider execution. Such an adapter may supply those inputs to a trusted host preparation callback after accepting the prompt, provided it blocks provider transport until host compilation, protected-task validation, limit checks, and plan finalization succeed. A partial dry preflight must declare its prompt-runtime fidelity and cannot masquerade as the exact execution plan.

Custom macros and slots execute during plan preparation in the trusted host. Backends receive their rendered result and dependency receipt, not executable registration code. A raw `PromptStack` remains snapshot provenance and is not treated as an executable backend artifact.

For a null stack or append/prepend stack mode, the backend preflight must provide the base-prompt inputs required by the selected adapter. If the host cannot reproduce the intended base prompt, plan preparation fails.

### 5. AgentResponse

The backend returns normalized terminal status, output, enforcement receipts, effective tools/limits, artifacts, usage, and a routed trace handle. A separate projection determines what enters the parent model's context.

## Responsibility Boundaries

Effective permissions are the intersection of:

1. Profile prompt-stack tool selection.
2. Request access and limit requirements.
3. Backend-advertised capabilities and enforcement.

A backend must reject a required policy it cannot enforce. Prompt tool filtering is not a filesystem, process, or network sandbox.

pi-forge owns profile/stack resolution, trusted prompt compilation, context selection, plan creation, stable fingerprints, diagnostics, and parent-visible response projection. Backends own target-runtime preflight, execution, cancellation, backend-namespace canonicalization, enforcement receipts, usage collection, artifacts, and normalized traces.

## Context Model and Task Preservation

Subagents inherit no parent conversation automatically. Their prepared context contains:

1. System instructions compiled from the resolved profile and backend prompt inputs.
2. Optional parent-selected context rendered as quoted background evidence with provenance.
3. A protected final user task containing all request text and media.

Selected context may contain a provenance-bearing summary, visible user/assistant excerpts, quoted tool-result excerpts, and resource/artifact references. It never automatically contains the parent system prompt, full chat history, hidden reasoning, raw provider payloads, secrets, or environment variables.

Tool-result excerpts are background content, not native tool-result messages, because they do not have matching tool calls in the clean subagent history. Delimiters communicate instruction priority but are not a prompt-injection security boundary.

The delegated task is appended as a protected final user message after unrestricted prompt-stack message layout has been compiled. A backend adapter may combine adjacent user messages for provider compatibility, but it must preserve the delegated-context/task boundary and all structured media parts. Subagent preparation fails if the final normalized plan does not contain the complete task.

Context budgeting uses a required character/byte ceiling in v1. Any optional token estimate records the estimator/tokenizer name and version. Truncation removes optional context before required context and never truncates the final task or required media.

## Contract Artifacts

The TypeScript shapes and pure validators for the following artifacts are now exported. Concrete backend implementations and registration remain deferred.

### AgentRequest

- Schema version and host-generated request ID.
- Profile ID plus an optional expected source fingerprint for optimistic consistency.
- Structured text/media input.
- Optional selected-context summary/items with provenance and a character budget.
- Access requirements expressed through opaque workspace/resource handles, not backend-specific absolute paths.
- Hard execution limits and a separate parent-result projection limit.
- Parent run/session provenance and bounded delegation depth.
- Explicit remote-egress consent when a backend would transmit local project data.

### AgentProfileSnapshot

- Normalized profile fields and canonical source-profile digest.
- Normalized prompt-stack definition and canonical stack digest, or null.
- Required custom macro/slot dependency identities when available.
- No model-registry object, credential/auth result, loaded file path, diagnostics, session state, or secret.

This snapshot is immutable provenance. It is not sent to a backend as a promise that the profile is executable there.

### BackendPreflightResult

- Accepted/rejected state with structured diagnostics.
- Resolved target model and thinking level.
- Stable tool catalog and adapter mappings.
- Prompt-runtime/base-prompt inputs.
- Workspace materialization/mount mappings in the backend namespace.
- Granular enforcement capabilities and accepted hard limits.
- Media, cancellation, trace, artifact, and remote-egress behavior.

### AgentExecutionPlan

- Host-generated run ID, request ID, and backend ID.
- Prepared system prompt and normalized initial messages.
- Exact model, thinking level, effective backend tool IDs, and unmatched policy diagnostics.
- Materialized workspace handles, relative working directory, network policy, and enforcement requirements.
- Enforced execution limits and separate result-projection limits.
- Profile/stack provenance, dependency receipt, and backend preflight receipt.
- Canonical execution fingerprint covering all behavior-affecting prepared inputs.

The run ID exists before backend execution begins so cancellation and trace correlation do not depend on a remote backend first returning its own ID.

### AgentResponse

Response status is a discriminated union:

- `completed`: no error; output may be empty.
- `failed`: structured error required; optional partial output must be marked partial.
- `cancelled`: cancellation reason required; output is absent or explicitly partial.
- `timed-out`: timeout reason and enforced timeout required; output is absent or explicitly partial.
- `limit-reached`: the reached hard limit is required; output is absent or explicitly partial.

Every response includes request/run/backend correlation, model/profile/execution fingerprints, backend-produced enforcement receipt, effective tools and limits, duration, and artifact/trace routing metadata. `effectiveAccess` is never a request echo.

Token usage records tokenizer/model provenance when known. Cost uses an amount plus ISO currency code rather than an unqualified number. Artifact/change paths live in a named workspace namespace and include authorization, lifetime, and cleanup metadata.

Opaque backend trace IDs are registered behind host trace handles. Inspection authorizes the caller and routes through the backend/host trace registry. Hidden provider reasoning remains excluded by default.

Hard execution limits are distinct from response projection truncation. A backend that cannot enforce a required timeout, turn, token, output, filesystem, or network constraint rejects preflight.

## Access and Data-Egress Model

Requests identify host resources with opaque workspace/resource handles. Backend preflight maps them into backend-visible mounts or uploaded resources. The execution plan uses mount IDs plus normalized relative paths rather than assuming host absolute paths exist remotely.

- `none` permits no filesystem mounts and no filesystem working directory.
- `read-only` permits only read-only mounts.
- `workspace-write` permits explicitly identified read-write mounts; all other mounts remain read-only or absent.
- A working directory, when present, must be contained within an accepted mount.
- The backend canonicalizes and checks paths in its own namespace immediately before access and must enforce containment against symlink races.
- Model/provider transport is distinct from agent-accessible network tools.
- Sending project content to a remote backend requires an explicit egress decision; project trust alone is insufficient consent.

Capabilities are granular claims such as read-only mount isolation, read-write mount isolation, symlink-safe containment, agent-network isolation, timeout enforcement, turn enforcement, token-budget enforcement, output enforcement, cancellation, media transport, artifact retention, and trace inspection. Broad booleans are insufficient.

## Fingerprints and Compatibility

New portable fingerprints use canonical serialization and a named algorithm/version such as `sha256:v1:<digest>`.

- Source-profile fingerprint: normalized declarative profile.
- Prompt-stack fingerprint: normalized declarative stack.
- Execution fingerprint: compiled system/messages, exact model/thinking, effective tool IDs/mappings, relevant prompt-runtime inputs, selected-context/resource digests, dependency receipt, materialized access policy, enforced limits, and adapter/preflight version.

The existing `agentProfileFingerprint()` JSON string remains unchanged for stored branch provenance and drift compatibility. Portable snapshot/execution digests are new fields with separate semantics.

## Parent-Visible Result

The complete response is control-plane data. The main agent receives a bounded tool-result projection containing only run ID, terminal status, output, compact artifact/change references, and a compact error/warning when applicable.

Usage details, raw diagnostics, enforcement receipts, and trace history remain out of parent context unless explicitly inspected. Full history is never returned inline. Trace inspection is paginated by summary, normalized transcript, or tool events and excludes hidden reasoning by default. Resumable sessions remain separate and deferred.

## Revised Implementation Plan

### Iteration 1: Shared profile service

- Extract shared typed profile repository operations for load, capture, save/update, and delete.
- Extract profile application and rollback from command rendering.
- Extract typed resolution preview and runtime/provenance drift status.
- Refactor commands to use the service without changing current CLI behavior.
- Add service-level tests so profile UI and subagent preparation share one implementation.

### Iteration 2: Internal real-backend spike (completed)

- Prototype one in-memory Pi SDK backend using a fresh `SessionManager`, explicit model/thinking, a controlled tool baseline, cancellation, and compact output.
- Exercise a real profile, restrictive prompt stack, custom macro/slot dependency, media input, and current local provider.
- Record actual SDK/runtime requirements and failure points.
- Keep all spike types internal and expose no run tool.

Implemented as the opt-in `scripts/subagent-sdk-spike.ts`; results and limitations are recorded in `SUBAGENT_SDK_SPIKE_FINDINGS.md`.

### Iteration 3: Resolve/preflight/plan boundary (completed)

- Split parent application resolution from backend-independent host resolution.
- Define internal request, backend descriptor/preflight, backend-assisted preparation callback, execution-plan, response, enforcement-receipt, and diagnostic types based on the spike.
- Implement protected task/context preparation and tool negotiation.
- Validate null/replace/append/prepend stacks and missing custom dependencies.

Implemented in `src/subagent-host.ts` and `src/subagent-contract.ts`. The SDK spike consumes the shared protected-task and host-resolution helpers.

### Iteration 4: Stable validation and fingerprints (completed)

- Add canonical snapshot/stack/execution digests without changing legacy provenance fingerprints.
- Add pure validators and the full status/error/access/limit matrices.
- Add deterministic context budgeting and artifact/trace namespace validation.
- Export only the portions demonstrated by the real spike.

Implemented with canonical `sha256:v1` fingerprints, deterministic UTF-8 context budgeting, access/limit/status matrices, artifact/trace validation, and package-root exports. Legacy profile provenance fingerprints are unchanged.

### Iteration 5: Backend registration and conformance (completed)

- Added an optional backend registry/dispatcher with validated descriptor discovery and granular capability negotiation.
- Added a deterministic fake backend and reusable conformance fixtures shaped by the real spike.
- Normalized cancellation races, host-abort timeouts, provider failures, malformed responses, enforcement receipts, and authorization-scoped trace routing.
- pi-forge remains fully functional with no registered backend; the registry starts empty.

### Iteration 6: Parent integration (next design decision)

- Design the smallest run/inspect tool surface after enforcement and task preservation work end to end.
- Resolve profile/context and prepare a plan before dispatch; backends never read project profile/session files directly.
- Insert only the bounded response projection into parent context.
- Cover success, failure, cancellation, timeout, limit, media, access rejection, artifact, and trace inspection end to end.

### Iteration 7: Product and runner decision

- Decide whether the validated adapter remains internal, ships optionally, or just informs integrations.
- Continue deferring a full owned runner, resumable agents, retries, queues, chains, pipelines, and concurrency orchestration until concrete demand exists.

Profile UI can proceed independently on the completed Iteration 1 service; it does not need to block Iteration 5. Each iteration remains independently reviewable and revertible.

## Deferred Decisions

- Concrete shipped backend and configuration surface.
- Trace/artifact storage location, retention defaults, redaction, and cleanup implementation.
- Resumable sessions and continuation references.
- Automatic retries, fallbacks, priorities, queues, and concurrency.
- Secret/environment injection.
- Structured JSON-schema output.
- Automatic parent-context selection beyond explicit summaries and references.
