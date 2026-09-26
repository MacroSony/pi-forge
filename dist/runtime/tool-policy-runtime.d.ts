import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CapabilityToolPatch } from "../codecs/capability.ts";
import type { LoadedPromptStack } from "../types.ts";
import type { PromptStack } from "../types.ts";
import type { WebEditorPolicyResources } from "../web-editor/index.ts";
export interface ToolPolicySnapshot {
    baseline: string[];
    lastApplied: string[];
}
export interface ToolPolicyRuntime {
    sync(ctx?: ExtensionContext): void;
    restore(ctx?: ExtensionContext): void;
    blockReason(toolName: string): string | undefined;
    previewToolNames(stack: PromptStack | undefined): string[];
    previewOptions(base: BuildSystemPromptOptions, stack: PromptStack): BuildSystemPromptOptions;
    policyResources(options: BuildSystemPromptOptions): WebEditorPolicyResources;
    snapshot(): ToolPolicySnapshot;
    setCapabilities(patches: readonly CapabilityToolPatch[], restored?: ToolPolicySnapshot): void;
    validateCapabilities(patches: readonly CapabilityToolPatch[]): string | undefined;
}
export declare function createToolPolicyRuntime(pi: ExtensionAPI, getActiveStack: () => LoadedPromptStack | undefined): ToolPolicyRuntime;
export declare function reconcileToolPolicyBaseline(baseline: string[], lastApplied: string[], current: string[]): string[];
//# sourceMappingURL=tool-policy-runtime.d.ts.map