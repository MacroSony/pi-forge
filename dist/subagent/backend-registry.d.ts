import { type AgentExecutionPlan, type AgentProfileSnapshot, type AgentRequest, type AgentResponse, type BackendPreflightResult, type SubagentBackendDescriptor, type SubagentHostPlanPreparer, type SubagentPreparationBaseInput, type SubagentPreparationResult, type SubagentPreparationRuntime, type SubagentTraceReference } from "./contract.ts";
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
    prepare(runtime: SubagentPreparationRuntime): Promise<SubagentPreparationResult>;
}
export interface SubagentBackendExecutionContext {
    signal: AbortSignal;
    onUpdate?: (update: SubagentBackendExecutionUpdate) => void;
}
export interface SubagentBackendExecutionUpdate {
    phase: "starting" | "message" | "tool-result" | "finishing";
    message: string;
    details?: unknown;
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
    prepare?(input: SubagentPreparationBaseInput, context: SubagentBackendPreparationContext): Promise<SubagentPreparationResult> | SubagentPreparationResult;
    execute(plan: AgentExecutionPlan, context: SubagentBackendExecutionContext): Promise<SubagentBackendExecutionResult> | SubagentBackendExecutionResult;
    discard?(preflightId: string): Promise<boolean> | boolean;
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
    onUpdate?: (update: SubagentBackendExecutionUpdate) => void;
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
    forgetPreflight(preflightId: string): boolean;
    discard(preflightId: string): Promise<boolean>;
    preflight(backendId: string, request: AgentRequest, snapshot: AgentProfileSnapshot, signal?: AbortSignal): Promise<BackendPreflightResult>;
    prepare(backendId: string, input: SubagentPreparationBaseInput, hostPreparer: SubagentHostPlanPreparer, signal?: AbortSignal): Promise<SubagentPreparationResult>;
    execute(plan: AgentExecutionPlan, options: SubagentExecutionOptions): Promise<AgentResponse>;
    cancel(runId: string, reason?: string): Promise<boolean>;
    inspectTrace(reference: SubagentTraceReference, authorizationScope: string, signal?: AbortSignal): Promise<unknown>;
    forgetTrace(handle: string): boolean;
}
export {};
//# sourceMappingURL=backend-registry.d.ts.map