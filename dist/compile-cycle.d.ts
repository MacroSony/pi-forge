import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { PromptCompilationContext } from "./compiler.ts";
import type { PromptStackDiagnostic } from "./types.ts";
/**
 * Per-request compilation state. This is intentionally separate from
 * ForgeWorkspace's long-lived resource graph; it is reset on agent end and
 * belongs to the lifecycle/compile-cycle owner.
 */
export interface CompileCycleState {
    currentSystemPromptOptions?: BuildSystemPromptOptions;
    currentLatestUserMessage?: string;
    currentCompilationContext?: PromptCompilationContext;
    contextRewritePending: boolean;
    latestCompileDiagnostics: PromptStackDiagnostic[];
}
export declare function createCompileCycleState(): CompileCycleState;
export declare function resetCompileCycle(state: CompileCycleState): void;
//# sourceMappingURL=compile-cycle.d.ts.map