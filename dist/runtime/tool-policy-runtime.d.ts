import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type InstructionToolPatch } from "../codecs/instruction-mode.ts";
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
    setInstructionModes(patches: readonly InstructionToolPatch[], restored?: ToolPolicySnapshot): void;
    validateInstructionModes(patches: readonly InstructionToolPatch[]): string | undefined;
}
export declare function createToolPolicyRuntime(pi: ExtensionAPI, getActiveStack: () => LoadedPromptStack | undefined): ToolPolicyRuntime;
export declare function reconcileToolPolicyBaseline(baseline: string[], lastApplied: string[], current: string[]): string[];
//# sourceMappingURL=tool-policy-runtime.d.ts.map