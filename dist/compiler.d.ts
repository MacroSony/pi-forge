import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompileMessagesResult, CompileSystemPromptResult, PromptRuntime, PromptStack } from "./types.ts";
export declare class PromptCompilationContext {
    private readonly stack;
    private readonly runtime;
    private readonly templateRenderer;
    constructor(stack: PromptStack, runtime: PromptRuntime);
    compileSystemPrompt(baseSystemPrompt: string): CompileSystemPromptResult;
    compileMessages(originalMessages: AgentMessage[]): CompileMessagesResult;
    setLatestUserMessage(message: string): void;
}
export declare function compileSystemPrompt(stack: PromptStack, runtime: PromptRuntime, baseSystemPrompt: string): CompileSystemPromptResult;
export declare function compileMessages(stack: PromptStack, runtime: PromptRuntime, originalMessages: AgentMessage[]): CompileMessagesResult;
export declare function getLatestUserMessage(messages: AgentMessage[]): string | undefined;
export declare function agentMessageToPreviewText(message: AgentMessage): string;
//# sourceMappingURL=compiler.d.ts.map