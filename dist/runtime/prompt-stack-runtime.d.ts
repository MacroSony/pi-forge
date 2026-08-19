import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompileCycleState } from "../compile-cycle.ts";
import type { ForgeWorkspace } from "../workspace.ts";
import type { PromptStackDiagnostic } from "../types.ts";
export interface PromptStackRuntime {
    dispose(): PromptStackDiagnostic[];
    activeId(): string | undefined;
    selectedActiveId(): string | undefined;
    restorePersistedActiveId(id?: string): void;
    persistActiveSelection(): void;
    setActive(id: string | undefined, ctx?: ExtensionContext): boolean;
    reloadStacks(ctx: ExtensionContext, preferredId?: string, options?: {
        deferToolPolicy?: boolean;
        suppressAutoActivate?: boolean;
    }): Promise<void>;
    updateStatus(ctx: ExtensionContext): void;
    notifyActivePreset(ctx: ExtensionContext, detail: string): void;
    recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void;
}
export declare function createPromptStackRuntime(pi: ExtensionAPI, workspace: ForgeWorkspace, compileCycle: CompileCycleState, deps: {
    syncToolPolicy(ctx?: ExtensionContext): void;
}): PromptStackRuntime;
//# sourceMappingURL=prompt-stack-runtime.d.ts.map