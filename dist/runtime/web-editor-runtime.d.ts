import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type WebHostRuntime } from "../web-host.ts";
export interface WebEditorRuntime {
    refreshHost(ctx: ExtensionContext, promptOptions?: BuildSystemPromptOptions): void;
    open(ctx: ExtensionCommandContext, mode?: "open" | "restart"): Promise<void>;
    stop(ctx: ExtensionCommandContext): Promise<void>;
}
export declare function createWebEditorRuntime(createRuntime: (ctx: ExtensionContext, promptOptions: BuildSystemPromptOptions) => WebHostRuntime): WebEditorRuntime;
//# sourceMappingURL=web-editor-runtime.d.ts.map