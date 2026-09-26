import type { CapabilityEvent } from "./capability-events.ts";
export declare const CAPABILITY_EVENT_ENTRY = "pi-forge-capability-event";
export declare const CAPABILITY_TOOLS_ENTRY = "pi-forge-capability-tools";
export declare const CAPABILITY_DELIVERY_TYPE = "pi-forge-capability-delivery";
/** Events are authoritative. A delivery marker contains only a branch-local cursor. */
export interface CapabilityHistory {
    events: readonly CapabilityEvent[];
    /** Last semantic event at/before the latest Pi compaction, if any. */
    checkpointThrough?: string;
}
/**
 * Persisted plain custom entry metadata for a capability anchor.
 */
export interface CapabilityAnchorData {
    readonly schemaVersion: 1;
    readonly throughEventId: string;
}
export declare function isCapabilityDelivery(message: unknown): boolean;
/** Structural history is not ordinary dialogue for role, regex or budget filters. */
export declare function isCapabilityControlMessage(message: unknown): boolean;
//# sourceMappingURL=capability-protocol.d.ts.map