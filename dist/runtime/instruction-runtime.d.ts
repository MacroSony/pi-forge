import { type InstructionStateResult } from "../instruction-state.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ForgeWorkspace } from "../workspace.ts";
import type { ToolPolicyRuntime } from "./tool-policy-runtime.ts";
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
    status: (ctx: ExtensionContext) => string;
    change: (ctx: ExtensionContext, command: "add" | "use" | "off" | "reset", value: string) => string;
    readState: () => InstructionStateResult;
    mutateState: (input: unknown) => InstructionStateResult;
    dispose: () => void;
};
export type InstructionRuntime = ReturnType<typeof createInstructionRuntime>;
//# sourceMappingURL=instruction-runtime.d.ts.map