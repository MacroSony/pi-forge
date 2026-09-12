import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { PromptCompilationContext } from "./compiler.ts";
import type { PromptRuntimeSnapshot, PromptStackDiagnostic } from "./types.ts";
/**
 * Per-request compilation state. This is intentionally separate from
 * ForgeWorkspace's long-lived resource graph; it is reset on agent end and
 * belongs to the lifecycle/compile-cycle owner.
 */
export interface CompileCycleState {
    currentSystemPromptOptions?: BuildSystemPromptOptions;
    currentLatestUserMessage?: string;
    currentCompilationContext?: PromptCompilationContext;
    /** Inputs/results from the most recent compiled system prompt, for cache-impact previews. These survive agent_end. */
    currentCompilationRuntime?: PromptRuntimeSnapshot;
    currentBaseSystemPrompt?: string;
    currentCompiledSystemPrompt?: string;
    currentCompiledStackKey?: string;
    contextRewritePending: boolean;
    latestCompileDiagnostics: PromptStackDiagnostic[];
}
export declare function createCompileCycleState(): CompileCycleState;
export declare function resetCompileCycle(state: CompileCycleState): void;
//# sourceMappingURL=compile-cycle.d.ts.map