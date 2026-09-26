import type { CapabilityEvent } from "./capability-events.ts";

export const CAPABILITY_EVENT_ENTRY = "pi-forge-capability-event";
export const CAPABILITY_TOOLS_ENTRY = "pi-forge-capability-tools";
export const CAPABILITY_DELIVERY_TYPE = "pi-forge-capability-delivery";

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

export function isCapabilityDelivery(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const value = message as { role?: unknown; customType?: unknown };
	return value.role === "custom" && value.customType === CAPABILITY_DELIVERY_TYPE;
}

/** Structural history is not ordinary dialogue for role, regex or budget filters. */
export function isCapabilityControlMessage(message: unknown): boolean {
	return !!message && typeof message === "object"
		&& ((message as { role?: unknown }).role === "system" || isCapabilityDelivery(message));
}
