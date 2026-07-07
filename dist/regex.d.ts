import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PromptRegexStage, PromptRegexTarget, PromptStack, PromptStackDiagnostic } from "./types.ts";
export declare function validateRegexConfig(config: unknown): PromptStackDiagnostic[];
export declare function applyRegexRulesToString(stack: PromptStack, text: string, stage: PromptRegexStage, target: PromptRegexTarget, diagnostics: PromptStackDiagnostic[]): string;
export declare function applyRegexRulesToMessages(stack: PromptStack, messages: AgentMessage[], stage: PromptRegexStage, diagnostics: PromptStackDiagnostic[]): AgentMessage[];
export declare function applyFinalizeRegexRulesToMessage(stack: PromptStack, message: AgentMessage, diagnostics: PromptStackDiagnostic[]): AgentMessage | undefined;
//# sourceMappingURL=regex.d.ts.map