import { type AgentProfileSnapshot, type AgentRequest, type BackendPreflightAccepted, type SubagentDiagnostic } from "./types.ts";
export declare function validateBackendPreflight(value: unknown, request?: AgentRequest, snapshot?: AgentProfileSnapshot): SubagentDiagnostic[];
export declare function validatePreflightAgainstRequest(preflight: BackendPreflightAccepted, request: AgentRequest): SubagentDiagnostic[];
//# sourceMappingURL=preflight.d.ts.map