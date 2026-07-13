import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiForgeRuntimeState } from "../runtime-state.ts";
import type { PromptStack } from "../types.ts";
import type { WebEditorPolicyResources } from "../web-editor/index.ts";
export interface ToolPolicyRuntime {
    sync(ctx?: ExtensionContext): void;
    restore(ctx?: ExtensionContext): void;
    blockReason(toolName: string): string | undefined;
    previewToolNames(stack: PromptStack | undefined): string[];
    previewOptions(ctx: ExtensionCommandContext, stack: PromptStack): BuildSystemPromptOptions;
    policyResources(ctx: ExtensionCommandContext): WebEditorPolicyResources;
}
export declare function createToolPolicyRuntime(pi: ExtensionAPI, state: PiForgeRuntimeState): ToolPolicyRuntime;
export declare function reconcileToolPolicyBaseline(baseline: string[], lastApplied: string[], current: string[]): string[];
//# sourceMappingURL=tool-policy-runtime.d.ts.map