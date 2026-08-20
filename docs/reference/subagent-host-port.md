# Subagent host port contract

[Documentation](../README.md)

Status: experimental, versioned (`FORGE_HOST_PORT_VERSION = 1`). The `/subagent` entry point is the main package's only subagent surface: a transport-neutral host port over data-only messages. Subagent execution, approval, and configuration live in the optional [`@zihanw/pi-forge-subagents`](https://github.com/MacroSony/pi-forge-subagents) package, which consumes this port and never imports main-package internals.

## Ownership boundary

- **Main package owns:** prompt-stack/agent-profile storage and validation (repositories + codecs), the immutable `ForgeWorkspace` snapshot, profile/stack resolution, host-owned prompt compilation, and tool filtering through stack policy.
- **Optional package owns:** delegation authorization (`subagents.json`), the execution contract (request, preflight, plan, response, validators), backend preflight and sealing via `@zihanw/pi-subagent-runtime`, approval UX, and execution.
- **Never crosses the port:** live contexts, internal registries, execution/runtime material (access workspace model, limits, `resultProjection`, `parent`, `remoteEgressConsent`, a base system prompt). The client sends only a profile selector, the task, prompt-compilation access facts (`level`/`network`/`allowProcess`), and backend facts (model, thinking level, tool catalog).

## Transport and lifecycle

`ForgeHostTransport` is a minimal `{ emit(channel, data), on(channel, handler) }` interface; the production wiring is `pi.events`. Wire messages are plain JSON-compatible data validated recursively (exact nested fields, typed enums, plain objects only, unknown fields rejected) at both boundaries.

Mandatory lifecycle rules:

1. Clients subscribe before announcing or discovering, and use bounded timeouts.
2. A duplicate live host fails explicitly (`host.duplicate`).
3. `request`/`reply` messages carry `hostId` + `generation`; stale-generation and wrong-host requests are rejected server-side, mismatched replies ignored client-side.
4. Disposal sends `unavailable` and invalidates connections; all transient and persistent listeners are cleaned up.
5. The host can only start after the first workspace snapshot exists, so an advertised host implies a loaded workspace. Reload honors project trust: untrusted workspaces expose global resources only.

## Operations

### Discovery

`ForgeHostClient.discover()` / `ForgeHostSession` in the optional package announce on `FORGE_HOST_CHANNEL` and wait for `available` with capabilities.

### `listProfiles`

Request: `{}`. Response: `{ profiles: ForgeProfileSummary[] }` — each with `profileId`, `scope`, optional `name`/`description`/`autoActivate`, `model`, `thinkingLevel`, `promptStack`, `usable`, and load diagnostics. Read-only; no resolution side effects.

### `resolveProfile`

Request: `{ profile: string }` — a scoped selector (`reviewer`, `project:reviewer`, `global:reviewer`). Response: `{ snapshot }` — the immutable host-owned profile snapshot artifact: resolved profile and prompt stack JSON, prompt dependency list, and `sha256:v1` content fingerprints (`profileFingerprint`, `promptStackFingerprint`) computed with Forge-owned canonical helpers byte-compatible with the runtime's canonical JSON. The optional package re-validates and re-fingerprints the snapshot before binding it into execution plans.

### `prepare`

Request: `{ profile, task: { text }, access: ForgePromptAccessFacts, backend: ForgeBackendFacts }`. The workspace resolves the profile and stack from its snapshot, filters the client tool catalog through stack tool policy and the access facts, and compiles through the same compilation context as runtime and preview. Response: `{ profileId, model, thinkingLevel, systemPrompt, messages, effectiveToolIds, effectiveToolNames, diagnostics, profileSnapshot, preparedAt }`. `messages` ends with the protected delegated task (`protectedTask: true`, `source: "delegated-task"`); stack-compiled messages carry `source: "prompt-stack"`. The base system prompt is host-owned and intentionally empty for delegated subagents — the prompt stack composes the system prompt.

## Fingerprints

`canonicalSubagentJson`, `subagentFingerprint`, `subagentSourceProfileFingerprint`, `subagentPromptStackFingerprint`, and `SUBAGENT_FINGERPRINT_PREFIX` are Forge-owned and vendored in the main package; golden vectors pin byte compatibility with the runtime's canonical serialization. Conversation and execution fingerprints are never host-computed — they are issued by `@zihanw/pi-subagent-runtime` during plan sealing in the optional package.

## Errors

`ForgeHostPortError` carries `code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid"`. Operation-level failures return `{ ok: false, error }` results rather than throwing across the bus.
