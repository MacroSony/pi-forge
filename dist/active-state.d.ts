/**
 * Neutral active-state snapshot/change bus for optional appearance/session
 * consumers.
 *
 * This module is deliberately Pi Pet-agnostic: it publishes only the small,
 * privacy-preserving scalar contract in the parent implementation contract
 * (`@zihanw/pi-forge/active-state/v1`). It never carries prompt text, file
 * paths, tokens, credentials, model configuration, tool policy, or character
 * data. Consumers are optional and must not affect Forge compilation, tool
 * policy, or provider behavior.
 */
export declare const FORGE_ACTIVE_STATE_SCHEMA_VERSION: "1";
export declare const FORGE_ACTIVE_STATE_CHANNEL = "@zihanw/pi-forge/active-state/v1";
export declare const FORGE_ACTIVE_STATE_REQUEST_CHANNEL = "@zihanw/pi-forge/active-state/request/v1";
/** Hash domain separator from the parent contract. Do not change without a new version. */
export declare const FORGE_ACTIVE_STATE_PROJECT_KEY_PREFIX = "pi-forge-project-v1\0";
/**
 * Scoped resource key grammar from the parent contract. Stricter than the
 * internal resource grammar (length-bounded, exactly one colon).
 */
export declare const FORGE_ACTIVE_STATE_SCOPED_KEY_PATTERN: RegExp;
/** Opaque lower-hex SHA-256 project key. */
export declare const FORGE_ACTIVE_STATE_PROJECT_KEY_PATTERN: RegExp;
/**
 * Bounded publisher-instance grammar shared with the downstream Pi Pet/Clawd
 * appearance consumer. UUIDs pass; control characters, path separators, and
 * other punctuation are rejected so an instance id can never look like a path
 * or smuggle control bytes across the bus.
 */
export declare const FORGE_ACTIVE_STATE_INSTANCE_ID_PATTERN: RegExp;
export declare const FORGE_ACTIVE_STATE_MAX_SESSION_ID_LENGTH = 1024;
export declare const FORGE_ACTIVE_STATE_MAX_INSTANCE_ID_LENGTH = 128;
export interface ForgeActiveStateEvent {
    schemaVersion: typeof FORGE_ACTIVE_STATE_SCHEMA_VERSION;
    /** Raw Pi session-manager ID for the session this snapshot belongs to. */
    sessionId: string;
    /** UUID refreshed per publisher attach/epoch; retired instances must be ignored. */
    instanceId: string;
    /** Monotonic safe integer within one instance. */
    revision: number;
    /** Effective scoped prompt-stack key, or null when no stack is active. */
    stackKey: string | null;
    /** Compatible applied-profile provenance key, or null (see profile rule). */
    profileKey: string | null;
    /** Opaque project key, or null. Never a raw path. */
    projectKey: string | null;
}
export interface ForgeActiveStateRequest {
    schemaVersion: typeof FORGE_ACTIVE_STATE_SCHEMA_VERSION;
    /** When present, the publisher only answers for this exact session. */
    sessionId?: string;
}
export interface ActiveStateTransport {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
export type ActiveStateValidationResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: string;
};
export interface ForgeActiveStateWorkspaceProfile {
    profileId: string;
    scope?: "global" | "project";
    /** Prompt-stack reference recorded when the profile was applied. */
    promptStack: string | null;
}
export interface ForgeActiveStateWorkspaceView {
    /** Canonical scoped key of the effective stack, or null when disabled. */
    stackKey?: string | null;
    profile?: ForgeActiveStateWorkspaceProfile | undefined;
}
export interface ForgeActiveStateSession {
    sessionId: string;
    cwd: string;
}
export interface ForgeActiveStatePublisherOptions {
    transport: ActiveStateTransport;
    /** Pure read of the current effective workspace view. Must never throw. */
    readWorkspace(): ForgeActiveStateWorkspaceView;
    /** Test seam; defaults to the OS hostname. */
    hostname?: string;
    /** Test seam; defaults to a fresh UUID per attach. */
    createInstanceId?: () => string;
}
export declare function isValidActiveStateSessionId(value: unknown): value is string;
export declare function isValidActiveStateScopedKey(value: unknown): value is string;
export declare function isValidActiveStateProjectKey(value: unknown): value is string;
export declare function isValidActiveStateInstanceId(value: unknown): value is string;
/**
 * Opaque project identity from the session working directory. The raw path and
 * hostname never leave this function; only the 64-char digest crosses the bus.
 */
export declare function activeStateProjectKey(cwd: string, hostnameValue?: string): string | null;
export declare function validateActiveStateRequest(value: unknown): ActiveStateValidationResult<ForgeActiveStateRequest>;
export declare function validateActiveStateEvent(value: unknown): ActiveStateValidationResult<ForgeActiveStateEvent>;
/**
 * Publishes active-state snapshots on the neutral channel and answers
 * late-subscriber snapshot requests. One publisher instance corresponds to one
 * attached Pi session identity; a session-id change retires the old instance
 * (after a final cleared snapshot) and attaches a new instance.
 */
export declare class ForgeActiveStatePublisher {
    private readonly transport;
    private readonly read;
    private readonly hostnameValue;
    private readonly createInstanceId;
    private sessionValue?;
    private instanceIdValue?;
    private revisionValue;
    private requestUnsubscribe?;
    private requestListenerAttached;
    private suspended;
    constructor(options: ForgeActiveStatePublisherOptions);
    get attached(): boolean;
    get sessionId(): string | undefined;
    get instanceId(): string | undefined;
    get revision(): number;
    /**
     * Pause publication and request replies while a lifecycle restore is in
     * flight. The workspace publishes several intermediate snapshots during
     * `restoreBranchScopedRuntime`; emitting those would leak the new workspace
     * under the old session id before the publisher is rebound. Call
     * `bindSession` once the restore is complete to resume with the latest
     * coherent snapshot.
     */
    suspend(): void;
    /** Bind or rebind the Pi session, resume publication, and publish the current snapshot. */
    bindSession(session: ForgeActiveStateSession): void;
    /** Publish the current workspace view with a fresh revision. */
    publish(): void;
    /**
     * Emit one final cleared snapshot for the bound session, unregister the
     * request listener, and detach. Safe to call more than once.
     */
    dispose(): void;
    private ensureRequestListener;
    private unsubscribeRequest;
    private onRequest;
    private buildEvent;
    private buildClearEvent;
    private emitEvent;
    private readSafely;
    private advanceEpoch;
}
//# sourceMappingURL=active-state.d.ts.map