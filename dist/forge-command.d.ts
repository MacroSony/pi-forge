import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
export interface ForgeUiCommandDeps {
    openWebEditor(ctx: ExtensionCommandContext, mode?: "open" | "restart"): Promise<void>;
    stopWebEditor(ctx: ExtensionCommandContext): Promise<void>;
}
export type ForgeCommand = Pick<RegisteredCommand, "description" | "handler" | "getArgumentCompletions">;
export declare function handleForgeUi(args: string, ctx: ExtensionCommandContext, deps: ForgeUiCommandDeps, usage?: string): Promise<void>;
/** Main owns /forge. Optional packages contribute only a child, never another root. */
export declare function registerForgeCommand(pi: ExtensionAPI, deps: ForgeUiCommandDeps, payload: ForgeCommand): void;
//# sourceMappingURL=forge-command.d.ts.map