import type { InstructionToolPatch } from "./codecs/instruction-mode.ts";
import type { SessionCacheUsageView } from "./session-usage.ts";
/** A derived session view, never a second persisted instruction state. */
export interface InstructionStateGuard {
    sessionId: string;
    leafId: string | null;
    revision: string;
}
export interface InstructionChoice {
    kind: "mode" | "binding";
    id: string;
    label: string;
    content: string;
    tools: InstructionToolPatch;
    fingerprint: string;
    problem?: string;
}
export interface InstructionStateView {
    guard: InstructionStateGuard;
    /** Active loaded Preset fingerprint for inspection freshness, not a write receipt. */
    presetRevision?: string;
    trusted: boolean;
    restoring: boolean;
    delivery: "none" | "pending" | "prepared";
    textPresentation: "native" | "user";
    effectiveTools: string[];
    /** Read-only provider-reported usage for the current branch; absent when unavailable. */
    cacheUsage?: SessionCacheUsageView;
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
export interface InstructionUseRequest {
    guard: InstructionStateGuard;
    kind: "mode" | "binding";
    id: string;
    fingerprint: string;
}
export type InstructionAvailableResult = {
    ok: true;
    state: InstructionStateView;
    choices: InstructionChoice[];
} | {
    ok: false;
    status: number;
    error: string;
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
/** Exact validation for the guarded, human-only activation operation. */
export declare function isInstructionUseRequest(value: unknown): value is InstructionUseRequest;
//# sourceMappingURL=instruction-state.d.ts.map