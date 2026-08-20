# Context Diff — design plan (post-0.5.0)

Status: planned. Target release: 0.5.1 (first feature release after 0.5.0).
Owner of truth: this document; discussion record lives in the 0.5.x review thread.

## Goal

Per-turn observability for prompt changes so users can optimize KV-cache reuse:

- Mark which blocks of the prompt changed after each turn.
- Show how many tokens were added/removed/modified (delta vs the previous turn).
- Mark where the KV-cache prefix survives ("cache boundary").

Secondary goal: merge with live preview — while editing a stack, debounce-compile and diff against the previous compile, so edits show their prompt/token impact immediately.

## Existing building blocks

- `src/payload-capture.ts` — captures the real provider request payload (secret-redacted), with `approxTokens` (chars/4) estimation. `SAFE_TOKEN_METADATA_KEYS` already whitelists `cached_tokens` etc., so real cache-hit numbers can be surfaced if response usage ever becomes available.
- `src/preview.ts` — edit-time compile output split into sections (system + per-message), each with chars/approxTokens.
- Legacy editor already polls payload state every 2s.

## Two data sources

| Scenario | Source | Question answered |
|---|---|---|
| Edit time (live preview merge point) | debounced compile vs previous compile | "what does this edit change, how many tokens" |
| Run time (KV-cache truth) | diff of consecutive real payloads | "where did the cache break, how many extra tokens this turn" |

## Core engine: `src/context-diff.ts` (host-neutral pure functions)

```
TurnSnapshot  { turnId, capturedAt, stackId, blocks: Block[] }
Block         { key, role, text, chars, approxTokens, hash }
TurnDiff      { blocks: DiffBlock[], prefixTokens, prefixRatio, deltaTokens, summary }
DiffBlock     { status: same|added|removed|modified, before?, after?, tokenDelta }
```

Cache-boundary algorithm: KV-cache hits depend on the longest common prefix of the serialized request. Walk the block arrays in order while hashes match; at the first mismatch, trim a char-level common prefix inside that block and convert to tokens. Render a boundary marker: "cache valid up to ~18,204 tokens (63% of prompt)". No Myers diff needed — prefix + block classification suffices.

Honesty note: tokens are chars/4 estimates. Relative deltas are accurate; absolute boundary claims must be labeled "approx" in UI and in promo material.

## UI

Promote the Preview modal into a dockable right-side panel with two tabs:

- **Compiled** — current preview content, auto-refresh with 500ms debounce while editing (this is the live preview).
- **Diff** — top summary strip (`Turn N · +412 tokens vs previous · cache boundary ~63% · 2 blocks changed`), block list with green/red/yellow gutters and per-block token chips, scissor-line boundary marker.

Run-time mode: payload poll captures a new payload → store in rolling history (last 20 turns) → auto-compute diff.
Edit mode: diff current edited compile vs the active on-disk version.

Implementation constraint: write the panel as a self-contained Vue component bridged in via the vue-host mechanism. Do NOT add more imperative code to `legacy-editor.ts`. Do NOT refactor the legacy editor in the same lane.

## Phases / estimate

| Phase | Content | Effort |
|---|---|---|
| 0 | Design freeze + golden fixtures (turn payload sets) | 0.5d |
| 1 | `context-diff.ts` engine + unit tests (prefix/add/remove/modify/token rollups) | 1d |
| 2 | Server endpoint + rolling snapshot state on the web host | 0.5d |
| 3 | Web UI: preview dock + Diff view (self-contained Vue, bridged) | 1.5d |
| 4 | Browser tests + docs + changelog | 0.5–1d |

Total ~4–5 working days; ~1 calendar week with review. Descope option (~3d): run-time diff only, live preview reduced to plain auto-refresh without edit-time diffing.

## Release narrative

Do not fold into 0.5.0 — 0.5.0 ships as the architecture-split release; context diff headlines 0.5.1 as "observability". The promo video leads with this feature (money shot: edit one system-prompt line, watch the cache-boundary marker jump to the top).

## Promo video pipeline (reference: AIGC/VIDEO_PRODUCTION ep02)

Reuse the ep02 pipeline: `PLAN.md` → script draft → `narration.json` (production source of truth) → roughcut → review. Terminology follows the ep02 rule: say it in plain words first, name the formal term once ("KV cache" on first mention, then "prefix cache / cache reuse region").
