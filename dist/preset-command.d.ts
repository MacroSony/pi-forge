import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CompileCycleState } from "./compile-cycle.ts";
import type { ForgeWorkspace } from "./workspace.ts";
import type { ContextDiffProviderUsage } from "./context-diff-history.ts";
import type { LoadedPromptStack } from "./types.ts";
export interface PresetCommandDeps {
    selectedActiveId(): string | undefined;
    setActive(id: string | undefined, ctx?: ExtensionCommandContext): boolean;
    lastActivationError?(): string | undefined;
    reloadStacks(ctx: ExtensionCommandContext, preferredId?: string): Promise<void>;
    openWebEditor(ctx: ExtensionCommandContext, mode?: "open" | "restart"): Promise<void>;
    stopWebEditor(ctx: ExtensionCommandContext): Promise<void>;
    latestContextDiffUsage(): ContextDiffProviderUsage | undefined;
}
export declare function registerPresetCommand(pi: ExtensionAPI, workspace: ForgeWorkspace, compileCycle: CompileCycleState, deps: PresetCommandDeps): void;
export declare function findStack(workspace: ForgeWorkspace, selector: string): LoadedPromptStack | undefined;
//# sourceMappingURL=preset-command.d.ts.map