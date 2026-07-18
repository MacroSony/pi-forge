import type { AgentProfile } from "../agent-profile.ts";
import type { PromptStack } from "../types.ts";
import { type AgentExecutionPlan, type SubagentFingerprint, type SubagentPreparationRuntime } from "./types.ts";
export declare function canonicalSubagentJson(value: unknown): string;
export declare function subagentFingerprint(value: unknown): SubagentFingerprint;
export declare function subagentSourceProfileFingerprint(profile: AgentProfile): SubagentFingerprint;
export declare function subagentPromptStackFingerprint(stack: PromptStack): SubagentFingerprint;
export declare function subagentPromptRuntimeFingerprint(runtime: Omit<SubagentPreparationRuntime, "promptRuntimeFingerprint"> | SubagentPreparationRuntime): SubagentFingerprint;
export declare function subagentExecutionFingerprint(plan: Omit<AgentExecutionPlan, "executionFingerprint"> | AgentExecutionPlan): SubagentFingerprint;
//# sourceMappingURL=canonical.d.ts.map