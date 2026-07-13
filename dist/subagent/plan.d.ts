import { type AgentExecutionPlan, type AgentProfileSnapshot, type AgentRequest, type BackendPreflightAccepted, type SubagentDiagnostic, type SubagentPreparationOutput, type SubagentPreparationRuntime } from "./types.ts";
export declare function createAgentExecutionPlan(input: {
    runId: string;
    request: AgentRequest;
    snapshot: AgentProfileSnapshot;
    preflight: BackendPreflightAccepted;
    preparation: SubagentPreparationOutput;
    runtime: SubagentPreparationRuntime;
}): {
    plan?: AgentExecutionPlan;
    diagnostics: SubagentDiagnostic[];
};
export declare function validateAgentExecutionPlan(plan: unknown, request?: AgentRequest): SubagentDiagnostic[];
//# sourceMappingURL=plan.d.ts.map