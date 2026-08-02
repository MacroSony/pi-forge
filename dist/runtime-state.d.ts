import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { AgentProfileProvenance, LoadedAgentProfile } from "./agent-profile.ts";
import type { WebEditorPayloadCapture } from "./web-editor/index.ts";
import type { LoadedPromptStack, PromptStackDiagnostic, PromptVariableStore, PromptVariableValue } from "./types.ts";
export declare const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export declare const VARIABLE_ENTRY_TYPE = "pi-forge-variable-state";
export declare const PROFILE_ENTRY_TYPE = "pi-forge-agent-profile-state";
export type PayloadDisplayTarget = "editor" | "web";
export interface PiForgeRuntimeState {
    stacks: LoadedPromptStack[];
    profiles: LoadedAgentProfile[];
    active?: LoadedPromptStack;
    lastAppliedProfile?: AgentProfileProvenance;
    currentSystemPromptOptions?: BuildSystemPromptOptions;
    currentLatestUserMessage?: string;
    currentVariableStore?: PromptVariableStore;
    contextRewritePending: boolean;
    sessionVariables: Record<string, PromptVariableValue>;
    lastPersistedActiveId?: string;
    latestCompileDiagnostics: PromptStackDiagnostic[];
    forgeExtensionDiagnostics: PromptStackDiagnostic[];
    forgeExtensionPaths: string[];
    interceptNextProviderPayload: boolean;
    interceptPayloadSavePath?: string;
    interceptPayloadDisplayTarget: PayloadDisplayTarget;
    payloadCaptureArmedAt?: string;
    latestProviderPayloadCapture?: WebEditorPayloadCapture;
}
export declare function createRuntimeState(): PiForgeRuntimeState;
//# sourceMappingURL=runtime-state.d.ts.map