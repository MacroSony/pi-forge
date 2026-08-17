# Pi cross-extension host-discovery spike

[Design index](../../README.md) · [0.5 architecture plan](../../architecture-0.5.md) · [0.5 migration inventory](0.5-inventory.md)

Status: completed Phase 0 spike; architecture decision pending

Date: 2026-08-17

## Question

Can a separately installed `pi-forge-subagents` Pi extension reliably discover
and use the active main `pi-forge` extension without importing its internal
runtime state or relying on a process-global registry?

## Environment and method

- Tested against the repository's installed
  `@earendil-works/pi-coding-agent` 0.83.0 fixture.
- Used Pi's exported `createEventBus`, `createExtensionRuntime`, and actual
  `loadExtensionFromFactory` loader. The factories used only `pi.events`.
- This was an in-memory Phase-0 harness, not a shipped extension or production
  host-port implementation.

The harness covered both extension load orders, compatible and incompatible
versions, and unregistering a host listener. All cases passed:

| Case | Result |
|---|---|
| Host factory loads before client factory | Client discovery receives one compatible host reply |
| Client factory loads before host factory | Client's availability listener receives the later host announcement |
| Client requires an unsupported version | No host is accepted |
| Host unregisters its listener | A subsequent discovery request receives no reply |

## Observations

1. `ExtensionAPI.events` is a shared event bus across extension factories
   loaded into the same Pi runtime.
2. The bus exposes only `emit(channel, data)` and `on(channel, handler)`, with
   an unsubscribe function. It does not expose a service registry, request
   return values, sender identity, serialization, timeout, version negotiation,
   duplicate-host handling, or lifecycle ownership.
3. Pi wraps each event handler in an asynchronous error boundary. `emit()` is
   therefore fire-and-forget; callers must not depend on handler order or a
   synchronous reply, even though a handler with no initial `await` may appear
   to reply synchronously in a simple test.
4. The bus is in-process. It can coordinate packages loaded into one Pi
   invocation, but it is not a cross-process, remote, or security boundary.
5. A direct import of a module-level workspace singleton remains unsuitable:
   Pi package installation can produce independent package instances, and that
   mechanism provides no duplicate-host or reload semantics.

## Recommended decision candidate

Use Pi's event bus as the transport for a **versioned, session-scoped Forge host
RPC protocol**. Do not use a process registry or a direct reference to
`ForgeWorkspace`.

The port must use plain, validated data messages rather than function callbacks
or the return value of `emit()`. A minimal protocol has these message families:

| Channel family | Direction | Required behavior |
|---|---|---|
| `@zihanw/pi-forge/host/v1/discover` | Client → host | Carries request ID, client identity/version, and supported protocol range |
| `@zihanw/pi-forge/host/v1/available` | Host → clients | Announces host ID, protocol version, capability set, and lifecycle generation after discovery listener registration |
| `@zihanw/pi-forge/host/v1/reply` | Host → client | Correlates discovery or operation result with request ID; carries typed success/failure data |
| `@zihanw/pi-forge/host/v1/request` | Client → host | Invokes only documented operations using validated request data |
| `@zihanw/pi-forge/host/v1/update` | Host → client | Optional bounded progress/resource-change events correlated to subscription or run IDs |
| `@zihanw/pi-forge/host/v1/unavailable` | Host → clients | Invalidates host ID/generation during disposal or replacement |

The final operation catalogue is still open, but must expose results and
snapshots—not Pi contexts, `ForgeWorkspace`, loaded resource objects, web-editor
state, callbacks, or internal registries. Cancellation must be a request by
run ID; it must not transfer `AbortSignal` objects through the port.

## Required protocol rules before implementation

- Clients subscribe to reply, availability, update, and unavailable events
  before announcing/discovering; they use a bounded timeout and clean up all
  listeners.
- A host registers discovery/request listeners before sending `available`.
- Host and client validate every message and ignore unknown protocol versions,
  malformed payloads, stale generations, and unrelated request IDs.
- More than one live compatible host is an explicit `host.duplicate` failure;
  the client must not silently choose a host by load order. Incompatible hosts
  are reported distinctly.
- `ForgeWorkspace` owns host registration, generation, and disposal. On Pi
  session shutdown/reload it sends `unavailable`, unregisters listeners, and
  rejects new work; clients invalidate outstanding handles and report a clear
  unavailable diagnostic.
- The port is an integration contract, not a trust boundary. Pi extensions
  already execute in the same trusted process; the host must not transmit raw
  credentials, arbitrary live contexts, or undeclared project data.
- The optional package must remain usable as an ordinary Pi extension only when
  the main host is present and protocol-compatible. Its absence must leave the
  main pi-forge extension fully functional.

## Limits and follow-up

This validates the event-bus transport in Pi 0.83.0 only. The Phase-0 Pi
compatibility gate still needs a documented range and packed-install matrix that
includes the release-time Pi version. The protocol, public operations, package
versioning, configuration ownership, and migration remain architecture decisions
to be accepted before Phase 5 implementation.
