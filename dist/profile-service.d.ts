import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentProfile, type AgentProfileDiagnostic, type AgentProfileModelReference, type AgentProfileProvenance, type LoadedAgentProfile, type ResolvedAgentProfile } from "./agent-profile.ts";
import type { LoadedPromptStack, PromptResourcePolicy } from "./types.ts";
export interface AgentProfileCurrentRuntime {
    model: AgentProfileModelReference | null;
    thinkingLevel: ThinkingLevel;
    promptStack: string | null;
    effectiveTools: string[];
}
export interface AgentProfileCaptureInput {
    model: AgentProfileModelReference | null;
    thinkingLevel: ThinkingLevel;
    promptStack: string | null;
}
export type AgentProfileCaptureResult = {
    ok: true;
    profile: AgentProfile;
    diagnostics: AgentProfileDiagnostic[];
} | {
    ok: false;
    diagnostics: AgentProfileDiagnostic[];
};
export type AgentProfileWriteResult = {
    ok: true;
    profile: AgentProfile;
    filePath: string;
} | {
    ok: false;
    reason: "exists" | "invalid-path" | "validation" | "io";
    diagnostics: AgentProfileDiagnostic[];
    error?: string;
};
export type AgentProfileDeleteResult = {
    ok: true;
    filePath: string;
} | {
    ok: false;
    reason: "missing" | "invalid-path" | "io";
    filePath: string;
    error?: string;
};
export interface AgentProfileApplicationState {
    active?: LoadedPromptStack;
    lastAppliedProfile?: AgentProfileProvenance;
}
export interface AgentProfileApplicationDeps {
    setActive(id: string | undefined, ctx?: ExtensionContext): boolean;
}
export type AgentProfileApplicationResult = {
    ok: true;
    warningCount: number;
    provenance: AgentProfileProvenance;
} | {
    ok: false;
    detail: string;
    rollbackErrors: string[];
};
export interface AgentProfilePreview {
    profileId: string;
    name?: string;
    description?: string;
    sourcePath: string;
    autoActivate: boolean;
    current: AgentProfileCurrentRuntime;
    target: {
        model: AgentProfileModelReference;
        thinkingLevel: ThinkingLevel;
        promptStack: string | null;
        effectiveTools: string[];
        toolPolicy?: PromptResourcePolicy;
    };
    applicable: boolean;
    diagnostics: AgentProfileDiagnostic[];
}
export interface AgentProfileDriftField<T> {
    expected: T;
    actual: T;
    changed: boolean;
}
export interface AgentProfileRuntimeStatus {
    current: AgentProfileCurrentRuntime;
    lastApplied?: {
        provenance: AgentProfileProvenance;
        sourceState: "unchanged" | "changed" | "missing";
        drift: {
            model: AgentProfileDriftField<AgentProfileModelReference | null>;
            thinkingLevel: AgentProfileDriftField<ThinkingLevel>;
            promptStack: AgentProfileDriftField<string | null>;
        };
    };
}
export declare function captureAgentProfile(id: string, runtime: AgentProfileCaptureInput, existing?: LoadedAgentProfile): AgentProfileCaptureResult;
export declare function writeAgentProfile(cwd: string, profile: AgentProfile, options?: {
    filePath?: string;
    overwrite?: boolean;
}): AgentProfileWriteResult;
export declare function deleteAgentProfile(cwd: string, loaded: LoadedAgentProfile): AgentProfileDeleteResult;
export declare function applyResolvedAgentProfile(pi: ExtensionAPI, state: AgentProfileApplicationState, deps: AgentProfileApplicationDeps, resolved: ResolvedAgentProfile, ctx: ExtensionContext): Promise<AgentProfileApplicationResult>;
export declare function forgetAgentProfileProvenance(pi: ExtensionAPI, state: AgentProfileApplicationState): boolean;
export declare function createAgentProfilePreview(resolved: ResolvedAgentProfile, current: AgentProfileCurrentRuntime, targetEffectiveTools: string[]): AgentProfilePreview;
export declare function getAgentProfileRuntimeStatus(profiles: readonly LoadedAgentProfile[], provenance: AgentProfileProvenance | undefined, current: AgentProfileCurrentRuntime): AgentProfileRuntimeStatus;
//# sourceMappingURL=profile-service.d.ts.map