import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type CapabilityHistory } from "./capability-protocol.ts";
/** Rebuild only Pi's owned base; foreign named sections/prose remain separate. */
export declare function getPiBasePrompt(messages: AgentMessage[], fallback: string): string;
/**
 * Pure capability projection bridge. Replaces delivery markers with native
 * SystemMessage or fallback UserMessage updates based on event prefixes.
 */
export declare function projectCapabilityMessages(messages: AgentMessage[], history: CapabilityHistory, native: boolean, onUpdate?: (message: AgentMessage, update: {
    activationIds: string[];
    kind: "anchor" | "pending" | "checkpoint";
    throughEventId: string;
}) => void): {
    messages: AgentMessage[];
    throughEventId?: string;
};
/**
 * Projects a preset-compiled system prompt into messages. Strips Pi builtin base
 * sections, sets the leading System content, preserves foreign sections and tools.
 */
export declare function projectPresetSystemPrompt(messages: AgentMessage[], compiled: string): AgentMessage[];
//# sourceMappingURL=capability-projection.d.ts.map