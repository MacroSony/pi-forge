import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type InstructionHistory } from "./instruction-protocol.ts";
/** Rebuild only Pi's owned base; foreign named sections/prose remain separate. */
export declare function getPiBasePrompt(messages: AgentMessage[], fallback: string): string;
/**
 * Pure instruction projection bridge. Replaces delivery markers with native
 * SystemMessage or fallback UserMessage updates based on event prefixes.
 */
export declare function projectInstructionMessages(messages: AgentMessage[], history: InstructionHistory, native: boolean): {
    messages: AgentMessage[];
    throughEventId?: string;
};
/**
 * Projects a preset-compiled system prompt into messages. Strips Pi builtin base
 * sections, sets the leading System content, preserves foreign sections and tools.
 */
export declare function projectPresetSystemPrompt(messages: AgentMessage[], compiled: string): AgentMessage[];
//# sourceMappingURL=instruction-projection.d.ts.map