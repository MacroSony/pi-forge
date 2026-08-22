/** Presentation-only line diff used by the web editor's git-style diff view. */
export type LineDiffKind = "same" | "added" | "removed" | "note";
export interface LineDiffPart {
    text: string;
    changed: boolean;
}
export interface LineDiffRow {
    kind: LineDiffKind;
    text: string;
    beforeLine?: number;
    afterLine?: number;
    parts: LineDiffPart[];
    noteSide?: "before" | "after";
}
export interface LineDiffSeparator {
    kind: "separator";
}
export type LineDiffDisplayRow = LineDiffRow | LineDiffSeparator;
export interface SplitLineDiffRow {
    kind: "line" | "separator";
    before?: LineDiffRow;
    after?: LineDiffRow;
}
export declare function diffTextLines(beforeText: string, afterText: string): LineDiffRow[];
/** `contextLines = 0` means changed lines only; `null` means the complete file. */
export declare function filterLineRows(rows: readonly LineDiffRow[], contextLines: number | null): LineDiffDisplayRow[];
export declare function buildSplitLineRows(rows: readonly LineDiffDisplayRow[]): SplitLineDiffRow[];
//# sourceMappingURL=line-diff.d.ts.map