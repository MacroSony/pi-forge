import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PromptRegexStage, PromptRegexTarget, PromptStack, PromptStackDiagnostic } from "./types.ts";
export declare function validateRegexConfig(config: unknown): PromptStackDiagnostic[];
export declare function applyRegexRulesToString(stack: PromptStack, text: string, stage: PromptRegexStage, target: PromptRegexTarget, diagnostics: PromptStackDiagnostic[]): string;
export declare function applyRegexRulesToMessages(stack: PromptStack, messages: AgentMessage[], stage: PromptRegexStage, diagnostics: PromptStackDiagnostic[]): AgentMessage[];
/** True when the stack has outgoing message rules that opt into every-request application. */
export declare function hasRequestFrequencyRules(stack: PromptStack): boolean;
/**
 * Apply outgoing rules with `frequency: "request"` to Pi's natural context on
 * a tool-result follow-up request. On follow-ups there is no stack layout
 * rewrite, so both stages collapse onto the transcript: history-stage rules
 * and compiled-stage rules targeting messages all apply to the full natural
 * context. History-stage rules run first, mirroring compile order. Each
 * provider request is rebuilt from the transcript, so re-application is
 * wire-consistent and never doubled.
 */
export declare function applyRequestFrequencyRulesToMessages(stack: PromptStack, messages: AgentMessage[], diagnostics: PromptStackDiagnostic[]): AgentMessage[];
export declare function applyFinalizeRegexRulesToMessage(stack: PromptStack, message: AgentMessage, diagnostics: PromptStackDiagnostic[]): AgentMessage | undefined;
//# sourceMappingURL=regex.d.ts.map