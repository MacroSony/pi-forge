import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LoadedPromptStack, PromptStackDiagnostic } from "./types.ts";
import type { WebEditorHost, WebEditorOperationResult, WebEditorPayloadSnapshot, WebEditorPolicyResources, WebEditorPreview, WebEditorStackSummary } from "./web-editor/index.ts";
export interface WebHostRuntime {
    getStacks(): LoadedPromptStack[];
    getActive(): LoadedPromptStack | undefined;
    getActiveId(): string | undefined;
    getSelectedActiveId(): string | undefined;
    setActive(id: string | undefined): boolean;
    reloadStacks(preferredId?: string): void;
    buildPreview(target: LoadedPromptStack): {
        text: string;
        preview: WebEditorPreview;
        diagnostics: PromptStackDiagnostic[];
    };
    getPolicyResources(): WebEditorPolicyResources;
    getPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
    armPayload(savePath?: string): WebEditorOperationResult<WebEditorPayloadSnapshot>;
    clearPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
}
export declare function createWebEditorHost(ctx: ExtensionCommandContext, runtime: WebHostRuntime): WebEditorHost;
export declare function stackSummary(loaded: LoadedPromptStack, active: LoadedPromptStack | undefined): WebEditorStackSummary;
export declare function stackSummaries(stacks: LoadedPromptStack[], active: LoadedPromptStack | undefined): WebEditorStackSummary[];
export declare function loadWebEditorSettings(ctx: ExtensionCommandContext): {
    preferredPort?: number;
    configPath: string;
    warnings: string[];
};
//# sourceMappingURL=web-host.d.ts.map