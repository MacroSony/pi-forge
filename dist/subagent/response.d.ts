import { type AgentExecutionPlan, type AgentRequest, type SubagentDiagnostic } from "./types.ts";
export declare function validateAgentResponse(response: unknown, context?: {
    request?: AgentRequest;
    plan?: AgentExecutionPlan;
}): SubagentDiagnostic[];
export declare function validateSubagentArtifactReference(value: unknown, path?: string): SubagentDiagnostic[];
export declare function validateSubagentTraceReference(value: unknown, path?: string): SubagentDiagnostic[];
//# sourceMappingURL=response.d.ts.map