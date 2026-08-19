import { type AgentProfileProvenance, type LoadedAgentProfile } from "./agent-profile.ts";
import type { LoadedPromptStack, PromptStackDiagnostic } from "./types.ts";
import { ForgeHost, type ForgeHostPortResult, type ForgeHostTransport } from "./subagent/host-port.ts";
export interface ForgeWorkspaceSnapshot {
    cwd: string;
    stacks: readonly LoadedPromptStack[];
    profiles: readonly LoadedAgentProfile[];
    activeStackId: string | null;
    active?: LoadedPromptStack;
    lastAppliedProfile?: AgentProfileProvenance;
    extensionDiagnostics: readonly PromptStackDiagnostic[];
    extensionPaths: readonly string[];
    capturedAt: string;
}
export interface ForgeWorkspaceReloadOptions {
    trusted?: boolean;
    activeStackId?: string | null;
    lastAppliedProfile?: AgentProfileProvenance;
    suppressAutoActivate?: boolean;
}
/**
 * Single owner of the Forge resource graph.
 *
 * Owns one coherent, deep-frozen snapshot containing stacks, profiles, active
 * selection, profile provenance, and extension lifecycle state. All readers
 * (commands, web UI, lifecycle, tool policy, preview, host port) consume
 * `snapshot()` instead of separate mutable bags.
 */
export declare class ForgeWorkspace {
    private readonly extensionState;
    private current?;
    private host?;
    get snapshotKnown(): boolean;
    reload(cwd: string, options?: ForgeWorkspaceReloadOptions): ForgeWorkspaceSnapshot;
    reloadProfiles(cwd: string, trusted?: boolean): ForgeWorkspaceSnapshot;
    loadExtensions(cwd: string): Promise<{
        diagnostics: PromptStackDiagnostic[];
        loadedPaths: string[];
    }>;
    disposeExtensions(): PromptStackDiagnostic[];
    setActiveStack(id: string | undefined): boolean;
    setLastAppliedProfile(profile: AgentProfileProvenance | undefined): void;
    get active(): LoadedPromptStack | undefined;
    set active(value: LoadedPromptStack | undefined);
    get lastAppliedProfile(): AgentProfileProvenance | undefined;
    set lastAppliedProfile(value: AgentProfileProvenance | undefined);
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
    private resolveActive;
    private publish;
    private get extensionDiagnostics();
    private set extensionDiagnostics(value);
    private get extensionPaths();
    private set extensionPaths(value);
    private extensionDiagnosticsValue;
    private extensionPathsValue;
}
//# sourceMappingURL=workspace.d.ts.map