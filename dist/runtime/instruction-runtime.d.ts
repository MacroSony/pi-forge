import { type InstructionAvailableResult, type InstructionStateGuard, type InstructionStateResult } from "../instruction-state.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ResolvedInstructionModeBinding } from "../instruction-modes.ts";
import { type ResourceKey } from "../resource-identity.ts";
import type { ForgeWorkspace } from "../workspace.ts";
import type { ToolPolicyRuntime } from "./tool-policy-runtime.ts";
export type ReadBindingsResult = {
    ok: true;
    preset: ResourceKey | null;
    bindings: readonly ResolvedInstructionModeBinding[];
} | {
    ok: false;
    error: string;
};
export type UseBoundResult = {
    ok: true;
    activationId: string;
    idempotent?: boolean;
    message: string;
} | {
    ok: false;
    error: string;
};
export type DeactivateBoundResult = {
    ok: true;
    activationId: string;
    message: string;
} | {
    ok: false;
    error: string;
};
export interface InstructionCompletionMode {
    id: string;
    label: string;
}
export interface InstructionCompletionBinding {
    id: string;
    label: string;
    modelCallable: boolean;
}
export interface InstructionCompletionActivation {
    id: string;
    label: string;
}
export type InstructionCompletionViewResult = {
    ok: true;
    trusted: boolean;
    capturedAt: string;
    modes: readonly InstructionCompletionMode[];
    bindings: readonly InstructionCompletionBinding[];
    active: readonly InstructionCompletionActivation[];
} | {
    ok: false;
    error: string;
};
/** Branch entries are authoritative. This service only coordinates the existing tool owner and delivery. */
export declare function createInstructionRuntime(pi: ExtensionAPI, workspace: ForgeWorkspace, tools: ToolPolicyRuntime): {
    prepareRestore: (ctx: ExtensionContext) => void;
    restore: (ctx: ExtensionContext, options?: {
        deferToolPolicy?: boolean;
    }) => void;
    sync: (ctx?: ExtensionContext | undefined) => void;
    prepareMessages: (raw: AgentMessage[], ctx: ExtensionContext) => AgentMessage[];
    project: (messages: AgentMessage[], ctx: ExtensionContext) => AgentMessage[];
    commitEndAnchors: (ctx: ExtensionContext) => void;
    setAgentBusy: (busy: boolean) => void;
    library: (ctx: ExtensionContext) => string;
    completionView: (ctx?: ExtensionContext) => InstructionCompletionViewResult;
    status: (ctx: ExtensionContext, includeRuleContent?: boolean) => string;
    change: (ctx: ExtensionContext, command: "add" | "use" | "use-bound" | "off" | "reset", value: string, expectedFingerprint?: string, expectedGuard?: InstructionStateGuard) => string;
    readBindings: (ctx: ExtensionContext) => ReadBindingsResult;
    useBound: (ctx: ExtensionContext, id: string, actor?: "user" | "agent", expectedFingerprint?: string, expectedGuard?: InstructionStateGuard) => UseBoundResult;
    deactivateBound: (ctx: ExtensionContext, id: string, actor?: "user" | "agent") => DeactivateBoundResult;
    executeAgentTool: (ctx: ExtensionContext, params: unknown) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
        details: unknown;
    }>;
    readState: () => InstructionStateResult;
    mutateState: (input: unknown) => InstructionStateResult;
    readAvailableInstructions: () => InstructionAvailableResult;
    useInstruction: (input: unknown) => InstructionStateResult;
    dispose: () => void;
};
export type InstructionRuntime = ReturnType<typeof createInstructionRuntime>;
//# sourceMappingURL=instruction-runtime.d.ts.map