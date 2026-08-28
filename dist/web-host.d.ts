import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentProfileProvenance, type LoadedAgentProfile, type ResolvedAgentProfile } from "./agent-profile.ts";
import { type AgentProfileApplicationResult, type AgentProfileCurrentRuntime } from "./profile-service.ts";
import type { ContextDiffView } from "./context-diff-history.ts";
import type { LoadedPromptStack, PromptStack, PromptStackDiagnostic } from "./types.ts";
import type { WebEditorLocale, WebEditorHost, WebEditorOperationResult, WebEditorPayloadSnapshot, WebEditorPolicyResources, WebEditorPreview, WebEditorStackSummary } from "./web-editor/index.ts";
export interface WebHostRuntime {
    getStacks(): LoadedPromptStack[];
    getActive(): LoadedPromptStack | undefined;
    getActiveId(): string | undefined;
    getSelectedActiveId(): string | undefined;
    setActive(id: string | undefined): boolean;
    reloadStacks(preferredId?: string): Promise<void>;
    buildPreview(target: LoadedPromptStack): {
        text: string;
        preview: WebEditorPreview;
        diagnostics: PromptStackDiagnostic[];
    };
    getPolicyResources(): WebEditorPolicyResources;
    getProfiles(): LoadedAgentProfile[];
    getLastAppliedProfile(): AgentProfileProvenance | undefined;
    getCurrentProfileRuntime(): AgentProfileCurrentRuntime;
    resolveProfile(target: LoadedAgentProfile): ResolvedAgentProfile;
    previewToolNames(stack: PromptStack | undefined): string[];
    reloadProfiles(): void | Promise<void>;
    isIdle(): boolean;
    applyProfile(target: ResolvedAgentProfile): Promise<AgentProfileApplicationResult>;
    getPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
    armPayload(savePath?: string): WebEditorOperationResult<WebEditorPayloadSnapshot>;
    clearPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
    getContextDiff(): WebEditorOperationResult<ContextDiffView>;
}
export declare function createWebEditorHost(ctx: ExtensionContext, runtime: WebHostRuntime): WebEditorHost;
export declare function stackSummary(loaded: LoadedPromptStack, active: LoadedPromptStack | undefined): WebEditorStackSummary;
export declare function stackSummaries(stacks: LoadedPromptStack[], active: LoadedPromptStack | undefined): WebEditorStackSummary[];
export interface WebEditorSettings {
    preferredPort?: number;
    locale?: WebEditorLocale;
    configPath: string;
    warnings: string[];
}
export declare function loadWebEditorSettings(ctx: ExtensionContext): WebEditorSettings;
export type StackMutationFailureReason = "invalid-path" | "exists" | "missing" | "io";
/** HTTP status mapping for repository write/delete failures surfaced to the web editor. */
export declare function stackMutationStatus(reason: StackMutationFailureReason): number;
//# sourceMappingURL=web-host.d.ts.map