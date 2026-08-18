import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { AgentProfileProvenance, LoadedAgentProfile } from "./agent-profile.ts";
import type { WebEditorPayloadCapture } from "./web-editor/index.ts";
import type { LoadedPromptStack, PromptStackDiagnostic } from "./types.ts";

export const STATE_ENTRY_TYPE = "pi-forge-prompt-stack-state";
export const PROFILE_ENTRY_TYPE = "pi-forge-agent-profile-state";

export type PayloadDisplayTarget = "editor" | "web";

export interface PiForgeRuntimeState {
	stacks: LoadedPromptStack[];
	profiles: LoadedAgentProfile[];
	active?: LoadedPromptStack;
	lastAppliedProfile?: AgentProfileProvenance;
	currentSystemPromptOptions?: BuildSystemPromptOptions;
	currentLatestUserMessage?: string;
	contextRewritePending: boolean;
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

export function createRuntimeState(): PiForgeRuntimeState {
	return {
		stacks: [],
		profiles: [],
		contextRewritePending: false,
		latestCompileDiagnostics: [],
		forgeExtensionDiagnostics: [],
		forgeExtensionPaths: [],
		interceptNextProviderPayload: false,
		interceptPayloadDisplayTarget: "editor",
	};
}
