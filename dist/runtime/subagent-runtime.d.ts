import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiForgeRuntimeState } from "../runtime-state.ts";
import { type AgentExecutionPlan, type AgentRequest, type AgentResponse, type BackendPreflightResult, type SubagentBackendDescriptor, type SubagentDiagnostic } from "../subagent/contract.ts";
export interface ForgeSubagentPreparedRun {
    request: AgentRequest;
    preflight: Extract<BackendPreflightResult, {
        status: "accepted";
    }>;
    plan: AgentExecutionPlan;
    diagnostics: SubagentDiagnostic[];
}
export type ForgeSubagentPreparationResult = {
    ok: true;
    prepared: ForgeSubagentPreparedRun;
} | {
    ok: false;
    diagnostics: SubagentDiagnostic[];
};
export interface ForgeSubagentRuntime {
    descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[];
    prepare(profileId: string, task: string, ctx: ExtensionContext): Promise<ForgeSubagentPreparationResult>;
    discard(prepared: ForgeSubagentPreparedRun): Promise<void>;
    execute(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal): Promise<AgentResponse>;
    dispose(): Promise<void>;
}
export declare function createForgeSubagentRuntime(state: PiForgeRuntimeState): ForgeSubagentRuntime;
//# sourceMappingURL=subagent-runtime.d.ts.map