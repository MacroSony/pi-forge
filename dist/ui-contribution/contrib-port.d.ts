import type { FormSchema, FormValues } from "../web-editor/schema-form.ts";
/**
 * Cross-extension UI contribution port v1 over the Pi event bus.
 *
 * This is the generic, versioned RPC contract used by optional packages to
 * contribute schema-driven tabs to the pi-forge web editor. Messages are plain,
 * recursively validated, JSON-compatible data only — no functions, components,
 * live contexts, or internal registries cross the bus. The port itself is not a
 * trust boundary.
 *
 * Ownership: the contributing package owns the schema, current values, and
 * persistence/validation for its tab. The pi-forge web server only proxies
 * descriptors to the browser and writes submitted values back over the bus.
 */
export declare const UI_CONTRIBUTION_PORT_VERSION = 1;
export declare const UI_CONTRIBUTION_PORT_NAMESPACE = "@zihanw/pi-forge/ui-contribution/v1";
export declare const UI_CONTRIBUTION_PORT_OPERATIONS: readonly ["listContributions", "writeValues"];
export type UiContributionPortOperation = (typeof UI_CONTRIBUTION_PORT_OPERATIONS)[number];
export declare const UI_CONTRIBUTION_CHANNEL: {
    readonly discover: "@zihanw/pi-forge/ui-contribution/v1/discover";
    readonly available: "@zihanw/pi-forge/ui-contribution/v1/available";
    readonly request: "@zihanw/pi-forge/ui-contribution/v1/request";
    readonly reply: "@zihanw/pi-forge/ui-contribution/v1/reply";
    readonly unavailable: "@zihanw/pi-forge/ui-contribution/v1/unavailable";
};
export interface UiContributionTransport {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
export type UiContributionWireMessage = {
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
export type UiContributionPortResult = {
    ok: true;
    data: unknown;
} | {
    ok: false;
    error: string;
};
export interface UiContributionRequestContext {
    /** Aborted when the provider generation stops; handlers must check before side effects after an await. */
    signal: AbortSignal;
    generation: number;
}
export interface UiContributionProviderOptions {
    providerId?: string;
    capabilities?: readonly string[];
    minVersion?: number;
    maxVersion?: number;
    /** Operation handler; must never throw across the bus. */
    handle(operation: string, payload: unknown, context: UiContributionRequestContext): UiContributionPortResult | Promise<UiContributionPortResult>;
}
export interface UiContributionConnection {
    hostId: string;
    protocolVersion: number;
    capabilities: readonly string[];
    generation: number;
}
export interface UiContributionTabDescriptor {
    tabId: string;
    title: string;
    icon: string;
    schema: FormSchema;
    values: FormValues;
}
export interface UiListContributionsResponse {
    tabs: UiContributionTabDescriptor[];
}
export interface UiWriteValuesRequest {
    tabId: string;
    patch: FormValues;
}
export type UiWriteValuesResponse = {
    ok: true;
    values?: FormValues;
} | {
    ok: false;
    errors: Record<string, string>;
};
export type ValidationResult<T = unknown> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: string;
};
export declare class UiContributionPortError extends Error {
    readonly code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid";
    constructor(code: UiContributionPortError["code"], message: string);
}
export declare function validateListContributionsRequest(value: unknown): ValidationResult<Record<string, never>>;
export declare function validateListContributionsResponse(value: unknown): ValidationResult<UiListContributionsResponse>;
export declare function validateUiContributionTabDescriptor(value: unknown): ValidationResult<UiContributionTabDescriptor>;
export declare function validateWriteValuesRequest(value: unknown): ValidationResult<UiWriteValuesRequest>;
export declare function validateWriteValuesResponse(value: unknown): ValidationResult<UiWriteValuesResponse>;
export declare function validateFormSchema(value: unknown): ValidationResult<FormSchema>;
export declare class UiContributionProvider {
    private readonly transport;
    private readonly options;
    readonly hostId: string;
    private generationId;
    private started;
    private unsubscribers;
    private readonly pendingRequests;
    constructor(transport: UiContributionTransport, options: UiContributionProviderOptions);
    get generation(): number;
    get isLive(): boolean;
    private availableMessage;
    start(): void;
    stop(): void;
    private onDiscover;
    private onRequest;
}
export interface UiContributionClientOptions {
    clientId?: string;
    defaultTimeoutMs?: number;
    discoverSettleMs?: number;
}
export declare class UiContributionClient {
    private readonly transport;
    readonly clientId: string;
    private readonly defaultTimeoutMs;
    private readonly discoverSettleMs;
    private connectionUnsubscribe?;
    private unavailableHandlers;
    private activeConnection?;
    constructor(transport: UiContributionTransport, options?: UiContributionClientOptions);
    onUnavailable(handler: () => void): () => void;
    private teardownPersistentListener;
    private onUnavailableMessage;
    discover(timeoutMs?: number): Promise<UiContributionConnection>;
    connect(connection: UiContributionConnection): UiContributionConnection;
    request(connection: UiContributionConnection, operation: string, payload: unknown, timeoutMs?: number): Promise<UiContributionPortResult>;
    listContributions(connection: UiContributionConnection, timeoutMs?: number): Promise<UiContributionPortResult>;
    writeValues(connection: UiContributionConnection, tabId: string, patch: FormValues, timeoutMs?: number): Promise<UiContributionPortResult>;
    disconnect(): void;
    get subscriptionCount(): number;
}
//# sourceMappingURL=contrib-port.d.ts.map