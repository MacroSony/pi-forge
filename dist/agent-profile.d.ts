import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Model } from "@earendil-works/pi-ai";
import { type ResourceScope } from "./resource-identity.ts";
import type { LoadedPromptStack } from "./types.ts";
import { type AgentProfile, type AgentProfileDiagnostic, type AgentProfileModelReference, type LoadedAgentProfile } from "./codecs/agent-profile.ts";
export { AGENT_PROFILE_TYPE, AGENT_PROFILE_THINKING_LEVELS, validateAgentProfile, validateAgentProfilePromptStackScope } from "./codecs/agent-profile.ts";
export type { AgentProfile, AgentProfileDiagnostic, AgentProfileDiagnosticLevel, AgentProfileModelReference, LoadedAgentProfile } from "./codecs/agent-profile.ts";
export declare function loadAgentProfileFile(filePath: string, scope?: "global" | "project"): LoadedAgentProfile;
export { agentProfilePath, agentProfilesDir } from "./storage.ts";
export declare function isValidAgentProfileId(id: string): boolean;
export declare function loadAgentProfiles(cwd: string): LoadedAgentProfile[];
export declare function loadAgentProfilesScoped(cwd: string, globalDir?: string): LoadedAgentProfile[];
export declare function loadGlobalAgentProfiles(globalDir?: string): LoadedAgentProfile[];
export declare function chooseAutoActivateAgentProfile(profiles: readonly LoadedAgentProfile[]): LoadedAgentProfile | undefined;
export declare function hasAutoActivateAgentProfile(profiles: readonly LoadedAgentProfile[]): boolean;
export declare function resolveAgentProfile(loaded: LoadedAgentProfile, resources: AgentProfileResolutionResources): ResolvedAgentProfile;
export declare function isUsableAgentProfile(loaded: LoadedAgentProfile): boolean;
export declare function isResolvedAgentProfileUsable(resolved: ResolvedAgentProfile): boolean;
export declare function hasAgentProfileErrors(diagnostics: readonly AgentProfileDiagnostic[]): boolean;
export declare function renderAgentProfileDiagnostics(diagnostics: readonly AgentProfileDiagnostic[]): string;
export declare function agentProfileFingerprint(profile: AgentProfile): string;
export declare function isAgentProfileProvenance(value: unknown): value is AgentProfileProvenance;
export interface AgentProfileResolutionResources {
    models: readonly Model<any>[];
    availableModels?: readonly Model<any>[];
    promptStacks: readonly LoadedPromptStack[];
    toolNames?: readonly string[];
}
export interface ResolvedAgentProfile {
    loaded: LoadedAgentProfile;
    model?: Model<any>;
    promptStack?: LoadedPromptStack;
    effectiveThinkingLevel: ThinkingLevel;
    diagnostics: AgentProfileDiagnostic[];
}
export interface AgentProfileRuntimeSnapshot {
    model: AgentProfileModelReference;
    thinkingLevel: ThinkingLevel;
    promptStack: string | null;
}
export interface AgentProfileProvenance {
    profileId: string;
    /** Scope of the applied profile. Absent on legacy records, which are project-scoped. */
    scope?: ResourceScope;
    sourcePath: string;
    sourceFingerprint: string;
    appliedAt: string;
    snapshot: AgentProfileRuntimeSnapshot;
}
//# sourceMappingURL=agent-profile.d.ts.map