import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CapabilityAnchorData } from "./capability-protocol.ts";
export type { CapabilityAnchorData };
/**
 * Validates the metadata payload of a plain capability delivery anchor entry.
 * Enforces strict schema constraints:
 * - Must be a non-null object with no extra fields.
 * - schemaVersion must be 1.
 * - throughEventId must be a non-empty string, length <= 128, containing no control characters.
 */
export declare function validateCapabilityAnchorData(data: unknown): CapabilityAnchorData;
/**
 * Checks if a session entry is a plain metadata anchor for capability delivery.
 */
export declare function isCapabilityAnchorEntry(entry: unknown): boolean;
/**
 * Creates an ephemeral in-memory custom control message for a plain metadata anchor entry.
 * Used during context projection and Preview manual context assembly.
 * Returns undefined if the entry is not a custom capability delivery anchor.
 * Throws if the entry is an anchor with invalid metadata.
 */
export declare function capabilityAnchorMessage(entry: unknown): AgentMessage | undefined;
export declare function capabilityContextMatches(expected: readonly AgentMessage[], incoming: readonly AgentMessage[]): boolean;
/**
 * Materializes plain metadata anchors into context messages at their exact ordinal positions.
 *
 * Rules:
 * - If no visible plain metadata anchor exists in context entries, returns the original messages array.
 * - If visible anchors exist, validates their metadata and checks the ordered protocol alignment before injection (see capabilityContextMatches).
 * - Preserves all original message object references from incoming messages.
 * - Never guesses by timestamps or text matching; fails closed if context was modified by preceding extensions.
 */
export declare function materializeCapabilityAnchors(entries: readonly unknown[], messages: AgentMessage[], leafId?: string | null): AgentMessage[];
/**
 * Checks whether the current turn has in-flight or unresolved tool calls.
 *
 * Turn scoping rule:
 * - Real user messages (`role: "user"`) define a new user turn and clear any
 *   historical orphan tool calls left by interrupted or crashed earlier turns.
 * - Custom peer messages (`role: "custom"`) do not establish a new user boundary
 *   and do not clear pending calls.
 * - Assistant tool calls add to the pending set; matching toolResult messages remove them.
 */
export declare function hasPendingCapabilityToolCalls(messages: readonly AgentMessage[]): boolean;
//# sourceMappingURL=capability-anchors.d.ts.map