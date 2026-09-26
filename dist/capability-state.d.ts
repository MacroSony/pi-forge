import type { CapabilityToolPatch } from "./codecs/capability.ts";
import type { SessionCacheUsageView } from "./session-usage.ts";
/** A derived session view, never a second persisted capability state. */
export interface CapabilityStateGuard {
    sessionId: string;
    leafId: string | null;
    revision: string;
}
export interface CapabilityChoice {
    kind: "capability" | "binding";
    id: string;
    label: string;
    content: string;
    tools: CapabilityToolPatch;
    fingerprint: string;
    problem?: string;
}
export interface CapabilityStateView {
    guard: CapabilityStateGuard;
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
        tools: CapabilityToolPatch;
    }>;
}
export type CapabilityStateMutation = {
    action: "disable";
    activationId: string;
    guard: CapabilityStateGuard;
} | {
    action: "reset";
    guard: CapabilityStateGuard;
};
export interface CapabilityEnableRequest {
    guard: CapabilityStateGuard;
    kind: "capability" | "binding";
    id: string;
    fingerprint: string;
}
export type CapabilityAvailableResult = {
    ok: true;
    state: CapabilityStateView;
    choices: CapabilityChoice[];
} | {
    ok: false;
    status: number;
    error: string;
};
export type CapabilityStateResult = {
    ok: true;
    state: CapabilityStateView;
} | {
    ok: false;
    status: number;
    error: string;
};
/** Exact input validation is shared by HTTP and direct application callers. */
export declare function isCapabilityStateMutation(value: unknown): value is CapabilityStateMutation;
/** Exact validation for the guarded, human-only activation operation. */
export declare function isCapabilityEnableRequest(value: unknown): value is CapabilityEnableRequest;
//# sourceMappingURL=capability-state.d.ts.map