/**
 * Cross-extension Forge host port v1 over the Pi event bus.
 *
 * This is the in-process RPC contract used by the optional subagent package to
 * discover the active main pi-forge host and invoke its three minimal
 * operations (discovery, profile listing/snapshot, and prompt preparation).
 * Messages are plain validated data only — no functions, live contexts, or
 * internal registries cross the bus. The port itself is not a trust boundary.
 */
export declare const FORGE_HOST_PORT_VERSION = 1;
export declare const FORGE_HOST_PORT_NAMESPACE = "@zihanw/pi-forge/host/v1";
export declare const FORGE_HOST_PORT_OPERATIONS: readonly ["listProfiles", "prepare"];
export type ForgeHostPortOperation = (typeof FORGE_HOST_PORT_OPERATIONS)[number];
export declare const FORGE_HOST_CHANNEL: {
    readonly discover: "@zihanw/pi-forge/host/v1/discover";
    readonly available: "@zihanw/pi-forge/host/v1/available";
    readonly request: "@zihanw/pi-forge/host/v1/request";
    readonly reply: "@zihanw/pi-forge/host/v1/reply";
    readonly unavailable: "@zihanw/pi-forge/host/v1/unavailable";
};
export interface ForgeHostTransport {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
export type ForgeHostWireMessage = {
    type: "discover";
    protocolVersion: number;
    minVersion: number;
    maxVersion: number;
    clientId: string;
} | {
    type: "available";
    hostId: string;
    protocolVersion: number;
    minVersion: number;
    maxVersion: number;
    capabilities: string[];
    generation: number;
} | {
    type: "request";
    requestId: string;
    operation: string;
    payload: unknown;
} | {
    type: "reply";
    requestId: string;
    ok: boolean;
    data?: unknown;
    error?: string;
} | {
    type: "unavailable";
    hostId: string;
    generation: number;
};
export type ForgeHostPortResult = {
    ok: true;
    data: unknown;
} | {
    ok: false;
    error: string;
};
export interface ForgeHostOptions {
    hostId?: string;
    capabilities?: readonly string[];
    minVersion?: number;
    maxVersion?: number;
    /** Operation handlers; must never throw across the bus. */
    handle(operation: string, payload: unknown): ForgeHostPortResult;
}
export interface ForgeHostConnection {
    hostId: string;
    protocolVersion: number;
    capabilities: readonly string[];
    generation: number;
}
export declare class ForgeHostPortError extends Error {
    readonly code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid";
    constructor(code: ForgeHostPortError["code"], message: string);
}
/** Host side: registers discover/request listeners and owns generation + disposal. */
export declare class ForgeHost {
    private readonly transport;
    private readonly options;
    readonly hostId: string;
    private generationId;
    private started;
    private unsubscribers;
    constructor(transport: ForgeHostTransport, options: ForgeHostOptions);
    get generation(): number;
    get isLive(): boolean;
    private availableMessage;
    start(): void;
    stop(): void;
    private onDiscover;
    private onRequest;
}
export interface ForgeHostClientOptions {
    clientId?: string;
    defaultTimeoutMs?: number;
    /** How long after the first compatible host reply to keep collecting others before deciding. */
    discoverSettleMs?: number;
}
/** Client side: bounded-discovery, correlation-based requests, and listener cleanup. */
export declare class ForgeHostClient {
    private readonly transport;
    readonly clientId: string;
    private readonly defaultTimeoutMs;
    private readonly discoverSettleMs;
    private connectionUnsubscribe?;
    private unavailableHandlers;
    private activeConnection?;
    constructor(transport: ForgeHostTransport, options?: ForgeHostClientOptions);
    /** Subscribe to host-disposal events until disconnect(). */
    onUnavailable(handler: () => void): () => void;
    private teardownPersistentListener;
    private onUnavailableMessage;
    /** Discover a single compatible host; duplicate hosts or timeout fail explicitly. */
    discover(timeoutMs?: number): Promise<ForgeHostConnection>;
    /** Attach to a discovered host; subscriptions for disposal are held until disconnect(). */
    connect(connection: ForgeHostConnection): ForgeHostConnection;
    /** Invoke a documented operation with correlation and a bounded timeout. */
    request(connection: ForgeHostConnection, operation: string, payload: unknown, timeoutMs?: number): Promise<ForgeHostPortResult>;
    /** Disconnect: drop all subscriptions and forget the active connection. */
    disconnect(): void;
    /** Number of persistent bus subscriptions owned by this client (for cleanup tests). */
    get subscriptionCount(): number;
}
//# sourceMappingURL=host-port.d.ts.map