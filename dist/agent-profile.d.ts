import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Model } from "@earendil-works/pi-ai";
import type { LoadedPromptStack } from "./types.ts";
export declare const AGENT_PROFILE_TYPE: "pi-forge.agent-profile";
export declare const AGENT_PROFILE_THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export interface AgentProfileModelReference {
    provider: string;
    id: string;
}
export interface AgentProfile {
    schemaVersion: 1;
    type: typeof AGENT_PROFILE_TYPE;
    id: string;
    name?: string;
    description?: string;
    model: AgentProfileModelReference;
    thinkingLevel: ThinkingLevel;
    promptStack: string | null;
}
export type AgentProfileDiagnosticLevel = "error" | "warning" | "info";
export interface AgentProfileDiagnostic {
    level: AgentProfileDiagnosticLevel;
    message: string;
    field?: string;
}
export interface LoadedAgentProfile {
    profile: AgentProfile;
    filePath: string;
    diagnostics: AgentProfileDiagnostic[];
}
export interface AgentProfileResolutionResources {
    models: readonly Model<any>[];
    availableModels?: readonly Model<any>[];
    promptStacks: readonly LoadedPromptStack[];
}
export interface ResolvedAgentProfile {
    loaded: LoadedAgentProfile;
    model?: Model<any>;
    promptStack?: LoadedPromptStack;
    effectiveThinkingLevel: ThinkingLevel;
    diagnostics: AgentProfileDiagnostic[];
}
export { agentProfilePath, agentProfilesDir } from "./storage.ts";
export declare function isValidAgentProfileId(id: string): boolean;
export declare function loadAgentProfiles(cwd: string): LoadedAgentProfile[];
export declare function loadAgentProfileFile(filePath: string): LoadedAgentProfile;
export declare function validateAgentProfile(profile: AgentProfile): AgentProfileDiagnostic[];
export declare function resolveAgentProfile(loaded: LoadedAgentProfile, resources: AgentProfileResolutionResources): ResolvedAgentProfile;
export declare function isUsableAgentProfile(loaded: LoadedAgentProfile): boolean;
export declare function isResolvedAgentProfileUsable(resolved: ResolvedAgentProfile): boolean;
export declare function hasAgentProfileErrors(diagnostics: readonly AgentProfileDiagnostic[]): boolean;
export declare function renderAgentProfileDiagnostics(diagnostics: readonly AgentProfileDiagnostic[]): string;
export declare function agentProfileFingerprint(profile: AgentProfile): string;
//# sourceMappingURL=agent-profile.d.ts.map