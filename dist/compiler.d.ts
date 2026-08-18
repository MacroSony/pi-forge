import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompileMessagesResult, CompileSystemPromptResult, PromptRuntime, PromptStack } from "./types.ts";
export declare function compileSystemPrompt(stack: PromptStack, runtime: PromptRuntime, baseSystemPrompt: string): CompileSystemPromptResult;
export declare function compileMessages(stack: PromptStack, runtime: PromptRuntime, originalMessages: AgentMessage[]): CompileMessagesResult;
export declare function getLatestUserMessage(messages: AgentMessage[]): string | undefined;
export declare function agentMessageToPreviewText(message: AgentMessage): string;
//# sourceMappingURL=compiler.d.ts.map