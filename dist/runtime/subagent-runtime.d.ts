import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PiSubprocessBackendOptions, type PiSubprocessRunReport } from "@zihanw/pi-subagent-runtime/backends/subprocess";
import { type PiRpcBackendOptions } from "@zihanw/pi-subagent-runtime/backends/rpc";
import type { PiForgeRuntimeState } from "../runtime-state.ts";
import { type AgentExecutionPlan, type AgentRequest, type AgentResponse, type BackendPreflightAccepted, type SubagentBackendDescriptor, type SubagentDiagnostic } from "../subagent/contract.ts";
export interface ForgeSubagentPreparedRun {
    request: AgentRequest;
    preflight: BackendPreflightAccepted;
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
/** Host-facing execution update; phases match the runtime's run events. */
export interface SubagentBackendExecutionUpdate {
    phase: "starting" | "message" | "tool-result" | "finishing";
    message: string;
    details?: unknown;
}
export interface ForgeSubagentRuntime {
    descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[];
    prepare(profileId: string, task: string, ctx: ExtensionContext): Promise<ForgeSubagentPreparationResult>;
    discard(prepared: ForgeSubagentPreparedRun): Promise<void>;
    execute(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse>;
    takeReport?(runId: string): PiSubprocessRunReport | undefined;
    dispose(): Promise<void>;
}
export interface ForgeSubagentRuntimeOptions {
    /** Backend that executes prepared runs; defaults to the subprocess backend. */
    backendId?: string;
    subprocess?: Omit<PiSubprocessBackendOptions, "modelRegistry" | "cwd">;
    rpc?: Omit<PiRpcBackendOptions, "modelRegistry" | "cwd">;
}
export declare function createForgeSubagentRuntime(state: PiForgeRuntimeState, options?: ForgeSubagentRuntimeOptions): ForgeSubagentRuntime;
//# sourceMappingURL=subagent-runtime.d.ts.map