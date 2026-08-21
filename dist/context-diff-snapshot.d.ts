/**
 * Host-neutral snapshot extraction from captured provider payloads.
 *
 * This module stays free of Node/DOM/Vue APIs so the same extraction logic can
 * be reused by the web host and future non-web surfaces.
 */
import { type TurnSnapshot } from "./context-diff.ts";
export interface ContextDiffCapture {
    turnId?: string;
    capturedAt: string;
    stackId?: string;
    payload?: unknown;
    /** Secret-redacted, complete provider-request JSON used for diff identity. */
    serializedPayload?: string;
    text: string;
}
/** Convert a captured provider payload into an ordered TurnSnapshot of Blocks. */
export declare function extractTurnSnapshot(capture: ContextDiffCapture): TurnSnapshot;
//# sourceMappingURL=context-diff-snapshot.d.ts.map