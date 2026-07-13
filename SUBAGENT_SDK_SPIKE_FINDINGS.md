# Pi SDK Subagent Spike Findings

Status: completed internal spike against `@earendil-works/pi-coding-agent` 0.80.6 on 2026-07-12. Its Iteration 3/4 contract findings are now implemented in the exported pure adapter boundary; it still does not add a user-facing subagent runner or backend registry.

## Deliverable

The opt-in spike is available through:

```bash
npm run spike:subagent -- --cwd /path/to/project --profile PROFILE_ID
```

Dry-run is the default. A provider call requires `--execute`; that explicit flag is also the spike's consent to transmit the supplied task/media to the selected provider. The other spike-only flags are:

- `--task TEXT`
- `--timeout MILLISECONDS`
- `--access none|read-only|workspace-write`
- `--image PATH` (repeatable)
- `--load-forge-extensions` to execute trusted global/project pi-forge registration code

The command emits a JSON preflight/execution report. It creates an in-memory `SessionManager`, uses an isolated SDK resource directory and working directory for `access=none`, loads only the inline compiler bridge, does not write a Pi session file, and disposes the session and trusted registrations when finished.

Execution currently rejects `read-only` and `workspace-write`. The SDK can filter tools, but this adapter cannot produce an allowed-root, symlink-safe filesystem/process/network isolation receipt. `access=none` is enforceable by setting the active tool set to empty.

## Validated Behavior

### Real profile, model, auth, and stack

The dry and execute paths resolved `/home/bruhw/programming`'s `default` profile to:

- Model: `opencode-go/glm-5.2`
- Thinking: `high`
- Stack: `qiqi-assistant`
- Auth: configured through Pi's real `AuthStorage` and `ModelRegistry`

The SDK session used those exact values, remained in memory, and exposed no session file. A real no-tool turn completed with `SPIKE_OK`.

### Tool discovery and policy

The isolated Pi 0.80.6 SDK session advertised seven built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. This confirms that adapter discovery must be dynamic; neither pi-forge nor the contract should hard-code the interactive UI's historical four-tool baseline.

The spike computes:

```text
backend catalog ∩ prompt-stack policy ∩ request access
```

It records the backend catalog, stack-selected names, effective names, unmatched allow patterns, and whether the requested access can actually be enforced. Tool selection worked for dry preflight, and `access=none` produced an empty effective set in real execution.

Pi's public `ToolInfo` includes names, descriptions, parameter schemas, prompt guidelines, and source metadata, but not the one-line `toolSnippets` used by the base prompt. Those snippets are available in `before_agent_start.systemPromptOptions`. A dry plan built only from the public catalog is therefore intentionally marked `partial-dry-run`.

### Exact prompt preparation and protected task

The inline SDK extension receives the exact base system prompt and `BuildSystemPromptOptions` in `before_agent_start`, then calls the existing pi-forge compiler. On the first `context` event it:

1. Removes the delegated task from unrestricted history compilation.
2. Compiles optional history and synthetic prompt-stack messages.
3. Appends a structured clone of the delegated text and media as the protected final user message.

This preserved the task through `qiqi-assistant` and `image-viewer`, including layouts that add synthetic user messages. Offline tests also cover a `chat-history` slot configured to omit the latest user message and prove that it cannot remove the protected task.

The exact `BuildSystemPromptOptions` are not publicly obtainable during passive SDK preflight. For a Pi SDK adapter, exact plan preparation must therefore be backend-assisted inside the accepted prompt lifecycle, after capability preflight but before the provider request. The adapter must fail the turn before transport if compilation or task-preservation validation fails.

### Trusted custom macros and slots

`--load-forge-extensions` explicitly loads trusted global/project pi-forge registration modules in the host. A dry fixture using `examples/custom-system-status-extension` validated that:

- The extension module was discovered and registered.
- Prompt stacks were reloaded and revalidated after registration.
- The `cpuLoad` macro and `machine-status` slot compiled without stale unsupported-slot diagnostics.
- Registrations were unloaded during cleanup.

This supports keeping executable dependencies in the trusted host. It also confirms that host resolution must load required registrations before final stack validation. Dependency identity and missing-dependency receipts remain future work.

### Media

A real `opencode-go/qwen3.7-plus` turn used the `image-viewer` profile and a 1.6 MB PNG. The model received the image, completed successfully, and identified the visible Pi symbol. The final structured task and image were preserved by the prompt-stack layout.

Preflight rejects image input when the selected model does not advertise `image` support. File paths are converted to SDK `ImageContent` only for explicitly supplied `--image` references.

### Timeout, cancellation, response, and trace

A real `glm-5.2` turn with a 1 ms host deadline called `session.abort()`, settled in roughly 70 ms, reported `timed-out`, and recorded zero provider tokens/cost. A normal run reported completion, output, duration, session statistics, and a compact normalized lifecycle trace.

The SDK does not enforce hard turn, token, or output limits through `createAgentSession`. Its statistics report numeric cost without a currency code. Future response normalization must mark those limits unsupported and treat cost currency as unknown unless the adapter can supply it.

The spike trace includes lifecycle and tool start/end metadata only. It excludes streaming content, provider payloads, credentials, and hidden reasoning.

## Contract Revisions Implemented

1. Split backend work into discovery/preflight, backend-assisted plan preparation, and execution. Preparation may occur inside an adapter-controlled pre-provider hook when the backend cannot expose exact prompt-runtime inputs earlier.
2. Keep the host responsible for profile/stack resolution, trusted compiler execution, protected-task assembly, diagnostics, and plan validation, even when the adapter supplies runtime inputs through a callback.
3. Do not require a passive dry preflight to reproduce the exact prompt when the backend cannot expose all inputs. Record prompt-runtime fidelity and reject execution if exact preparation cannot be completed before provider transport.
4. Make tool discovery dynamic and include a separate prompt-runtime receipt; `ToolInfo` alone is insufficient to recreate Pi's prompt.
5. Treat tool filtering and access isolation as separate receipts. The current Pi SDK adapter supports only `access=none` honestly.
6. Distinguish backend-native limits from host best-effort controls. The observed timeout uses host abort and is not proof of process-level hard isolation.
7. Load trusted macro/slot registrations before final stack validation and later add explicit dependency identities/fingerprints.
8. Normalize assistant error/aborted stop reasons because `session.prompt()` may settle with a terminal assistant message rather than throw.

## Remaining Gaps

- No allowed-root filesystem, subprocess, or agent-network isolation.
- No hard turn, token, or output-byte enforcement.
- No extension-tool execution: the spike intentionally isolates third-party Pi extensions and validates only the built-in catalog plus prompt-stack filtering.
- No backend registry, artifact store, trace registry, run/inspect tool, or parent-visible result projection.
- Custom dependency scanning records macro/slot names and registration sources, but it cannot fingerprint executable registration code.
- Cancellation was validated through a deadline; user-initiated cancellation and cancellation races still need conformance cases.

These gaps block user-facing delegation and a concrete backend registration, but the pure adapter contract is now available for Iteration 5 conformance work.

## Verification Evidence

- Offline suite: 146 tests passed, including twelve contract matrix tests and four SDK-spike policy/context tests.
- TypeScript typecheck: passed.
- Real profile dry preflight: passed.
- Real `glm-5.2` no-tool completion: passed.
- Real host-timeout/abort case: passed.
- Real `qwen3.7-plus` PNG input: passed.
- Trusted custom macro/slot dry fixture: passed.

The generated reports were inspected during the spike and were not committed because they contain machine-specific paths, run IDs, timing, and provider usage.
