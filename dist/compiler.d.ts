import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompileMessagesResult, CompileSystemPromptResult, PromptRuntime, PromptStack, PromptStackDiagnostic } from "./types.ts";
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
/**
 * Merge diagnostic lists, dropping exact duplicates. compileSystemPrompt and
 * compileMessages each emit stack-level diagnostics for the same stack, so
 * callers combining their results would otherwise show every issue twice.
 */
export declare function dedupeDiagnostics(lists: readonly (readonly PromptStackDiagnostic[])[]): PromptStackDiagnostic[];
//# sourceMappingURL=compiler.d.ts.map