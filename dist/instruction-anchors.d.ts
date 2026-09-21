import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type InstructionAnchorData } from "./instruction-protocol.ts";
export type { InstructionAnchorData };
/**
 * Validates the metadata payload of a plain instruction delivery anchor entry.
 * Enforces strict schema constraints:
 * - Must be a non-null object with no extra fields.
 * - schemaVersion must be 1.
 * - throughEventId must be a non-empty string, length <= 128, containing no control characters.
 */
export declare function validateInstructionAnchorData(data: unknown): InstructionAnchorData;
/**
 * Checks if a session entry is a plain metadata anchor for instruction delivery.
 */
export declare function isInstructionAnchorEntry(entry: unknown): boolean;
/**
 * Creates an ephemeral in-memory custom control message for a plain metadata anchor entry.
 * Used during context projection and Preview manual context assembly.
 * Returns undefined if the entry is not a custom instruction delivery anchor.
 * Throws if the entry is an anchor with invalid metadata.
 */
export declare function instructionAnchorMessage(entry: unknown): AgentMessage | undefined;
/**
 * Materializes plain metadata anchors into context messages at their exact ordinal positions.
 *
 * Rules:
 * - If no visible plain metadata anchor exists in context entries, returns the original messages array.
 * - If visible anchors exist, validates their metadata and strictly checks that incoming messages
 *   deeply equal the session context entries' projected messages before injecting markers.
 * - Preserves all original message object references from incoming messages.
 * - Never guesses by timestamps or text matching; fails closed if context was modified by preceding extensions.
 */
export declare function materializeInstructionAnchors(entries: readonly unknown[], messages: AgentMessage[]): AgentMessage[];
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
export declare function hasPendingInstructionToolCalls(messages: readonly AgentMessage[]): boolean;
//# sourceMappingURL=instruction-anchors.d.ts.map