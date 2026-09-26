# Active-state bus contract

[Documentation](../README.md)

Status: neutral, versioned. This is an optional appearance/session metadata seam consumed over the Pi event bus. It is not a package import entry point and has no Pi Pet-specific dependency. Consumers attach to `pi.events` (or `ctx.events`) and must treat every failure cosmetically.

## Channels

- Snapshot/change: `@zihanw/pi-forge/active-state/v1`
- Snapshot request: `@zihanw/pi-forge/active-state/request/v1`

The production publisher is the main pi-forge extension. It registers the request listener on attach and removes it on disposal/session switch. No unbounded retries or timers are used.

## Request

```json
{ "schemaVersion": "1", "sessionId": "raw Pi session-manager id" }
```

`sessionId` is optional. When present, the publisher answers only if it matches the currently bound session; when omitted, it answers the current snapshot. A late subscriber can therefore request the current state after missing an earlier publish. Malformed or oversized requests are ignored.

## Event

```json
{
  "schemaVersion": "1",
  "sessionId": "raw Pi session-manager id",
  "instanceId": "uuid",
  "revision": 1,
  "stackKey": "global:slug",
  "profileKey": null,
  "projectKey": "64 lower hex sha256"
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `"1"`. Unknown versions are rejected. |
| `sessionId` | Raw Pi session-manager ID for the bound session. |
| `instanceId` | Fresh bounded publisher instance (`^[A-Za-z0-9_-]{1,128}$`, UUID-compatible) per attach/epoch. A new instance retires the old one. |
| `revision` | Monotonic safe integer within one instance. |
| `stackKey` | Effective scoped prompt-stack key, or `null` when disabled/off. |
| `profileKey` | Compatible applied-profile provenance key, or `null` (see below). |
| `projectKey` | Opaque SHA-256 project identity, or `null`. Never a raw path. |

No other fields cross the channel. Prompt text, file paths, tokens, credentials, model configuration, tool policy, and character data are never included.

## Identity and scope rules

- Scoped keys use `^(global|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Invalid values become `null`; scoped IDs never cause filesystem access.
- `projectKey = sha256("pi-forge-project-v1\0" + hostname + "\0" + path.resolve(cwd))`, lower hex. Only the digest crosses the bus, so two working directories are isolated without revealing either path.
- Global resource bindings ignore `projectKey`.
- Project resource bindings **require** `projectKey`. A project-scoped `stackKey`/`profileKey` with a `null` project key fails closed. When the session `cwd` is empty or unresolvable, the publisher nulls project-scoped `stackKey`/`profileKey` rather than emit a snapshot its own validator rejects.
- `instanceId` uses the bounded UUID-compatible scalar grammar above; control characters, path separators, dots, and other punctuation are rejected. Real session IDs remain raw bounded strings (1..1024 chars).
- `profileKey` is derived from `lastAppliedProfile` only while its recorded `snapshot.promptStack` equals the current effective scoped stack (`null` equals disabled). It is cosmetic compatible-provenance identity, not a claim that the current model, thinking level, or tools still match the profile. Manual stack drift clears an unrelated profile binding.

## Publishing lifecycle

The publisher emits on: initial session bind/restore, session start, tree navigation, compaction, explicit preset changes (`enable`, `none`/off), profile apply/update, web-editor updates, and disposal. Workspace changes publish without any provider/model call.

Rules:

1. `instanceId` is per attach. Switching sessions emits a final cleared snapshot for the old session, then a new instance for the new session.
2. `revision` is monotonic within an instance. At the `Number.MAX_SAFE_INTEGER` boundary the publisher rotates to a fresh instance epoch instead of wrapping the same instance back to `1`. A snapshot request repeats the current revision rather than advancing it.
3. Disposal emits a cleared snapshot (`stackKey`/`profileKey`/`projectKey` as available, stack/profile `null`) and unregisters the request listener.
4. Session start/tree/compact suspend publication and request replies across `restoreBranchScopedRuntime`, then bind and publish one latest coherent snapshot. A failed restore detaches/clears instead of leaving the old session bound to the new workspace.
5. Optional listeners never alter Forge compilation, tool policy, or provider behavior; a throwing reader/listener/transport is isolated. The shutdown path attempts every teardown step even if an optional transport rejects `emit`/`on`/`unsubscribe`.
6. The same live instance/epoch is retained across a same-session compaction; cosmetic state is not cleared/recreated needlessly.

## Consumer expectations (normative)

- Accept only events whose `sessionId` matches the consumer's current Pi canonical session identity.
- Reject stale/duplicate revisions and snapshots from retired instances with bounded tracking; never retry unboundedly.
- Fail closed on malformed or oversized payloads, wrong schema versions, or project-scoped bindings without a `projectKey`.
- Clear context on an explicit cleared snapshot; do not treat bus traffic as an implicit identity/status/auth/Team change.

See [public API policy](public-api.md) for how this bus contract relates to the package import surfaces.
