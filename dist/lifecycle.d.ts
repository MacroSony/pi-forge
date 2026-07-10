import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PiForgeRuntimeState } from "./runtime-state.ts";
import type { PromptStackDiagnostic } from "./types.ts";
export interface LifecycleDeps {
    reloadStacks(ctx: ExtensionContext, preferredId?: string): Promise<void>;
    refreshWebEditorHost(ctx: ExtensionContext): void;
    notifyActivePreset(ctx: ExtensionContext, detail: string): void;
    syncActiveToolPolicy(ctx?: ExtensionContext): void;
    restoreActiveToolPolicy(): void;
    activeId(): string | undefined;
    persistActiveSelection(id: string): void;
    recordCompileDiagnostics(ctx: ExtensionContext, diagnostics: PromptStackDiagnostic[]): void;
}
export declare function registerLifecycleHandlers(pi: ExtensionAPI, state: PiForgeRuntimeState, deps: LifecycleDeps): void;
//# sourceMappingURL=lifecycle.d.ts.map