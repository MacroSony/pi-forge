import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { WebEditorPayloadCapture } from "./web-editor/index.ts";
import type { LoadedPromptStack, PromptStackDiagnostic, PromptVariableStore, PromptVariableValue } from "./types.ts";
export declare const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export declare const VARIABLE_ENTRY_TYPE = "pi-forge-variable-state";
export type PayloadDisplayTarget = "editor" | "web";
export interface PiForgeRuntimeState {
    stacks: LoadedPromptStack[];
    active?: LoadedPromptStack;
    currentSystemPromptOptions?: BuildSystemPromptOptions;
    currentLatestUserMessage?: string;
    currentVariableStore?: PromptVariableStore;
    contextRewritePending: boolean;
    sessionVariables: Record<string, PromptVariableValue>;
    lastPersistedActiveId?: string;
    latestCompileDiagnostics: PromptStackDiagnostic[];
    interceptNextProviderPayload: boolean;
    interceptPayloadSavePath?: string;
    interceptPayloadDisplayTarget: PayloadDisplayTarget;
    payloadCaptureArmedAt?: string;
    latestProviderPayloadCapture?: WebEditorPayloadCapture;
}
export declare function createRuntimeState(): PiForgeRuntimeState;
//# sourceMappingURL=runtime-state.d.ts.map