import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PiForgeRuntimeState } from "./runtime-state.ts";
import type { PromptStackDiagnostic } from "./types.ts";
export interface LifecycleDeps {
    reloadStacks(ctx: ExtensionContext, preferredId?: string, options?: {
        deferToolPolicy?: boolean;
        suppressAutoActivate?: boolean;
    }): Promise<void>;
    disposePromptStackRuntime(): PromptStackDiagnostic[];
    disposeSubagentRuntime(): Promise<void>;
    activateFreshSessionDefaults(ctx: ExtensionContext): Promise<void>;
    refreshWebEditorHost(ctx: ExtensionContext, promptOptions?: BuildSystemPromptOptions): void;
    refreshSubagentToolDescriptions(ctx: ExtensionContext): void;
    notifyActivePreset(ctx: ExtensionContext, detail: string): void;
    syncActiveToolPolicy(ctx?: ExtensionContext): void;
    restoreActiveToolPolicy(): void;
    toolPolicyBlockReason(toolName: string): string | undefined;
    activeId(): string | undefined;
    persistActiveSelection(): void;
    recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void;
    reloadForgeWorkspace(ctx: ExtensionContext): void;
    disposeForgeWorkspace(): void;
}
export declare function registerLifecycleHandlers(pi: ExtensionAPI, state: PiForgeRuntimeState, deps: LifecycleDeps): void;
//# sourceMappingURL=lifecycle.d.ts.map