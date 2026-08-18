import { randomUUID } from "node:crypto";
/**
 * Cross-extension Forge host port v1 over the Pi event bus.
 *
 * This is the in-process RPC contract used by the optional subagent package to
 * discover the active main pi-forge host and invoke its three minimal
 * operations (discovery, profile listing/snapshot, and prompt preparation).
 * Messages are plain validated data only — no functions, live contexts, or
 * internal registries cross the bus. The port itself is not a trust boundary.
 */
export const FORGE_HOST_PORT_VERSION = 1;
export const FORGE_HOST_PORT_NAMESPACE = "@zihanw/pi-forge/host/v1";
export const FORGE_HOST_PORT_OPERATIONS = ["listProfiles", "prepare"];
export const FORGE_HOST_CHANNEL = {
    discover: `${FORGE_HOST_PORT_NAMESPACE}/discover`,
    available: `${FORGE_HOST_PORT_NAMESPACE}/available`,
    request: `${FORGE_HOST_PORT_NAMESPACE}/request`,
    reply: `${FORGE_HOST_PORT_NAMESPACE}/reply`,
    unavailable: `${FORGE_HOST_PORT_NAMESPACE}/unavailable`,
};
const DEFAULT_CLIENT_TIMEOUT_MS = 2_000;
export class ForgeHostPortError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function normalizeHostResult(result) {
    if (isRecord(result) && result.ok === true) {
        return { ok: true, data: result.data };
    }
    if (isRecord(result) && result.ok === false) {
        return { ok: false, error: typeof result.error === "string" && result.error ? result.error : "Forge host operation failed." };
    }
    return { ok: false, error: "Forge host returned a malformed operation result." };
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function versionCompatible(hostMin, hostMax, wantMin, wantMax) {
    return hostMax >= wantMin && wantMax >= hostMin;
}
function parseDiscover(data) {
    if (!isRecord(data) || data.type !== "discover")
        return undefined;
    const { protocolVersion, minVersion, maxVersion, clientId } = data;
    if (typeof protocolVersion !== "number"
        || typeof minVersion !== "number"
        || typeof maxVersion !== "number"
        || typeof clientId !== "string") {
        return undefined;
    }
    return { type: "discover", protocolVersion, minVersion, maxVersion, clientId };
}
function parseRequest(data) {
    if (!isRecord(data) || data.type !== "request")
        return undefined;
    const { requestId, operation, payload } = data;
    if (typeof requestId !== "string" || typeof operation !== "string")
        return undefined;
    return { type: "request", requestId, operation, payload };
}
function parseAvailable(data) {
    if (!isRecord(data) || data.type !== "available")
        return undefined;
    const { hostId, protocolVersion, minVersion, maxVersion, capabilities, generation } = data;
    if (typeof hostId !== "string"
        || typeof protocolVersion !== "number"
        || typeof minVersion !== "number"
        || typeof maxVersion !== "number"
        || !Array.isArray(capabilities)
        || capabilities.some((cap) => typeof cap !== "string")
        || typeof generation !== "number") {
        return undefined;
    }
    return { type: "available", hostId, protocolVersion, minVersion, maxVersion, capabilities, generation };
}
function parseReply(data) {
    if (!isRecord(data) || data.type !== "reply")
        return undefined;
    const { requestId, ok } = data;
    if (typeof requestId !== "string" || typeof ok !== "boolean")
        return undefined;
    return {
        type: "reply",
        requestId,
        ok,
        data: ok ? data.data : undefined,
        error: ok ? undefined : typeof data.error === "string" ? data.error : undefined,
    };
}
function parseUnavailable(data) {
    if (!isRecord(data) || data.type !== "unavailable")
        return undefined;
    const { hostId, generation } = data;
    if (typeof hostId !== "string" || typeof generation !== "number")
        return undefined;
    return { type: "unavailable", hostId, generation };
}
/** Host side: registers discover/request listeners and owns generation + disposal. */
export class ForgeHost {
    transport;
    options;
    hostId;
    generationId = 1;
    started = false;
    unsubscribers = [];
    constructor(transport, options) {
        this.transport = transport;
        this.options = options;
        this.hostId = options.hostId ?? `forge-host-${randomUUID()}`;
    }
    get generation() {
        return this.generationId;
    }
    get isLive() {
        return this.started;
    }
    availableMessage() {
        return {
            type: "available",
            hostId: this.hostId,
            protocolVersion: FORGE_HOST_PORT_VERSION,
            minVersion: this.options.minVersion ?? FORGE_HOST_PORT_VERSION,
            maxVersion: this.options.maxVersion ?? FORGE_HOST_PORT_VERSION,
            capabilities: [...(this.options.capabilities ?? FORGE_HOST_PORT_OPERATIONS)],
            generation: this.generationId,
        };
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.unsubscribers.push(this.transport.on(FORGE_HOST_CHANNEL.discover, (data) => this.onDiscover(data)));
        this.unsubscribers.push(this.transport.on(FORGE_HOST_CHANNEL.request, (data) => this.onRequest(data)));
        // Announce so already-subscribed clients learn about this host.
        this.transport.emit(FORGE_HOST_CHANNEL.available, this.availableMessage());
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        // Unsubscribe first so a client handler that throws cannot abort teardown
        // or leave discover/request listeners registered.
        for (const unsubscribe of this.unsubscribers.splice(0))
            unsubscribe();
        this.transport.emit(FORGE_HOST_CHANNEL.unavailable, {
            type: "unavailable",
            hostId: this.hostId,
            generation: this.generationId,
        });
        this.generationId += 1;
    }
    onDiscover(data) {
        if (!this.started)
            return;
        const message = parseDiscover(data);
        if (!message || message.protocolVersion !== FORGE_HOST_PORT_VERSION)
            return;
        if (!versionCompatible(this.options.minVersion ?? FORGE_HOST_PORT_VERSION, this.options.maxVersion ?? FORGE_HOST_PORT_VERSION, message.minVersion, message.maxVersion)) {
            return;
        }
        this.transport.emit(FORGE_HOST_CHANNEL.available, this.availableMessage());
    }
    onRequest(data) {
        if (!this.started)
            return;
        const message = parseRequest(data);
        if (!message)
            return;
        let result;
        try {
            result = typeof this.options.handle === "function"
                ? this.options.handle(message.operation, message.payload)
                : { ok: false, error: "Forge host has no operation handler." };
        }
        catch (error) {
            result = {
                ok: false,
                error: `Forge host operation threw: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        this.transport.emit(FORGE_HOST_CHANNEL.reply, {
            ...normalizeHostResult(result),
            requestId: message.requestId,
            type: "reply",
        });
    }
}
/** Client side: bounded-discovery, correlation-based requests, and listener cleanup. */
export class ForgeHostClient {
    transport;
    clientId;
    defaultTimeoutMs;
    discoverSettleMs;
    connectionUnsubscribe;
    unavailableHandlers = [];
    activeConnection;
    constructor(transport, options = {}) {
        this.transport = transport;
        this.clientId = options.clientId ?? `forge-client-${randomUUID()}`;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
        this.discoverSettleMs = options.discoverSettleMs ?? 25;
    }
    /** Subscribe to host-disposal events until disconnect(). */
    onUnavailable(handler) {
        if (this.connectionUnsubscribe === undefined) {
            this.connectionUnsubscribe = this.transport.on(FORGE_HOST_CHANNEL.unavailable, (data) => this.onUnavailableMessage(data));
        }
        this.unavailableHandlers.push(handler);
        let removed = false;
        return () => {
            if (removed)
                return;
            removed = true;
            const index = this.unavailableHandlers.indexOf(handler);
            if (index !== -1)
                this.unavailableHandlers.splice(index, 1);
            // Keep the persistent listener while connected so later requests still
            // observe disposal; only release it when nothing is waiting on it.
            if (this.unavailableHandlers.length === 0 && this.activeConnection === undefined) {
                this.teardownPersistentListener();
            }
        };
    }
    teardownPersistentListener() {
        if (this.connectionUnsubscribe !== undefined) {
            this.connectionUnsubscribe();
            this.connectionUnsubscribe = undefined;
        }
    }
    onUnavailableMessage(data) {
        const message = parseUnavailable(data);
        if (!message)
            return;
        if (this.activeConnection && message.hostId === this.activeConnection.hostId && message.generation === this.activeConnection.generation) {
            this.activeConnection = undefined;
            for (const handler of [...this.unavailableHandlers]) {
                try {
                    handler();
                }
                catch {
                    // A throwing client handler must not break host disposal dispatch.
                }
            }
        }
    }
    /** Discover a single compatible host; duplicate hosts or timeout fail explicitly. */
    async discover(timeoutMs) {
        const expectedTimeout = timeoutMs ?? this.defaultTimeoutMs;
        return new Promise((resolve, reject) => {
            const hosts = new Map();
            let settled = false;
            let timer;
            let settleTimer;
            const settle = (error, connection) => {
                if (settled)
                    return;
                settled = true;
                if (timer !== undefined)
                    clearTimeout(timer);
                if (settleTimer !== undefined)
                    clearTimeout(settleTimer);
                unsubscribeAll();
                if (error)
                    reject(error);
                else
                    resolve(connection);
            };
            const onAvailable = (data) => {
                const message = parseAvailable(data);
                if (!message || message.protocolVersion !== FORGE_HOST_PORT_VERSION)
                    return;
                if (!versionCompatible(FORGE_HOST_PORT_VERSION, FORGE_HOST_PORT_VERSION, message.minVersion, message.maxVersion)) {
                    return;
                }
                const existing = hosts.get(message.hostId);
                if (!existing || existing.generation !== message.generation) {
                    hosts.set(message.hostId, {
                        hostId: message.hostId,
                        protocolVersion: message.protocolVersion,
                        capabilities: message.capabilities,
                        generation: message.generation,
                    });
                }
                if (hosts.size > 1) {
                    settle(new ForgeHostPortError("duplicate", "Multiple compatible Forge hosts are live."));
                    return;
                }
                // Keep collecting for a short window so a second live host cannot be
                // silently skipped by load order; seeing one host resolves here.
                if (settleTimer === undefined) {
                    settleTimer = setTimeout(() => settle(undefined, hosts.values().next().value), this.discoverSettleMs);
                }
            };
            const unsubAvailable = this.transport.on(FORGE_HOST_CHANNEL.available, onAvailable);
            const unsubUnavailable = this.transport.on(FORGE_HOST_CHANNEL.unavailable, (data) => {
                const message = parseUnavailable(data);
                const known = message ? hosts.get(message.hostId) : undefined;
                if (known && message && message.generation === known.generation) {
                    settle(new ForgeHostPortError("unavailable", `Forge host ${message.hostId} became unavailable during discovery.`));
                }
            });
            const unsubscribeAll = () => {
                unsubAvailable();
                unsubUnavailable();
            };
            timer = setTimeout(() => settle(new ForgeHostPortError("timeout", "Forge host discovery timed out.")), expectedTimeout);
            this.transport.emit(FORGE_HOST_CHANNEL.discover, {
                type: "discover",
                protocolVersion: FORGE_HOST_PORT_VERSION,
                minVersion: FORGE_HOST_PORT_VERSION,
                maxVersion: FORGE_HOST_PORT_VERSION,
                clientId: this.clientId,
            });
        });
    }
    /** Attach to a discovered host; subscriptions for disposal are held until disconnect(). */
    connect(connection) {
        if (this.activeConnection && this.activeConnection.hostId !== connection.hostId) {
            throw new ForgeHostPortError("duplicate", "This client is already connected to another Forge host.");
        }
        this.activeConnection = connection;
        if (this.connectionUnsubscribe === undefined) {
            this.connectionUnsubscribe = this.transport.on(FORGE_HOST_CHANNEL.unavailable, (data) => this.onUnavailableMessage(data));
        }
        return connection;
    }
    /** Invoke a documented operation with correlation and a bounded timeout. */
    async request(connection, operation, payload, timeoutMs) {
        if (this.activeConnection !== connection) {
            return { ok: false, error: `Forge host ${connection.hostId} is not the client's active connection.` };
        }
        if (!FORGE_HOST_PORT_OPERATIONS.includes(operation)) {
            return { ok: false, error: `Unknown Forge host operation: ${operation}` };
        }
        const requestId = randomUUID();
        const expectedTimeout = timeoutMs ?? this.defaultTimeoutMs;
        return new Promise((resolve) => {
            const unsubscribeReply = this.transport.on(FORGE_HOST_CHANNEL.reply, (data) => {
                const message = parseReply(data);
                if (!message || message.requestId !== requestId)
                    return;
                cleanup();
                if (message.ok)
                    resolve({ ok: true, data: message.data });
                else
                    resolve({ ok: false, error: message.error ?? "Forge host operation failed." });
            });
            const unsubscribeUnavailable = this.transport.on(FORGE_HOST_CHANNEL.unavailable, (data) => {
                const message = parseUnavailable(data);
                if (message && message.hostId === connection.hostId && message.generation === connection.generation) {
                    cleanup();
                    resolve({ ok: false, error: `Forge host ${connection.hostId} became unavailable.` });
                }
            });
            let timer;
            const cleanup = () => {
                if (timer !== undefined)
                    clearTimeout(timer);
                unsubscribeReply();
                unsubscribeUnavailable();
            };
            timer = setTimeout(() => {
                cleanup();
                resolve({ ok: false, error: `Forge host operation ${operation} timed out.` });
            }, expectedTimeout);
            this.transport.emit(FORGE_HOST_CHANNEL.request, { type: "request", requestId, operation, payload });
        });
    }
    /** Disconnect: drop all subscriptions and forget the active connection. */
    disconnect() {
        this.activeConnection = undefined;
        this.teardownPersistentListener();
        this.unavailableHandlers = [];
    }
    /** Number of persistent bus subscriptions owned by this client (for cleanup tests). */
    get subscriptionCount() {
        return this.connectionUnsubscribe === undefined ? 0 : 1;
    }
}
//# sourceMappingURL=host-port.js.map