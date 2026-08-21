/**
 * Host-neutral rolling context-diff history.
 *
 * Keeps the last N turn snapshots captured from provider payloads and exposes
 * the latest engine-computed diff plus compact summaries for recent turns.
 */
import { type TurnDiff, type TurnSnapshot } from "./context-diff.ts";
import { type ContextDiffCapture } from "./context-diff-snapshot.ts";
export declare const CONTEXT_DIFF_HISTORY_LIMIT = 20;
export interface ContextDiffHistory {
    turns: TurnSnapshot[];
    latestDiff?: TurnDiff;
    nextTurnNumber?: number;
}
export interface ContextDiffTurnSummary {
    turnId: string;
    capturedAt: string;
    stackId: string;
    approxTokens: number;
    blockCount: number;
    chars: number;
    deltaTokens?: number;
    prefixTokens?: number;
    prefixRatio?: number;
    changedBlocks?: number;
}
export interface ContextDiffView {
    turns: ContextDiffTurnSummary[];
    latest: {
        turn: TurnSnapshot;
        diff: TurnDiff;
    } | null;
    latestDiff: TurnDiff | null;
}
export declare function createContextDiffHistory(): ContextDiffHistory;
/** Append a captured payload, evict old turns past the limit, and compute the latest diff. */
export declare function appendContextDiffCapture(history: ContextDiffHistory, capture: ContextDiffCapture): TurnDiff | undefined;
/** Build the response-shaped view: compact summaries for recent turns + latest full diff. */
export declare function getContextDiffView(history: ContextDiffHistory): ContextDiffView;
//# sourceMappingURL=context-diff-history.d.ts.map