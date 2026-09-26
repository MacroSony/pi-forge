import { type CapabilityAvailableResult, type CapabilityStateGuard, type CapabilityStateResult } from "../capability-state.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ResolvedCapabilityBinding } from "../capabilities.ts";
import { type ResourceKey } from "../resource-identity.ts";
import type { ForgeWorkspace } from "../workspace.ts";
import type { ToolPolicyRuntime } from "./tool-policy-runtime.ts";
export type ReadBindingsResult = {
    ok: true;
    preset: ResourceKey | null;
    bindings: readonly ResolvedCapabilityBinding[];
} | {
    ok: false;
    error: string;
};
export type EnableBoundResult = {
    ok: true;
    activationId: string;
    idempotent?: boolean;
    message: string;
} | {
    ok: false;
    error: string;
};
export type DisableBoundResult = {
    ok: true;
    activationId: string;
    message: string;
} | {
    ok: false;
    error: string;
};
export interface CapabilityCompletionCapability {
    id: string;
    bareId: string;
    label: string;
    collides: boolean;
}
export interface CapabilityCompletionBinding {
    id: string;
    label: string;
    modelCallable: boolean;
}
export interface CapabilityCompletionActivation {
    id: string;
    label: string;
}
export type CapabilityCompletionViewResult = {
    ok: true;
    trusted: boolean;
    capturedAt: string;
    capabilities: readonly CapabilityCompletionCapability[];
    bindings: readonly CapabilityCompletionBinding[];
    active: readonly CapabilityCompletionActivation[];
} | {
    ok: false;
    error: string;
};
/** Branch entries are authoritative. This service only coordinates the existing tool owner and delivery. */
export declare function createCapabilityRuntime(pi: ExtensionAPI, workspace: ForgeWorkspace, tools: ToolPolicyRuntime): {
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
    completionView: (ctx?: ExtensionContext) => CapabilityCompletionViewResult;
    status: (ctx: ExtensionContext, includeRuleContent?: boolean) => string;
    change: (ctx: ExtensionContext, command: "add" | "enable" | "enable-bound" | "disable" | "reset", value: string, expectedFingerprint?: string, expectedGuard?: CapabilityStateGuard) => string;
    readBindings: (ctx: ExtensionContext) => ReadBindingsResult;
    enableBound: (ctx: ExtensionContext, id: string, actor?: "user" | "agent", expectedFingerprint?: string, expectedGuard?: CapabilityStateGuard) => EnableBoundResult;
    disableBound: (ctx: ExtensionContext, id: string, actor?: "user" | "agent") => DisableBoundResult;
    executeAgentTool: (ctx: ExtensionContext, params: unknown) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
        details: unknown;
    }>;
    readState: () => CapabilityStateResult;
    mutateState: (input: unknown) => CapabilityStateResult;
    readAvailableCapabilities: () => CapabilityAvailableResult;
    enableCapability: (input: unknown) => CapabilityStateResult;
    dispose: () => void;
};
export type CapabilityRuntime = ReturnType<typeof createCapabilityRuntime>;
//# sourceMappingURL=capability-runtime.d.ts.map