import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type WebHostRuntime } from "../web-host.ts";
export interface WebEditorRuntime {
    refreshHost(ctx: ExtensionContext): void;
    open(ctx: ExtensionCommandContext, mode?: "open" | "restart"): Promise<void>;
    stop(ctx: ExtensionCommandContext): Promise<void>;
}
export declare function createWebEditorRuntime(createRuntime: (ctx: ExtensionCommandContext) => WebHostRuntime): WebEditorRuntime;
//# sourceMappingURL=web-editor-runtime.d.ts.map