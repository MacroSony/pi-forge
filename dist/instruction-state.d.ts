import type { InstructionToolPatch } from "./codecs/instruction-mode.ts";
/** A derived session view, never a second persisted instruction state. */
export interface InstructionStateGuard {
    sessionId: string;
    leafId: string | null;
    revision: string;
}
export interface InstructionStateView {
    guard: InstructionStateGuard;
    trusted: boolean;
    restoring: boolean;
    delivery: "none" | "pending" | "prepared";
    textPresentation: "native" | "user";
    effectiveTools: string[];
    problem?: string;
    active: Array<{
        activationId: string;
        source: string;
        name?: string;
        actor: "user" | "agent";
        content: string;
        tools: InstructionToolPatch;
    }>;
}
export type InstructionStateMutation = {
    action: "off";
    activationId: string;
    guard: InstructionStateGuard;
} | {
    action: "reset";
    guard: InstructionStateGuard;
};
export type InstructionStateResult = {
    ok: true;
    state: InstructionStateView;
} | {
    ok: false;
    status: number;
    error: string;
};
/** Exact input validation is shared by HTTP and direct application callers. */
export declare function isInstructionStateMutation(value: unknown): value is InstructionStateMutation;
//# sourceMappingURL=instruction-state.d.ts.map