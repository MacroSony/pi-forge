import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ForgeSubagentSettings } from "./forge-config.ts";
import type { LoadedAgentProfile, ResolvedAgentProfile } from "./agent-profile.ts";
import { type ForgeSubagentProfileSummary } from "./subagent-profile-tool.ts";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime, SubagentBackendExecutionUpdate } from "./runtime/subagent-runtime.ts";
import type { AgentResponse, SubagentDiagnostic } from "./subagent/contract.ts";
import { type PiSubprocessRunReport } from "@zihanw/pi-subagent-runtime/backends/subprocess";
export interface ForgeSubagentApprovalReceipt {
    required: boolean;
    approved: boolean;
    viewedFullPrompt: boolean;
    source: "none" | "human" | "trusted-project-config";
    executionFingerprint?: string;
    approvedAt?: string;
}
export interface ForgeSubagentPlanSummary {
    backendId: string;
    profileId: string;
    promptStackId: string | null;
    provider: string;
    model: string;
    thinkingLevel: string;
    effectiveToolIds: string[];
    executionBoundary: string;
    workingDirectory: string;
    systemPromptChars: number;
    messageCount: number;
    messageRoles: string[];
    timeoutMs?: number;
    timeoutEnforcement?: string;
    promptRuntimeFingerprint: string;
    conversationFingerprint: string;
    executionFingerprint: string;
}
export interface ForgeSubagentToolDetails {
    status: "preparing" | "prepared" | "awaiting-approval" | "cancelled" | "running" | "completed" | "failed" | "timed-out";
    profileId: string;
    task: string;
    plan?: ForgeSubagentPlanSummary;
    approval: ForgeSubagentApprovalReceipt;
    diagnostics: SubagentDiagnostic[];
    progress: SubagentBackendExecutionUpdate[];
    response?: AgentResponse;
    report?: PiSubprocessRunReport;
}
export interface ForgeSubagentApprovalResult {
    approved: boolean;
    viewedFullPrompt: boolean;
}
/**
 * Optional refresh-time inputs for the forge_subagent tool description.
 * `summarize` returns the embedded profile summary for a context, or
 * undefined when the summary is disabled or empty; the tool re-registers
 * only when the rendered description would change.
 */
export interface ForgeSubagentToolRegistrationOptions {
    summarize?: (ctx: ExtensionContext) => string | undefined;
}
export declare function registerForgeSubagentTool(pi: ExtensionAPI, runtime: ForgeSubagentRuntime, profileIds: () => string[], resolveProfileKey: (selector: string) => {
    scope: "global" | "project";
    id: string;
} | undefined, options?: ForgeSubagentToolRegistrationOptions): (ctx: ExtensionContext) => void;
/**
 * Compact summary of enabled subagent profiles for the forge_subagent tool
 * description. Rendered only when subagents.summaryInToolDescription
 * is enabled; ready profiles come first, unavailable profiles stay visible so
 * the model does not attempt them. Returns undefined when disabled or when no
 * profile is enabled for delegation.
 */
export declare function renderEmbeddedSubagentSummary(settings: ForgeSubagentSettings, profiles: readonly LoadedAgentProfile[], resolve: (loaded: LoadedAgentProfile) => ResolvedAgentProfile): string | undefined;
export declare function renderEmbeddedSummaryText(summaries: readonly ForgeSubagentProfileSummary[]): string;
export declare function requestForgeSubagentApproval(prepared: ForgeSubagentPreparedRun, task: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<ForgeSubagentApprovalResult>;
export declare function summarizeForgeSubagentPlan(prepared: ForgeSubagentPreparedRun, cwd: string): ForgeSubagentPlanSummary;
export declare function renderApprovalSummary(prepared: ForgeSubagentPreparedRun, task: string, cwd: string): string;
export declare function renderApprovalDetails(prepared: ForgeSubagentPreparedRun, task: string, cwd: string): string;
export declare function renderFullForgeSubagentPrompt(prepared: ForgeSubagentPreparedRun): string;
//# sourceMappingURL=subagent-tool.d.ts.map