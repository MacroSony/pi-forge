# Historical subagent design review

Status: historical pre-implementation review. Its blocking findings were resolved by the exported contract, validated backend registry, immutable preparation binding, concrete backends, and approval-gated foreground integration; the text below records the issues that shaped that design.

## Verdict

`NEXT_STEPS.md` is directionally sound and mostly suits pi-forge's current architecture. The profile CLI to shared profile service to profile UI progression is appropriate, and deferring an owned runner is the right call.

`SUBAGENT_INTERFACE_DESIGN.md` is a good requirements draft, but it is not yet an implementable backend-neutral contract. Its status should remain draft rather than accepted until the blocking issues below are resolved.

## Findings

### 1. Blocker: a serialized prompt-stack definition is not an executable snapshot

The proposed `AgentProfileSnapshot` carries only the declarative `PromptStack`. Current compilation also depends on:

- Dynamic `BuildSystemPromptOptions`, the current model, time, variables, and the base system prompt supplied through Pi's lifecycle.
- Executable custom slot and macro registrations.
- Pi tool snippets, guidelines, skills, and context files represented by `PromptRuntime`.
- Pi's default system prompt when the stack is `null`, `append`, or `prepend`.

Two backends receiving the same proposed snapshot can therefore compile different prompts or fail to compile custom slots entirely.

Recommended design: separate two artifacts:

- `AgentProfileSnapshot`: immutable declarative provenance.
- `AgentExecutionPlan`: a host-prepared system prompt, initial messages, effective tool names, runtime inputs, diagnostics, and an execution fingerprint.

The alternative is to require every backend to run an identical Pi/pi-forge runtime and custom-extension set, but that would not be genuinely backend-neutral.

Relevant code:

- `SUBAGENT_INTERFACE_DESIGN.md:86`
- `src/lifecycle.ts:86`
- `src/types.ts:178`
- `src/slot-renderers.ts:125`
- `src/macro-engine.ts:122`

### 2. Blocker: profile resolution currently means valid in the parent Pi runtime

The current resolver checks models and authentication against the active Pi model registry. A remote, subprocess, or package backend may have different models and credentials.

Resolution should be split into:

- Host resolution: profile syntax, stack lookup, and trusted extension dependencies.
- Backend preflight: model availability/authentication, tool availability, media support, policy enforcement, and supported limits.

Without that split, the advertised native/subprocess/remote portability is not achievable.

Relevant code:

- `src/agent-profile.ts:156`
- `src/agent-profile.ts:172`
- `src/index.ts:179`

### 3. High: tool negotiation and enforcement are underspecified

`NEXT_STEPS.md` says the runner supplies a baseline and the stack filters it, but the request contains neither the backend's tool catalog nor the resolved effective tools. Current pi-forge filters a dynamic active-tool baseline.

The backend contract needs a discovery or preflight phase that exposes:

- Available tool names or stable capability IDs.
- The access and limit policies it can enforce.
- Exact effective tools after stack policy.
- Required tool patterns that matched nothing.
- Adapter-specific tool-name mappings, if any.

A stack tool allowlist is selection policy, not filesystem or network isolation.

Relevant code:

- `NEXT_STEPS.md:62`
- `SUBAGENT_INTERFACE_DESIGN.md:86`
- `SUBAGENT_INTERFACE_DESIGN.md:167`
- `src/index.ts:270`

### 4. High: the access contract is not portable or sufficiently enforceable

The contract combines remote backends with host absolute paths in `access.cwd` and `access.roots`, while validation requires host-side canonicalization and symlink checks. Those paths may not exist in a remote or container namespace, and host preflight cannot prevent backend-side symlink races.

The capability booleans are too coarse to determine whether roots, read-only mounts, output limits, token budgets, or turn limits are enforceable.

Recommended changes:

- Define access using backend-visible mounts or opaque workspace handles.
- Require the backend to canonicalize paths within its own namespace immediately before access.
- Specify whether `cwd` must be contained in an allowed root.
- Define the behavior of `level: "none"` when roots are also supplied.
- Represent granular enforcement support rather than broad booleans.
- Distinguish model/control-plane network traffic from agent-accessible network tools.
- Treat remote-backend data egress as a separate trust/consent decision.

Project trust is not, by itself, consent to send project context to a remote backend.

Relevant design sections:

- `SUBAGENT_INTERFACE_DESIGN.md:108`
- `SUBAGENT_INTERFACE_DESIGN.md:167`
- `SUBAGENT_INTERFACE_DESIGN.md:216`

### 5. Medium: clean-context assembly conflicts with unrestricted prompt-stack layouts

The design requires the final task to survive truncation, while existing `compileMessages()` behavior permits a stack to remove the latest user message, filter user roles, or omit history. Such a stack can accidentally remove the delegated task.

The contract needs one explicit rule:

- Reject stacks whose compiled delegation layout omits the task; or
- Reserve a delegation-task insertion point that cannot be filtered; or
- State that intentional omission is allowed, weakening the guarantee that the actionable task is always preserved.

Additional context concerns:

- "Selected context is data" is an instruction-hierarchy convention, not a security guarantee. Delimiters do not prevent prompt injection.
- Tool-result excerpts should normally be rendered as quoted background evidence rather than native tool-result messages without matching tool calls.
- A summary should carry provenance just as other selected context does.
- `maxTokens` cannot be deterministically portable without defining the tokenizer or estimator. A byte/character bound or recorded estimator/version would be clearer.

Relevant code and design:

- `SUBAGENT_INTERFACE_DESIGN.md:28`
- `SUBAGENT_INTERFACE_DESIGN.md:41`
- `SUBAGENT_INTERFACE_DESIGN.md:223`
- `src/compiler.ts:88`
- `src/compiler.ts:161`

### 6. Medium: the real adapter spike comes too late

The implementation plan first publishes contract types and builds four slices around fake backends, then validates the design against a real runner in Slice 6. Fake conformance tests can prove internal consistency, but cannot establish that the boundary fits a real backend.

The installed Pi SDK already supports session construction with model, thinking level, tools, custom tools, and resource loaders. A minimal in-memory or subprocess prototype should happen before the contract becomes a public export.

Move the current concrete-adapter decision/spike before contract stabilization. Keep experimental types internal until that spike validates the boundary.

Relevant design and API:

- `SUBAGENT_INTERFACE_DESIGN.md:227`
- `SUBAGENT_INTERFACE_DESIGN.md:262`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.d.ts:11`

### 7. Medium: profile UI needs a shared service extraction first

The profile UI priority is appropriate, but save, status/drift calculation, deletion, and application are not yet presented as one shared typed service. Save and drift rendering are still command-oriented.

Before UI work, extract shared operations for:

- Save/update/delete.
- Resolution and typed preview.
- Application.
- Typed provenance and runtime-drift status.

This prevents the UI from duplicating command behavior and directly supports the stated done criteria.

Relevant code:

- `NEXT_STEPS.md:34`
- `src/profile-command.ts:258`
- `src/profile-command.ts:455`

### 8. Medium: fingerprints need explicit stable semantics

Execution-facing fingerprints should use canonical serialization and a named digest algorithm/version, for example `sha256:v1:<digest>`. A raw `JSON.stringify()` value is useful for current provenance comparison but is not an ideal portable fingerprint.

The execution fingerprint should cover all behavior-affecting prepared inputs, not only the source profile and stack. This includes the compiled prompt/messages, effective tools, relevant runtime data, and required custom registrations.

Avoid silently changing the semantics of existing stored provenance fingerprints; introduce a separate execution/snapshot fingerprint format if compatibility matters.

Relevant code:

- `src/agent-profile.ts:243`
- `SUBAGENT_INTERFACE_DESIGN.md:222`

### 9. Medium: response, trace, and limit semantics need tightening

Before parent integration, clarify:

- Which statuses require or forbid `error`.
- Whether `output` may be empty for failures and cancellations.
- Whether `effectiveAccess` is merely echoed or is a backend-produced enforcement receipt.
- Effective tool and enforced-limit metadata in the response.
- Currency and units for `usage.cost`.
- Artifact and change-path namespace, authorization, lifetime, and cleanup.
- How an opaque trace reference routes back to the correct backend and how inspection is authorized.
- Cancellation before a remote backend has exposed its `runId`.
- Whether limits are hard execution limits or only response/projection truncation.

The current capability interface cannot indicate support for `maxTurns`, `maxOutputBytes`, or `tokenBudget`, so the dispatcher cannot reliably apply the rule that unsupported required policies must be rejected.

## Recommended ordering

1. Complete real-provider and real-extension-tool profile CLI compatibility testing.
2. Extract the shared profile repository/application/status service.
3. Build profile UI on that service with browser workflow coverage.
4. Prototype one actual Pi SDK or subprocess backend.
5. Revise the subagent design around backend preflight plus a host-prepared execution plan.
6. Add pure validators, stable fingerprints, fake-backend conformance tests, and optional backend registration.
7. Add parent run/inspect tools only after enforcement and task-preservation semantics are demonstrated.
8. Continue deferring an owned full runner, resumable agents, chains, pipelines, retries, queues, and concurrency orchestration.

Custom macro/slot portability can remain broadly deferred, but dependency detection cannot. A subagent export must identify required registrations or reject stacks that cannot be reproduced by the chosen backend.

## Parts of the plan worth retaining

- Profiles remain reusable one-shot presets rather than continuously owning runtime state.
- Prompt stacks remain the profile-level source of tool-selection policy.
- Per-run access and limits remain outside reusable profiles.
- Parent context selection is explicit, bounded, and provenance-preserving.
- Parent-visible results remain compact, with full normalized history behind an inspectable trace.
- No concrete subagent package is required to install or use pi-forge.
- A full owned runner remains deferred.
- Initial runner work avoids chains and pipelines.
- Browser workflows and public contract behavior receive dedicated tests.

## Validation performed during review

- Core tests: 126 passed.
- TypeScript typecheck: passed.
- Real-browser editor smoke test: passed.
- Tracked `dist/` consistency check: passed.

The review itself did not modify implementation code or either source design document.
