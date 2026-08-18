/**
 * Cross-extension Forge host port v1 over the Pi event bus.
 *
 * This is the in-process RPC contract used by the optional subagent package to
 * discover the active main pi-forge host and invoke its three minimal
 * operations (discovery, profile listing, and prompt preparation). Messages
 * are plain, recursively validated, JSON-compatible data only — no functions,
 * live contexts, or internal registries cross the bus. The port itself is not
 * a trust boundary.
 *
 * Ownership: the main pi-forge host owns profiles, stacks, and prompt
 * compilation. The optional package sends resource selectors + task + backend
 * facts and receives immutable preparation artifacts back.
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
    hostId: string;
    generation: number;
    operation: string;
    payload: unknown;
} | {
    type: "reply";
    requestId: string;
    hostId: string;
    generation: number;
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
    /** Operation handler; must never throw across the bus. */
    handle(operation: string, payload: unknown): ForgeHostPortResult;
}
export interface ForgeHostConnection {
    hostId: string;
    protocolVersion: number;
    capabilities: readonly string[];
    generation: number;
}
export interface ForgeProfileSummary {
    profileId: string;
    scope: "project" | "global";
    name?: string;
    description?: string;
    autoActivate?: boolean;
    model: {
        provider: string;
        id: string;
    };
    thinkingLevel: string;
    promptStack: string | null;
    usable: boolean;
    diagnostics: Array<{
        level: string;
        message: string;
        field?: string;
    }>;
}
export interface ForgeListProfilesResponse {
    profiles: ForgeProfileSummary[];
}
/**
 * Prompt-compilation access facts only — what Forge's tool negotiation reads.
 * This intentionally is NOT the runtime `AgentRequest.access`; the optional
 * package projects its own runtime access request onto these three facts.
 */
export interface ForgePromptAccessFacts {
    level: "none" | "read-only" | "workspace-write";
    network: "deny" | "allow";
    allowProcess: boolean;
}
export interface ForgeBackendTool {
    id: string;
    name?: string;
    effects?: string[];
}
export interface ForgeBackendFacts {
    model: {
        provider: string;
        id: string;
    };
    thinkingLevel: string;
    toolCatalog: ForgeBackendTool[];
}
export interface ForgePrepareRequest {
    profile: string;
    task: {
        text: string;
    };
    access: ForgePromptAccessFacts;
    backend: ForgeBackendFacts;
}
export interface ForgePrepareResponse {
    profileId: string;
    model: {
        provider: string;
        id: string;
    };
    thinkingLevel: string;
    systemPrompt: string;
    messages: unknown[];
    effectiveToolIds: string[];
    effectiveToolNames: string[];
    diagnostics: unknown[];
    profileSnapshot: unknown;
    preparedAt: string;
}
export declare class ForgeHostPortError extends Error {
    readonly code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid";
    constructor(code: ForgeHostPortError["code"], message: string);
}
type ValidationResult = {
    ok: true;
    data: unknown;
} | {
    ok: false;
    error: string;
};
export declare function validateListProfilesRequest(value: unknown): ValidationResult;
export declare function validateListProfilesResponse(value: unknown): ValidationResult;
export declare function validatePrepareRequest(value: unknown): ValidationResult;
export declare function validatePrepareResponse(value: unknown): ValidationResult;
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
export declare class ForgeHostClient {
    private readonly transport;
    readonly clientId: string;
    private readonly defaultTimeoutMs;
    private readonly discoverSettleMs;
    private connectionUnsubscribe?;
    private unavailableHandlers;
    private activeConnection?;
    constructor(transport: ForgeHostTransport, options?: ForgeHostClientOptions);
    onUnavailable(handler: () => void): () => void;
    private teardownPersistentListener;
    private onUnavailableMessage;
    discover(timeoutMs?: number): Promise<ForgeHostConnection>;
    connect(connection: ForgeHostConnection): ForgeHostConnection;
    request(connection: ForgeHostConnection, operation: string, payload: unknown, timeoutMs?: number): Promise<ForgeHostPortResult>;
    disconnect(): void;
    get subscriptionCount(): number;
}
export {};
//# sourceMappingURL=host-port.d.ts.map