import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CompileCycleState } from "./compile-cycle.ts";
import type { ForgeWorkspace } from "./workspace.ts";
import type { PromptStackDiagnostic } from "./types.ts";
export interface LifecycleDeps {
    reloadStacks(ctx: ExtensionContext, preferredId?: string, options?: {
        deferToolPolicy?: boolean;
        suppressAutoActivate?: boolean;
    }): Promise<void>;
    disposePromptStackRuntime(): PromptStackDiagnostic[];
    activateFreshSessionDefaults(ctx: ExtensionContext): Promise<void>;
    refreshWebEditorHost(ctx: ExtensionContext, promptOptions?: BuildSystemPromptOptions): void;
    notifyActivePreset(ctx: ExtensionContext, detail: string): void;
    syncActiveToolPolicy(ctx?: ExtensionContext): void;
    restoreActiveToolPolicy(): void;
    toolPolicyBlockReason(toolName: string): string | undefined;
    persistActiveSelection(): void;
    recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void;
    restorePersistedActiveId(id?: string): void;
    reloadForgeWorkspace(ctx: ExtensionContext): void;
    disposeForgeWorkspace(): void;
}
export declare function registerLifecycleHandlers(pi: ExtensionAPI, workspace: ForgeWorkspace, compileCycle: CompileCycleState, deps: LifecycleDeps): void;
//# sourceMappingURL=lifecycle.d.ts.map