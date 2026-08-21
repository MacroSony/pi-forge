# UI contribution port contract

[Documentation](../README.md)

Status: experimental, versioned (`UI_CONTRIBUTION_PORT_VERSION = 1`). The `@zihanw/pi-forge/ui-contribution` entry point is the generic cross-extension port that lets optional packages contribute schema-driven pages to the pi-forge web editor's top-level **Settings** surface. The forge side knows nothing about specific providers; the first consumer is [`@zihanw/pi-forge-subagents`](https://github.com/MacroSony/pi-forge-subagents), which contributes its Subagent Settings page when installed.

## Ownership boundary

- **The contributing package owns** its tab's form schema, current values, server-side validation on write, and persistence (for example, the subagent package owns `subagents.json`). It implements the provider side of the port.
- **pi-forge owns** provider discovery over the bus, rendering contributed pages through the generic schema-form renderer, and proxying browser writes back over the bus through the web server routes. It never interprets or stores contributed configuration itself. Contributed pages are not stack tabs and never mount in the stack Preview dock.
- **Never crosses the port:** functions, components, live contexts, internal registries, or any non-JSON-compatible value. All payloads are plain recursively validated JSON. The port is not a trust boundary — providers must re-validate everything they receive and never trust the web client.

## Transport and lifecycle

`UiContributionTransport` is a minimal `{ emit(channel, data), on(channel, handler) }` interface; the production wiring is `pi.events`. Messages travel on the dedicated `@zihanw/pi-forge/ui-contribution/v1` channel namespace with its own version counter, separate from the `/subagent` host port. Wire messages are plain JSON-compatible data validated recursively at both boundaries (exact field sets, typed enums, plain objects only, unknown fields rejected).

Channels: `discover`, `available`, `request`, `reply`, `unavailable`.

Lifecycle rules:

1. Version negotiation: `discover` carries `protocolVersion` plus a supported `minVersion`/`maxVersion` range; a compatible provider answers `available` with its own `protocolVersion`, range, `capabilities`, `hostId`, and `generation`.
2. A second compatible provider fails discovery explicitly (`duplicate`).
3. `request`/`reply` messages carry `requestId` + `hostId` + `generation`; stale-generation and wrong-host requests are rejected server-side, mismatched replies ignored client-side.
4. Provider disposal sends `unavailable`. The web editor clears that provider's contributed Settings pages and re-discovers when a provider reappears across sessions; late-surfacing providers are picked up without a page reload path change. The local HTTP listing also carries a forge-owned monotonic, opaque provider-session key so a fast restart refreshes a still-visible form even when browser polling never observes the empty interval. Browser PUT handling binds each response to the session that received it; a delayed success from an older session cannot mark or overwrite the newer session and the preserved draft is retried instead.
5. Operation handlers must never throw across the bus; failures return `{ ok: false, error }` results.

The Settings host keeps the first descriptor for each `tabId`; later duplicates are ignored. Browser button IDs use a Settings-specific prefix and cannot collide with built-in stack tabs. Providers should still emit unique stable `tabId` values because `writeValues` routes by that identifier. In-progress drafts and save status are tracked per tab, so switching between contributed pages does not discard a pending edit or leak its status into another page.

## Operations

### Discovery

The web host acts as the client: `UiContributionClient.discover()` announces on the channel namespace and waits (bounded timeout) for an `available` announcement. Discovered tab descriptors are fetched at page load through `GET /api/contrib`.

### `listContributions`

Request: `{}`. Response: `{ tabs: UiContributionTabDescriptor[] }` — each descriptor carries `tabId`, `title`, `icon`, a `FormSchema`, and the current `values`. Read-only; listing a tab contributes it to the editor but performs no other side effect.

### `writeValues`

Request: `{ tabId, patch }` — a partial values patch for one contributed tab. The provider merges the patch over its current values, re-validates server-side, and persists the result to its own storage. Response: `{ ok: true, values? }` with the canonical stored values, or `{ ok: false, errors }` with per-field error strings keyed by field key (dotted paths for record rows). The web server exposes this as `PUT /api/contrib/<tabId>` and rejects malformed or oversized request bodies with 400/413 before any bus call.

The browser serializes autosave requests. If the form changes while a PUT is in flight, the latest complete normalized snapshot is queued and written only after the current request settles. This ordering prevents older provider writes from landing after newer ones.

## Form schema

v1 field types are deliberately restricted: `boolean`, `number`, `enum`, `string`, and `record` (a keyed table of entries — for example per-profile settings). Fields carry `key`, `label`, optional `description`/`required`/`default`, enum `options` (plain strings or `{ value, label }`), numeric `min`/`max`, string `maxLength`/`pattern`/`placeholder`, and record sub-fields (`recordFields`, `keyLabel`, `keyPlaceholder`). There is intentionally no remote-data-source field type yet (a dropdown fed by live forge data); such values are plain text inputs validated on write.

## Errors

`UiContributionPortError` carries `code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid"`. Operation-level failures return `{ ok: false, error }` results rather than throwing across the bus.
