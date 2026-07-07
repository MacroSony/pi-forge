import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiForgeRuntimeState } from "./runtime-state.ts";
import type { LoadedPromptStack } from "./types.ts";
export interface PresetCommandDeps {
    selectedActiveId(): string | undefined;
    setActive(id: string | undefined, ctx?: ExtensionCommandContext): boolean;
    reloadStacks(ctx: ExtensionCommandContext, preferredId?: string): Promise<void>;
    openWebEditor(ctx: ExtensionCommandContext, mode?: "open" | "restart"): Promise<void>;
    stopWebEditor(ctx: ExtensionCommandContext): Promise<void>;
}
export declare function registerPresetCommand(pi: ExtensionAPI, state: PiForgeRuntimeState, deps: PresetCommandDeps): void;
export declare function selectedActiveId(state: PiForgeRuntimeState): string | undefined;
export declare function findStack(state: PiForgeRuntimeState, id: string): LoadedPromptStack | undefined;
//# sourceMappingURL=preset-command.d.ts.map