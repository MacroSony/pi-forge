import { type ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type AgentExecutionPlan, type BackendPreflightResult, type SubagentBackendDescriptor, type SubagentPreparationResult } from "./contract.ts";
import type { SubagentBackend, SubagentBackendCancelInput, SubagentBackendExecutionContext, SubagentBackendExecutionResult, SubagentBackendPreparationContext, SubagentBackendPreflightInput } from "./backend-registry.ts";
export declare const PI_SUBPROCESS_READONLY_BACKEND_ID = "pi-subprocess-readonly";
export declare const PI_FORGE_SUBPROCESS_INPUT_ENV = "PI_FORGE_SUBAGENT_BRIDGE_INPUT";
export declare const PI_SUBPROCESS_READONLY_BACKEND_DESCRIPTOR: SubagentBackendDescriptor;
export interface PiSubprocessUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
    turns: number;
}
export interface PiSubprocessRunReport {
    runId: string;
    executionFingerprint: string;
    status: "running" | "completed" | "failed" | "cancelled";
    startedAt: string;
    finishedAt?: string;
    exitCode?: number;
    signal?: NodeJS.Signals;
    model: {
        provider: string;
        id: string;
    };
    thinkingLevel: string;
    effectiveToolNames: string[];
    executionBoundary: "shared-user";
    workingDirectory: string;
    messages: unknown[];
    stderr: string;
    usage: PiSubprocessUsage;
    stopReason?: string;
    errorMessage?: string;
}
interface PiInvocation {
    command: string;
    args: string[];
}
export interface PiSubprocessBackendOptions {
    modelRegistry: ModelRegistry;
    modelRuntime?: ModelRuntime;
    cwd: string;
    now?: () => Date;
    idFactory?: () => string;
    invocationFactory?: (piArgs: string[]) => PiInvocation;
    bridgePath?: string;
}
export declare class PiSubprocessBackend implements SubagentBackend {
    #private;
    readonly descriptor: SubagentBackendDescriptor;
    constructor(options: PiSubprocessBackendOptions);
    preflight(input: SubagentBackendPreflightInput): BackendPreflightResult;
    prepare(input: Parameters<NonNullable<SubagentBackend["prepare"]>>[0], context: SubagentBackendPreparationContext): Promise<SubagentPreparationResult>;
    execute(plan: AgentExecutionPlan, context: SubagentBackendExecutionContext): Promise<SubagentBackendExecutionResult>;
    cancel(input: SubagentBackendCancelInput): Promise<void>;
    discard(preflightId: string): Promise<boolean>;
    takeReport(runId: string): PiSubprocessRunReport | undefined;
    dispose(): Promise<void>;
}
export declare function sanitizePiSubprocessRunReport(report: PiSubprocessRunReport): PiSubprocessRunReport;
export {};
//# sourceMappingURL=pi-subprocess-backend.d.ts.map