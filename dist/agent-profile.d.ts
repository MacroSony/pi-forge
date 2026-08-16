import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Model } from "@earendil-works/pi-ai";
import { type ResourceScope } from "./resource-identity.ts";
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
    autoActivate?: boolean;
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
    scope: "global" | "project";
    key: {
        scope: "global" | "project";
        id: string;
    };
    diagnostics: AgentProfileDiagnostic[];
}
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
export { agentProfilePath, agentProfilesDir } from "./storage.ts";
export declare function isValidAgentProfileId(id: string): boolean;
export declare function loadAgentProfiles(cwd: string): LoadedAgentProfile[];
/**
 * Load both global and project profiles. Global definitions are user-owned
 * and always load; project definitions load from the trusted project dirs.
 * The caller decides whether project trust applies before calling.
 */
export declare function loadAgentProfilesScoped(cwd: string, globalDir?: string): LoadedAgentProfile[];
/** Load only the user-owned global profiles, used by untrusted projects. */
export declare function loadGlobalAgentProfiles(globalDir?: string): LoadedAgentProfile[];
export declare function chooseAutoActivateAgentProfile(profiles: readonly LoadedAgentProfile[]): LoadedAgentProfile | undefined;
export declare function hasAutoActivateAgentProfile(profiles: readonly LoadedAgentProfile[]): boolean;
export declare function loadAgentProfileFile(filePath: string, scope?: "global" | "project"): LoadedAgentProfile;
export declare function validateAgentProfile(profile: AgentProfile): AgentProfileDiagnostic[];
/**
 * Validate the profile's stored `promptStack` selector against the profile's
 * own scope. Bare references stay scope-relative; only global profiles are
 * prohibited from referencing project stacks explicitly. Used by write paths
 * so edited JSON cannot persist a scope-unsafe dependency.
 */
export declare function validateAgentProfilePromptStackScope(profile: AgentProfile, scope: ResourceScope): AgentProfileDiagnostic[];
export declare function resolveAgentProfile(loaded: LoadedAgentProfile, resources: AgentProfileResolutionResources): ResolvedAgentProfile;
export declare function isUsableAgentProfile(loaded: LoadedAgentProfile): boolean;
export declare function isResolvedAgentProfileUsable(resolved: ResolvedAgentProfile): boolean;
export declare function hasAgentProfileErrors(diagnostics: readonly AgentProfileDiagnostic[]): boolean;
export declare function renderAgentProfileDiagnostics(diagnostics: readonly AgentProfileDiagnostic[]): string;
export declare function agentProfileFingerprint(profile: AgentProfile): string;
export declare function isAgentProfileProvenance(value: unknown): value is AgentProfileProvenance;
//# sourceMappingURL=agent-profile.d.ts.map