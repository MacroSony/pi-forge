import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompileMessageSource } from "./types.ts";
import type { WebEditorPreviewPart, WebEditorPreviewSection } from "./web-editor/types.ts";
export interface RawPreviewPart {
    kind: WebEditorPreviewPart["kind"];
    text: string;
    toolName?: string;
    callId?: string;
}
export interface InspectionToolResultMeta {
    callId?: string;
    toolName?: string;
    isError?: boolean;
}
/**
 * Tracks occurrence counts per preview compile to disambiguate identical content
 * or duplicate message identities within the same rendered preview.
 *
 * When duplicate fingerprints are detected, ALL occurrences sharing that fingerprint
 * (including the first occurrence) are marked as temporary (:temp:N), and all of their
 * part keys are retroactively updated as well.
 */
export declare class InspectionOccurrenceTracker {
    private readonly entriesByBaseKey;
    register(baseKey: string, inspection: NonNullable<WebEditorPreviewSection["inspection"]>): void;
}
export declare function createInspectionTracker(): InspectionOccurrenceTracker;
/**
 * Determines whether an inspection key is a temporary/duplicate key.
 * When identical fingerprints repeat, all occurrences (including the first) are marked
 * with a temporary key (:temp:N) and do not claim cross-insertion stability.
 */
export declare function isTemporaryInspectionKey(key: string): boolean;
/**
 * Resolve the inspection scope according to CompileMessageSource history slot instances,
 * stack item identities, or implicit conversation history.
 * Scoping ensures repeating history slots do not cross-pair.
 */
export declare function resolveInspectionScope(source: CompileMessageSource | undefined, role?: string, isForgeUpdate?: boolean): string;
/**
 * Format structured tool call arguments into clean display JSON.
 * Preserves structured values without claiming wire raw text, and never
 * substitutes null or missing values with `{}`.
 */
export declare function formatToolCallArguments(args: unknown): string;
/**
 * Extract raw ordered parts from a compiled AgentMessage.
 * Does not guess from title or preview text; inspects the actual message content structure.
 */
export declare function extractRawParts(message: AgentMessage | undefined): RawPreviewPart[];
/**
 * Extract toolResult metadata strictly from a standard SDK toolResult message.
 * Must be msg.role === 'toolResult' and strictly extract toolCallId from msg.toolCallId.
 * Does not guess from unknown roles or other fields. Unknown roles remain neutral.
 */
export declare function extractToolResult(message: unknown): InspectionToolResultMeta | undefined;
/**
 * Compute stable content fingerprint from scope, role, full display parts, and toolResult.
 * Ensures argument or tool changes alter the hash even if legacy content strings match.
 * Distinguishes missing isError from false and true (does not default to false).
 */
export declare function computeInspectionFingerprint(scope: string, role: string, parts: readonly RawPreviewPart[], toolResult?: InspectionToolResultMeta, systemMetadata?: unknown): string;
/**
 * Build the complete inspection sidecar for a section from its compiled AgentMessage.
 * Relies strictly on scope + display structure hash rather than heuristics on message fields.
 */
export declare function buildSectionInspection(message: AgentMessage | undefined, scope: string, tracker: InspectionOccurrenceTracker): NonNullable<WebEditorPreviewSection["inspection"]>;
//# sourceMappingURL=preview-inspection.d.ts.map