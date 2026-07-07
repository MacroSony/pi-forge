import { getRegisteredMacros, type PromptMacroDefinition } from "./macro-engine.ts";
import { type PromptRenderHelpers } from "./render-helpers.ts";
import { getRegisteredSlots, type PromptSlotDefinition } from "./slot-renderers.ts";
import type { PromptStackDiagnostic } from "./types.ts";
export interface ForgeExtensionApi {
    cwd: string;
    forgeDir: string;
    extensionPath: string;
    helpers: PromptRenderHelpers;
    registerMacro(definition: PromptMacroDefinition): () => void;
    registerSlot(definition: PromptSlotDefinition): () => void;
    getRegisteredMacros: typeof getRegisteredMacros;
    getRegisteredSlots: typeof getRegisteredSlots;
}
export type ForgeExtensionRegister = (api: ForgeExtensionApi) => void | (() => void) | Promise<void | (() => void)>;
export interface ForgeExtensionState {
    unregister: Array<() => void>;
    loadVersion: number;
}
export interface ForgeExtensionLoadResult {
    diagnostics: PromptStackDiagnostic[];
    loadedPaths: string[];
}
export declare function createForgeExtensionState(): ForgeExtensionState;
export declare function reloadForgeExtensions(cwd: string, state: ForgeExtensionState): Promise<ForgeExtensionLoadResult>;
export declare function unloadForgeExtensions(state: ForgeExtensionState): PromptStackDiagnostic[];
export declare function discoverForgeExtensionFiles(cwd: string): string[];
//# sourceMappingURL=forge-extensions.d.ts.map