# Session cache usage

[Documentation](../README.md) · [简体中文](../zh-CN/reference/session-cache.md)

Available in Forge 0.5.5. The nested-usage contract is experimental; producer integration is owned and released independently by optional tools. Forge tracks and summarizes read-only prompt-cache metrics for the active session branch. These metrics appear in the Web editor's **Current session** capabilities panel and are exposed in the capability runtime state.

## Read-only architecture

Cache usage metrics are computed on demand from provider-reported usage that Pi has already persisted in messages along the active branch:

- **Zero side effects:** Forge never initiates model inference, appends session entries, edits prompt text, inserts `cache_control` breakpoints, or triggers prompt warming for usage tracking.
- **Reused polling:** The Web client receives cache metrics through its existing visibility-based polling (`GET /api/capability-state`); no extra network requests or timers are introduced.
- **Root-to-leaf branch traversal:** Metrics reflect the active branch from root to leaf.
  - **Main session requests:** Counted from `assistant` messages carrying non-zero persisted usage (`input + output + cacheRead + cacheWrite > 0`). Requests with zero reported usage (such as aborted turns or failed calls without provider usage) are excluded.
  - **Latest reported request:** The latest assistant message with non-zero usage; a later aborted or unreported request does not replace it.
  - **Current turn:** Aggregates assistant requests appearing after the latest `user` message on the branch. Tool loops within the turn aggregate together.
  - **Session scope:** Aggregates all qualifying requests on the active branch, including pre-compaction conversation history that remains on the branch.
- **Exclusions and persistence boundaries:**
  - Excludes standalone Pi `usage` events, compaction entries, and `branch_summary` records.
  - Pi can persist warming usage separately; these metrics intentionally count conversational requests, not warming or summarization overhead.
  - Not equivalent to Pi's overall session billing or total bill statistics.

## Hit rate formula and aggregation

### Hit rate formula

Prompt cache hit rate measures prompt prefix reuse:

```
cacheHitRate = cacheRead / (input + cacheRead + cacheWrite)
```

- `input`: normalized uncached prompt tokens, following the `pi-ai` `Usage` convention.
- `cacheRead`: prompt tokens served from the provider prompt cache.
- `cacheWrite`: prompt tokens written to provider prompt cache checkpoints.
- `output`: model completion tokens are strictly excluded from the prompt cache hit rate denominator.
- **Undefined denominator:** When total prompt tokens (`input + cacheRead + cacheWrite`) equal zero, the hit rate is undefined and displayed as an em dash (`—`).

### Aggregation semantics

- **Mixed models:** When multiple models run on the same branch or turn, rates are aggregated by summing raw token counts across requests (sum of cache reads / sum of prompt tokens), never as an arithmetic mean of percentages.
- **Provider reporting caveats:** Zero reported cache counts (`cacheRead: 0`, `cacheWrite: 0`) can indicate that the provider does not report cache metrics. They do not prove that prompt caching is unsupported or that no caching occurred.

## Main session vs. nested tool separation

Usage is tracked in two distinct streams:
1. **Main (`main`):** Direct assistant turns initiated by the primary session model.
2. **Nested (`nested`):** Usage reported by tools that execute model requests internally (such as subagents). Nested usage is never merged into `main`.

In the Web UI:
- Main session and nested tools are displayed in separate visible rows (**Cache hit** and **Nested tools**).
- Tooltips display combined totals for **known** data only, with a permanent note that absent, invalid, or cache-unknown reports are excluded. The combined value is not a complete bill.

## Experimental nested-usage contract (`toolResult.details.forgeNestedUsage`)

Tools that make inner model calls can report aggregate token and cache metrics by attaching an object to `toolResult.details.forgeNestedUsage` (`FORGE_NESTED_USAGE_KEY`).

### Typed import

```ts
import {
  FORGE_NESTED_USAGE_KEY,
  parseForgeNestedUsage,
  type ForgeNestedUsage,
} from "@zihanw/pi-forge/subagent";
```

### JSON payload example

```json
{
  "role": "toolResult",
  "toolCallId": "call_subagent_abc123",
  "content": [{ "type": "text", "text": "Subagent task completed." }],
  "details": {
    "forgeNestedUsage": {
      "schemaVersion": 1,
      "requests": 2,
      "input": 1500,
      "output": 420,
      "cacheRead": 3200,
      "cacheWrite": 0
    }
  }
}
```

### Contract specification

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | `1` | Yes | Contract version. Must be literal `1`. |
| `requests` | `number` | Yes | Non-negative safe integer. Total model requests executed during the tool invocation. `0` is allowed **only** when all supplied token counts are zero. |
| `input` | `number` | Yes | Non-negative safe integer. Normalized uncached input tokens. |
| `output` | `number` | Yes | Non-negative safe integer. Generated completion tokens. |
| `cacheRead` | `number` | Optional | Non-negative safe integer. Prompt tokens read from cache. Must be paired with `cacheWrite`. |
| `cacheWrite` | `number` | Optional | Non-negative safe integer. Prompt tokens written to cache. Must be paired with `cacheRead`. |

- **Strict schema:** No extra keys are permitted.
- **Cache pair rule:** `cacheRead` and `cacheWrite` must either both be present or both omitted. Omit both when the producer cannot provide cache numbers.
- **Invocation aggregation:** A final tool result must supply exactly **one** aggregate per tool invocation covering all its internal model requests. Intermediate progress snapshots or repeated lifetime totals across calls are prohibited.
- **Rollup ownership:** The tool producer owns deduplication and recursive rollup across child agents. Nested totals must not include main session tokens.
- **Ingestion and error handling:**
  - **Unknown cache metrics:** Valid records omitting `cacheRead`/`cacheWrite` are excluded from all request and token totals; the call is counted in `cacheUnknownCalls` (`N calls reported no cache data`).
  - **Malformed records:** Payloads failing schema validation are ignored; the call is counted in `invalidCalls` (`N malformed reports ignored`).
  - **Absent key:** When `forgeNestedUsage` is absent, the tool call is treated as having no nested usage. Forge does not mine legacy output or parse logs.

### Attribution and Pi integration boundary

- **Forge attribution only:** `toolResult.details.forgeNestedUsage` is used solely for Forge UI attribution and cache tracking. It does **not** modify Pi's built-in session totals.
- **No duplicate counting:** Pi supports `toolResult.usage` natively. A future producer can emit the same underlying usage to `toolResult.usage` for Pi's session totals and to `toolResult.details.forgeNestedUsage` for Forge's cache display. Forge does not re-add top-level `toolResult.usage`, preventing duplication.
- **Ecosystem status:** Runtime and subagent producer integration is deferred. Existing subagent calls without this field display no data; no historical backfill is performed.
