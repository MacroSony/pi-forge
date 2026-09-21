import type { InstructionEvent } from "./instruction-events.ts";

export const INSTRUCTION_EVENT_ENTRY = "pi-forge-instruction-event";
export const INSTRUCTION_TOOLS_ENTRY = "pi-forge-instruction-tools";
export const INSTRUCTION_DELIVERY_TYPE = "pi-forge-instruction-delivery";

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

export function isInstructionDelivery(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const value = message as { role?: unknown; customType?: unknown };
	return value.role === "custom" && value.customType === INSTRUCTION_DELIVERY_TYPE;
}

/** Structural history is not ordinary dialogue for role, regex or budget filters. */
export function isInstructionControlMessage(message: unknown): boolean {
	return !!message && typeof message === "object"
		&& ((message as { role?: unknown }).role === "system" || isInstructionDelivery(message));
}
