import { type ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type AgentExecutionPlan, type BackendPreflightResult, type SubagentBackendDescriptor, type SubagentPreparationResult } from "./contract.ts";
import type { SubagentBackend, SubagentBackendCancelInput, SubagentBackendExecutionContext, SubagentBackendExecutionResult, SubagentBackendPreparationContext, SubagentBackendPreflightInput } from "./backend-registry.ts";
export declare const PI_SDK_ISOLATED_BACKEND_ID = "pi-sdk-isolated";
export declare const PI_SDK_ISOLATED_BACKEND_DESCRIPTOR: SubagentBackendDescriptor;
export interface PiSdkIsolatedBackendOptions {
    modelRegistry: ModelRegistry;
    modelRuntime?: ModelRuntime;
    now?: () => Date;
    idFactory?: () => string;
}
export declare class PiSdkIsolatedBackend implements SubagentBackend {
    #private;
    readonly descriptor: SubagentBackendDescriptor;
    constructor(options: PiSdkIsolatedBackendOptions);
    preflight(input: SubagentBackendPreflightInput): BackendPreflightResult;
    prepare(input: Parameters<NonNullable<SubagentBackend["prepare"]>>[0], context: SubagentBackendPreparationContext): Promise<SubagentPreparationResult>;
    execute(plan: AgentExecutionPlan, context: SubagentBackendExecutionContext): Promise<SubagentBackendExecutionResult>;
    cancel(input: SubagentBackendCancelInput): Promise<void>;
    discard(preflightId: string): Promise<boolean>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=pi-sdk-backend.d.ts.map