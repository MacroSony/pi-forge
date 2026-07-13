import { type AgentExecutionPlan, type AgentProfileSnapshot, type AgentRequest, type AgentResponse, type BackendPreflightResult, type SubagentBackendDescriptor, type SubagentHostPlanPreparer, type SubagentPreparationInput, type SubagentPreparationOutput, type SubagentTraceReference } from "./contract.ts";
type WithoutTrace<T> = T extends AgentResponse ? Omit<T, "trace"> : never;
export interface SubagentBackendTraceResult {
    id: string;
    expiresAt?: string;
}
export type SubagentBackendExecutionResult = WithoutTrace<AgentResponse> & {
    trace?: SubagentBackendTraceResult;
};
export interface SubagentBackendPreflightInput {
    request: AgentRequest;
    snapshot: AgentProfileSnapshot;
    signal?: AbortSignal;
}
export interface SubagentBackendPreparationContext {
    signal?: AbortSignal;
    prepare: SubagentHostPlanPreparer;
}
export interface SubagentBackendExecutionContext {
    signal: AbortSignal;
}
export interface SubagentBackendCancelInput {
    runId: string;
    reason: string;
}
export interface SubagentBackendTraceInput {
    traceId: string;
    signal?: AbortSignal;
}
export interface SubagentBackend {
    readonly descriptor: SubagentBackendDescriptor;
    preflight(input: SubagentBackendPreflightInput): Promise<BackendPreflightResult> | BackendPreflightResult;
    prepare?(input: SubagentPreparationInput, context: SubagentBackendPreparationContext): Promise<SubagentPreparationOutput> | SubagentPreparationOutput;
    execute(plan: AgentExecutionPlan, context: SubagentBackendExecutionContext): Promise<SubagentBackendExecutionResult> | SubagentBackendExecutionResult;
    cancel?(input: SubagentBackendCancelInput): Promise<void> | void;
    inspectTrace?(input: SubagentBackendTraceInput): Promise<unknown> | unknown;
}
export interface SubagentBackendRegistryOptions {
    idFactory?: (kind: "preflight" | "trace") => string;
    now?: () => number;
}
export interface SubagentExecutionOptions {
    authorizationScope: string;
    signal?: AbortSignal;
}
export declare class SubagentBackendRegistryError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class SubagentBackendRegistry {
    #private;
    constructor(options?: SubagentBackendRegistryOptions);
    get size(): number;
    register(backend: SubagentBackend): () => boolean;
    unregister(backendId: string): boolean;
    descriptors(): SubagentBackendDescriptor[];
    preflight(backendId: string, request: AgentRequest, snapshot: AgentProfileSnapshot, signal?: AbortSignal): Promise<BackendPreflightResult>;
    prepare(backendId: string, input: SubagentPreparationInput, hostPreparer: SubagentHostPlanPreparer, signal?: AbortSignal): Promise<SubagentPreparationOutput>;
    execute(plan: AgentExecutionPlan, options: SubagentExecutionOptions): Promise<AgentResponse>;
    cancel(runId: string, reason?: string): Promise<boolean>;
    inspectTrace(reference: SubagentTraceReference, authorizationScope: string, signal?: AbortSignal): Promise<unknown>;
    forgetTrace(handle: string): boolean;
}
export {};
//# sourceMappingURL=backend-registry.d.ts.map