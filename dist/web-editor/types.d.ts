import type { AgentProfile, AgentProfileDiagnostic } from "../agent-profile.ts";
import type { AgentProfilePreview, AgentProfileRuntimeStatus } from "../profile-service.ts";
import type { PromptStack, PromptStackDiagnostic } from "../types.ts";
export interface WebEditorStackSummary {
    id: string;
    name?: string;
    filePath: string;
    active: boolean;
    autoActivate?: boolean;
    mode?: string;
    itemCount: number;
    errors: number;
    warnings: number;
    diagnostics: PromptStackDiagnostic[];
}
export interface WebEditorHost {
    cwd: string;
    listStacks(): WebEditorStackSummary[];
    listProfiles(): WebEditorProfileCollection;
    reloadProfiles(): Promise<WebEditorOperationResult<WebEditorProfileCollection>>;
    validateProfile(profile: AgentProfile, existingId?: string): WebEditorProfileValidation;
    createProfile(profile: AgentProfile): Promise<WebEditorOperationResult<WebEditorProfileMutation>>;
    saveProfile(id: string, profile: AgentProfile): Promise<WebEditorOperationResult<WebEditorProfileMutation>>;
    listResources(): WebEditorPolicyResources;
    getStack(id: string): {
        stack: PromptStack;
        filePath: string;
        diagnostics: PromptStackDiagnostic[];
    } | undefined;
    createStack(stack: PromptStack, options: WebEditorCreateStackOptions): Promise<WebEditorOperationResult<{
        stack: WebEditorStackSummary;
        stacks: WebEditorStackSummary[];
    }>>;
    saveStack(id: string, stack: PromptStack): Promise<WebEditorOperationResult<{
        stack: WebEditorStackSummary;
        stacks: WebEditorStackSummary[];
    }>>;
    deleteStack(id: string): Promise<WebEditorOperationResult<{
        activeId?: string;
        stacks: WebEditorStackSummary[];
    }>>;
    validateStack(stack: PromptStack): PromptStackDiagnostic[];
    previewStack(id: string, stack: PromptStack): WebEditorOperationResult<{
        text: string;
        preview?: WebEditorPreview;
        diagnostics: PromptStackDiagnostic[];
    }>;
    getPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
    armPayload(savePath?: string): WebEditorOperationResult<WebEditorPayloadSnapshot>;
    clearPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
    activateStack(id: string): WebEditorOperationResult<{
        activeId?: string;
        stacks: WebEditorStackSummary[];
    }>;
    disableStacks(): WebEditorOperationResult<{
        activeId?: string;
        stacks: WebEditorStackSummary[];
    }>;
    reloadStacks(): Promise<WebEditorOperationResult<{
        activeId?: string;
        stacks: WebEditorStackSummary[];
    }>>;
}
export interface WebEditorProfileEntry {
    profile: AgentProfile;
    filePath: string;
    preview: AgentProfilePreview;
    errors: number;
    warnings: number;
    lastApplied: boolean;
}
export interface WebEditorProfileCollection {
    trusted: boolean;
    profileDirectory: string;
    profiles: WebEditorProfileEntry[];
    status: AgentProfileRuntimeStatus;
    models: WebEditorProfileModelOption[];
    promptStacks: Array<{
        id: string;
        name?: string;
    }>;
}
export interface WebEditorProfileModelOption {
    provider: string;
    id: string;
    name?: string;
    available: boolean;
}
export interface WebEditorProfileValidation {
    preview: AgentProfilePreview;
    diagnostics: AgentProfileDiagnostic[];
    errors: number;
    warnings: number;
}
export interface WebEditorProfileMutation {
    collection: WebEditorProfileCollection;
    selectedPath: string;
}
export interface WebEditorPreviewSection {
    id: string;
    title: string;
    role?: string;
    content: string;
    chars: number;
    approxTokens: number;
}
export interface WebEditorPreview {
    stackId: string;
    generatedAt: string;
    system: WebEditorPreviewSection;
    messages: WebEditorPreviewSection[];
    totalChars: number;
    approxTokens: number;
}
export interface WebEditorPayloadCapture {
    capturedAt: string;
    stackId?: string;
    savePath?: string;
    payload?: unknown;
    text: string;
    chars: number;
    approxTokens: number;
    truncated: boolean;
    error?: string;
}
export type WebEditorPayloadSnapshot = {
    status: "idle";
} | {
    status: "armed";
    armedAt?: string;
    savePath?: string;
} | {
    status: "captured";
    capture: WebEditorPayloadCapture;
};
export interface WebEditorCreateStackOptions {
    activate?: boolean;
    overwrite?: boolean;
}
export interface WebEditorPolicyResource {
    name: string;
    description?: string;
    source?: string;
    active?: boolean;
    hidden?: boolean;
}
export interface WebEditorPolicyResources {
    tools: WebEditorPolicyResource[];
    skills: WebEditorPolicyResource[];
}
export type WebEditorOperationResult<T> = ({
    ok: true;
} & T) | {
    ok: false;
    status?: number;
    error: string;
};
export interface WebEditorServer {
    url: string;
    port: number;
    updateHost(host: WebEditorHost): void;
    close(): Promise<void>;
}
export interface WebEditorServerOptions {
    port?: number;
}
//# sourceMappingURL=types.d.ts.map