/**
 * Host-neutral context diff engine.
 *
 * Pure functions only: no DOM, no Vue, no Node APIs. Consecutive turn
 * snapshots are compared with a simple prefix-walk that models KV-cache
 * reuse without attempting a full Myers diff.
 */
export interface Block {
    key: string;
    role: string;
    text: string;
    chars: number;
    approxTokens: number;
    hash: string;
}
export interface TurnSnapshot {
    turnId: string;
    capturedAt: string;
    stackId: string;
    blocks: Block[];
}
export type DiffBlockStatus = "same" | "added" | "removed" | "modified";
export interface DiffBlock {
    status: DiffBlockStatus;
    before?: Block;
    after?: Block;
    tokenDelta: number;
}
export interface TurnDiffSummary {
    sameBlocks: number;
    addedBlocks: number;
    removedBlocks: number;
    modifiedBlocks: number;
    changedBlocks: number;
    /** Net tokens introduced by added or lengthened modified blocks. */
    addedTokens: number;
    /** Net tokens removed by removed or shortened modified blocks. */
    removedTokens: number;
    /** Net total token change (`addedTokens - removedTokens`). */
    netTokens: number;
}
export interface TurnDiff {
    blocks: DiffBlock[];
    prefixTokens: number;
    prefixRatio: number;
    deltaTokens: number;
    summary: TurnDiffSummary;
}
/** Estimate tokens from characters using the same chars/4 approximation as payload capture. */
export declare function estimateApproxTokens(text: string): number;
/** Pure string hash used as the block identity shortcut. */
export declare function hashText(text: string): string;
export declare function createBlock(key: string, role: string, text: string, serialized?: unknown): Block;
export declare function createTurnSnapshot(input: {
    turnId: string;
    capturedAt?: string;
    stackId?: string;
    blocks?: Block[];
}): TurnSnapshot;
export declare function turnApproxTokens(turn: TurnSnapshot): number;
/**
 * Diff two consecutive turn snapshots.
 *
 * The cache-boundary walk compares block arrays positionally while hashes
 * match. This preserves the serialized-prefix meaning even when a later
 * block is moved. Classification uses stable block keys after the boundary so
 * a middle insertion does not make every following block look modified.
 */
export declare function diffTurns(previous: TurnSnapshot | null | undefined, current: TurnSnapshot): TurnDiff;
//# sourceMappingURL=context-diff.d.ts.map