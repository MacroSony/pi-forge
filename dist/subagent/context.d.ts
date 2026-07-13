import type { AgentRequest, SubagentContextBudgetResult, SubagentContextItem, SubagentInitialMessagesResult, SubagentPreparedMessage, SubagentSelectedContext, SubagentTaskInput } from "./types.ts";
export declare function budgetSubagentContext(context: SubagentSelectedContext): SubagentContextBudgetResult;
export declare function renderSubagentSelectedContext(items: readonly SubagentContextItem[]): string;
export declare function createProtectedSubagentTask(input: SubagentTaskInput): SubagentPreparedMessage;
export declare function prepareSubagentInitialMessages(request: AgentRequest, promptStackMessages?: readonly SubagentPreparedMessage[]): SubagentInitialMessagesResult;
export declare function appendProtectedSubagentTask(messages: readonly SubagentPreparedMessage[], input: SubagentTaskInput): SubagentPreparedMessage[];
export declare function isProtectedSubagentTaskPreserved(messages: readonly SubagentPreparedMessage[], input: SubagentTaskInput): boolean;
//# sourceMappingURL=context.d.ts.map