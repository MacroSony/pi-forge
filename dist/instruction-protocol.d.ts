import type { InstructionEvent } from "./instruction-events.ts";
export declare const INSTRUCTION_EVENT_ENTRY = "pi-forge-instruction-event";
export declare const INSTRUCTION_TOOLS_ENTRY = "pi-forge-instruction-tools";
export declare const INSTRUCTION_DELIVERY_TYPE = "pi-forge-instruction-delivery";
/** Events are authoritative. A delivery marker contains only a branch-local cursor. */
export interface InstructionHistory {
    events: readonly InstructionEvent[];
    /** Last semantic event at/before the latest Pi compaction, if any. */
    checkpointThrough?: string;
}
/**
 * Persisted plain custom entry metadata for an instruction anchor.
 */
export interface InstructionAnchorData {
    readonly schemaVersion: 1;
    readonly throughEventId: string;
}
export declare function isInstructionDelivery(message: unknown): boolean;
/** Structural history is not ordinary dialogue for role, regex or budget filters. */
export declare function isInstructionControlMessage(message: unknown): boolean;
//# sourceMappingURL=instruction-protocol.d.ts.map