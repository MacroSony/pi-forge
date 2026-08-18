import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ResourceScope } from "../resource-identity.ts";
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
export type AgentProfileScope = "global" | "project";
/**
 * Parse, normalize, and validate an agent profile from its serialized source.
 * This is the single entry point for turning profile JSON text into a
 * LoadedAgentProfile; loaders only add file-system concerns on top.
 */
export declare function parseAgentProfile(source: string, filePath: string, scope: AgentProfileScope): LoadedAgentProfile;
/** Build a fail-closed LoadedAgentProfile when the source cannot be read or parsed. */
export declare function createAgentProfileFault(filePath: string, scope: AgentProfileScope, message: string): LoadedAgentProfile;
/**
 * Single canonical serializer for agent profiles. Every writer (profile
 * service, command, repository) must go through this function so serialized
 * output stays identical across all write paths.
 */
export declare function serializeAgentProfile(profile: AgentProfile): string;
export declare function validateAgentProfile(profile: AgentProfile): AgentProfileDiagnostic[];
export declare function validateAgentProfilePromptStackScope(profile: AgentProfile, scope: ResourceScope): AgentProfileDiagnostic[];
//# sourceMappingURL=agent-profile.d.ts.map