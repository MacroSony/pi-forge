import { type AgentProfileProvenance, type LoadedAgentProfile } from "./agent-profile.ts";
import type { LoadedPromptStack } from "./types.ts";
import { ForgeHost, type ForgeHostPortResult, type ForgeHostTransport } from "./subagent/host-port.ts";
export interface ForgeWorkspaceSnapshot {
    cwd: string;
    stacks: readonly LoadedPromptStack[];
    profiles: readonly LoadedAgentProfile[];
    activeStackId: string | null;
    lastAppliedProfile?: AgentProfileProvenance;
    capturedAt: string;
}
export interface ForgeWorkspaceStateSources {
    activeStackId?(): string | null;
    lastAppliedProfile?(): AgentProfileProvenance | undefined;
}
/**
 * Minimal snapshot owner over the Lane 2a repositories/codecs. Owns one
 * genuinely immutable resource snapshot (scoped stack/profile catalogs plus
 * active selection/provenance references) and the host-port registration for
 * that snapshot. Reloads replace the whole snapshot; dispose tears down the
 * host.
 */
export declare class ForgeWorkspace {
    private readonly sources;
    private current?;
    private host?;
    constructor(sources?: ForgeWorkspaceStateSources);
    get snapshotKnown(): boolean;
    reload(cwd: string, options?: {
        trusted?: boolean;
    }): ForgeWorkspaceSnapshot;
    snapshot(): ForgeWorkspaceSnapshot;
    /**
     * Register the host port for the current snapshot. Idempotent: the host is
     * only started once the first snapshot exists, so `available` never implies
     * an unloaded workspace. On reload the live host is kept (its generation
     * only changes via dispose).
     */
    startHostPort(transport: ForgeHostTransport): ForgeHost;
    /** Invoke the minimal-operation surface against the current snapshot. */
    operate(operation: string, payload: unknown): ForgeHostPortResult;
    private listProfiles;
    private resolveProfile;
    /** Host-owned profile resolution returns the immutable AgentProfileSnapshot artifact. */
    private resolveProfilePlan;
    private prepare;
    /** Host owns profile/stack resolution and prompt compilation. */
    private preparePlan;
    dispose(): void;
}
//# sourceMappingURL=workspace.d.ts.map