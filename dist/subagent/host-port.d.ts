import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SubagentFingerprint } from "./fingerprints.ts";
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
export declare const FORGE_HOST_PORT_OPERATIONS: readonly ["listProfiles", "resolveProfile", "prepare"];
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
 * Wire diagnostic shape for delegation resolution and preparation.
 * Structurally compatible with the optional package's `SubagentDiagnostic`.
 */
export interface ForgeDelegationDiagnostic {
    level: "error" | "warning" | "info";
    code: string;
    message: string;
    path?: string;
}
/** Host-compiled delegation message as carried over the wire (text-only). */
export interface ForgeDelegationMessage {
    role: "user" | "assistant" | "custom";
    content: Array<{
        type: "text";
        text: string;
    }>;
    protectedTask?: boolean;
    source?: "prompt-stack" | "delegated-task";
}
export type ForgePromptDependencyKind = "macro" | "slot";
export interface ForgePromptDependency {
    kind: ForgePromptDependencyKind;
    name: string;
    identity: string;
    source?: string;
}
/**
 * Minimal structural mirror of the host-owned agent profile carried over the
 * wire. The host owns the schema: at runtime extra fields may pass through for
 * forward compatibility, but consumers must only rely on the fields below.
 */
export interface ForgeWireAgentProfile {
    schemaVersion: 1;
    type: string;
    id: string;
    name?: string;
    description?: string;
    autoActivate?: boolean;
    model: {
        provider: string;
        id: string;
    };
    thinkingLevel: ThinkingLevel;
    promptStack: string | null;
}
/**
 * Minimal structural mirror of the host-owned prompt stack carried over the
 * wire. Same forward-compat rule as ForgeWireAgentProfile.
 */
export interface ForgeWirePromptStack {
    id: string;
    tools?: {
        allow?: string[];
        deny?: never;
    } | {
        allow?: never;
        deny?: string[];
    };
}
/**
 * Immutable host-owned profile snapshot artifact returned by `resolveProfile`
 * and embedded in `prepare` responses. The wire schema version is shared with
 * the optional package's `AgentProfileSnapshot` by design.
 */
export interface ForgeProfileSnapshot {
    schemaVersion: 1;
    /** Canonical scoped selector of the resolved profile (`project:<id>` or `global:<id>`). */
    profileId: string;
    profile: ForgeWireAgentProfile;
    /** Canonical scoped selector of the resolved prompt stack, or null. */
    promptStackId: string | null;
    promptStack: ForgeWirePromptStack | null;
    dependencies: ForgePromptDependency[];
    profileFingerprint: SubagentFingerprint;
    promptStackFingerprint: SubagentFingerprint | null;
}
export interface ForgeResolveProfileRequest {
    profile: string;
}
export interface ForgeResolveProfileResponse {
    /** Immutable host-owned AgentProfileSnapshot artifact (profile + stack + fingerprints). */
    snapshot: ForgeProfileSnapshot;
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
    messages: ForgeDelegationMessage[];
    effectiveToolIds: string[];
    effectiveToolNames: string[];
    diagnostics: ForgeDelegationDiagnostic[];
    profileSnapshot: ForgeProfileSnapshot;
    preparedAt: string;
}
export declare class ForgeHostPortError extends Error {
    readonly code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid";
    constructor(code: ForgeHostPortError["code"], message: string);
}
export type ValidationResult<T = unknown> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: string;
};
export declare function validateListProfilesRequest(value: unknown): ValidationResult<Record<string, never>>;
export declare function validateListProfilesResponse(value: unknown): ValidationResult<ForgeListProfilesResponse>;
export declare function validateResolveProfileRequest(value: unknown): ValidationResult<ForgeResolveProfileRequest>;
export declare function validateResolveProfileResponse(value: unknown): ValidationResult<ForgeResolveProfileResponse>;
export declare function validatePrepareRequest(value: unknown): ValidationResult<ForgePrepareRequest>;
export declare function validatePrepareResponse(value: unknown): ValidationResult<ForgePrepareResponse>;
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
//# sourceMappingURL=host-port.d.ts.map