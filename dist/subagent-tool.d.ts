import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
import type { AgentResponse, SubagentDiagnostic } from "./subagent/contract.ts";
import type { SubagentBackendExecutionUpdate } from "./subagent/backend-registry.ts";
import { type PiSubprocessRunReport } from "./subagent/pi-subprocess-backend.ts";
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
    promptRuntimeFingerprint: string;
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
export declare function registerForgeSubagentTool(pi: ExtensionAPI, runtime: ForgeSubagentRuntime, profileIds: () => string[]): void;
export declare function requestForgeSubagentApproval(prepared: ForgeSubagentPreparedRun, task: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<ForgeSubagentApprovalResult>;
export declare function summarizeForgeSubagentPlan(prepared: ForgeSubagentPreparedRun, cwd: string): ForgeSubagentPlanSummary;
export declare function renderApprovalSummary(prepared: ForgeSubagentPreparedRun, task: string, cwd: string): string;
export declare function renderFullForgeSubagentPrompt(prepared: ForgeSubagentPreparedRun): string;
//# sourceMappingURL=subagent-tool.d.ts.map