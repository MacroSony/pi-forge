import type { InstructionMode, Diagnostic } from "../codecs/instruction-mode.ts";
import type { AgentProfile, AgentProfileDiagnostic } from "../agent-profile.ts";
import type { AgentProfilePreview, AgentProfileRuntimeStatus } from "../profile-service.ts";
import type { UiContributionTransport } from "../ui-contribution/contrib-port.ts";
import type { ContextDiffView } from "../context-diff-history.ts";
import type { InstructionAvailableResult, InstructionStateResult, InstructionStateView } from "../instruction-state.ts";
import type { PromptStack, PromptStackDiagnostic } from "../types.ts";
export interface WebEditorStackSummary {
    id: string;
    selector: string;
    scope: "global" | "project";
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
export type WebEditorLocale = "en" | "zh-CN" | "auto";
export type WebEditorModeOperation = "list" | "get" | "create" | "save" | "delete" | "effective";
export interface WebEditorInstructionModeMutation {
    changed: string;
    sourceRevision?: string;
}
export type WebEditorModeResult = WebEditorOperationResult<WebEditorInstructionModeCollection | WebEditorInstructionModeEntry | WebEditorEffectiveInstructionModes | WebEditorInstructionModeMutation>;
export interface WebEditorHost {
    modeOperation?(action: WebEditorModeOperation, selector?: string, input?: unknown): WebEditorModeResult;
    cwd: string;
    isProjectTrusted?(): boolean;
    readInstructions?(): InstructionStateResult;
    readInstructionChoices?(): InstructionAvailableResult;
    mutateInstructions?(input: unknown): InstructionStateResult;
    useInstruction?(input: unknown): InstructionStateResult;
    previewInstructions?(): WebEditorOperationResult<WebEditorSessionPreview>;
    getEditorConfig(): {
        locale: WebEditorLocale;
    };
    setEditorLocale(locale: WebEditorLocale): WebEditorOperationResult<{
        locale: WebEditorLocale;
    }>;
    listStacks(): WebEditorStackSummary[];
    listProfiles(): WebEditorProfileCollection;
    reloadProfiles(): Promise<WebEditorOperationResult<WebEditorProfileCollection>>;
    validateProfile(profile: AgentProfile, existingId?: string, scope?: "global" | "project"): WebEditorProfileValidation;
    createProfile(profile: AgentProfile, scope?: "global" | "project"): Promise<WebEditorOperationResult<WebEditorProfileMutation>>;
    saveProfile(id: string, profile: AgentProfile): Promise<WebEditorOperationResult<WebEditorProfileMutation>>;
    applyProfile(id: string): Promise<WebEditorOperationResult<WebEditorProfileMutation>>;
    deleteProfile(id: string): Promise<WebEditorOperationResult<WebEditorProfileMutation>>;
    listResources(): WebEditorResources;
    getStack(id: string): {
        stack: PromptStack;
        filePath: string;
        diagnostics: PromptStackDiagnostic[];
        sourceRevision: string;
        selector?: string;
        scope?: "global" | "project";
    } | undefined;
    createStack(stack: PromptStack, options: WebEditorCreateStackOptions): Promise<WebEditorOperationResult<{
        stack: WebEditorStackSummary;
        stacks: WebEditorStackSummary[];
    }>>;
    saveStack(id: string, stack: PromptStack, expectedSourceRevision?: string): Promise<WebEditorOperationResult<{
        stack: WebEditorStackSummary;
        stacks: WebEditorStackSummary[];
        sourceRevision: string;
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
    getContextDiff(): WebEditorOperationResult<ContextDiffView>;
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
export interface WebEditorInstructionModeEntry {
    selector: string;
    scope: "global" | "project";
    filePath: string;
    mode: InstructionMode;
    sourceRevision: string;
    diagnostics: Diagnostic[];
}
export interface WebEditorInstructionModeCollection {
    trusted: boolean;
    modes: WebEditorInstructionModeEntry[];
}
export interface WebEditorEffectiveInstructionModeBinding {
    id: string;
    ref: string;
    modelCallable: boolean;
    source: InstructionMode;
    effective: InstructionMode;
}
export interface WebEditorEffectiveInstructionModes {
    bindings: WebEditorEffectiveInstructionModeBinding[];
}
export interface WebEditorProfileEntry {
    profile: AgentProfile;
    filePath: string;
    selector: string;
    scope: "global" | "project";
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
        selector: string;
        scope: "global" | "project";
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
    /** Stable compiled-source identity used to align draft diffs across insertions. */
    diffKey?: string;
    title: string;
    role?: string;
    /** Message body only; structural fields are never synthesized into prose. */
    content: string;
    /** Native named System sections, including explicit removals (null). */
    sections?: Record<string, string | null>;
    /** Read-only instruction projection metadata; not prompt prose or executable state. */
    instructionUpdate?: {
        activationIds: string[];
        kind: "anchor" | "pending" | "checkpoint";
        throughEventId: string;
    };
    /** Recorded transcript declarations, NOT current executable tool selection. */
    toolChanges?: {
        added: Array<{
            name: string;
            description?: string;
            parameters?: unknown;
        }>;
        removed: string[];
    };
    /** Text-only counts: body plus named section values, excluding tool schemas. */
    chars: number;
    approxTokens: number;
}
export interface WebEditorPreview {
    stackId: string;
    generatedAt: string;
    system: WebEditorPreviewSection;
    messages: WebEditorPreviewSection[];
    /** Evaluated draft policy + current instruction overlays, not historical declarations. */
    selectedTools?: string[];
    totalChars: number;
    approxTokens: number;
}
export interface WebEditorSessionPreview {
    state: InstructionStateView;
    preset: {
        selector: string;
        name?: string;
    };
    text: string;
    preview: WebEditorPreview;
    diagnostics: PromptStackDiagnostic[];
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
    /** Explicit target scope. Defaults to project for unqualified web create routes. */
    scope?: "global" | "project";
}
export interface WebEditorPolicyResource {
    name: string;
    description?: string;
    source?: string;
    group?: {
        id: string;
        label: string;
    };
    /** Restorable session baseline before Preset/mode selection, for default seeding. */
    baselineActive?: boolean;
    active?: boolean;
    hidden?: boolean;
}
export interface WebEditorPolicyResources {
    tools: WebEditorPolicyResource[];
    skills: WebEditorPolicyResource[];
}
export interface WebEditorExtensionResource {
    name: string;
    description?: string;
    source?: string;
    dependencies: string[];
}
export interface WebEditorResources extends WebEditorPolicyResources {
    macros: WebEditorExtensionResource[];
    slots: WebEditorExtensionResource[];
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
    /**
     * Optional Pi event bus used to discover UI contribution providers. When
     * omitted the editor returns an empty contribution list and rejects writes.
     */
    contributionTransport?: UiContributionTransport;
    /** Timeout used for provider discovery at server start / lazy reconnect. */
    contributionDiscoverTimeoutMs?: number;
}
//# sourceMappingURL=types.d.ts.map