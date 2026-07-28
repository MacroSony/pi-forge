import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ForgeSubagentBackendSource } from "./forge-config.ts";
import { type AgentProfileDiagnostic, type LoadedAgentProfile, type ResolvedAgentProfile } from "./agent-profile.ts";
export interface ForgeSubagentProfileSummary {
    id: string;
    name?: string;
    description?: string;
    model: {
        provider: string;
        id: string;
    };
    thinkingLevel: string;
    promptStack: string | null;
    status: "ready" | "unavailable";
    diagnostics: AgentProfileDiagnostic[];
}
export interface ForgeSubagentProfilesToolDetails {
    status: "completed" | "disabled";
    invocationToolAvailable: boolean;
    approvalMode: "interactive" | "unattended-config";
    defaultBackend?: {
        id: string;
        source: ForgeSubagentBackendSource;
    };
    timeout: {
        milliseconds: number;
        source: Exclude<ForgeSubagentBackendSource, "explicit">;
    };
    configWarnings: string[];
    profiles: ForgeSubagentProfileSummary[];
}
export declare function registerForgeSubagentProfilesTool(pi: ExtensionAPI, profiles: () => readonly LoadedAgentProfile[], resolveProfile: (profile: LoadedAgentProfile, ctx: ExtensionContext) => ResolvedAgentProfile): void;
export declare function summarizeProfile(loaded: LoadedAgentProfile, resolved: ResolvedAgentProfile): ForgeSubagentProfileSummary;
export declare function renderProfileCatalog(profiles: readonly ForgeSubagentProfileSummary[], invocationToolAvailable: boolean, approvalMode?: "interactive" | "unattended-config", configWarnings?: readonly string[], defaultBackend?: {
    id: string;
    source: ForgeSubagentBackendSource;
}, timeout?: {
    milliseconds: number;
    source: Exclude<ForgeSubagentBackendSource, "explicit">;
}): string;
//# sourceMappingURL=subagent-profile-tool.d.ts.map