import { type AgentExecutionPlan, type AgentProfileSnapshot, type AgentRequest, type BackendPreflightAccepted, type SubagentDiagnostic, type SubagentFingerprint, type SubagentPreparationOutput, type SubagentPreparationRuntime } from "./types.ts";
export declare function createAgentExecutionPlan(input: {
    runId: string;
    request: AgentRequest;
    snapshot: AgentProfileSnapshot;
    preflight: BackendPreflightAccepted;
    preparation: SubagentPreparationOutput;
    runtime: SubagentPreparationRuntime;
    /** Runtime-issued fingerprint of the sealed conversation. */
    conversationFingerprint: SubagentFingerprint;
    /** Runtime-issued fingerprint binding the sealed conversation to the backend execution. */
    executionFingerprint: SubagentFingerprint;
}): {
    plan?: AgentExecutionPlan;
    diagnostics: SubagentDiagnostic[];
};
export declare function validateAgentExecutionPlan(plan: unknown, request?: AgentRequest): SubagentDiagnostic[];
//# sourceMappingURL=plan.d.ts.map