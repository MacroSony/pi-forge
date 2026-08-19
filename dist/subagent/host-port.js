import { randomUUID } from "node:crypto";
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
export const FORGE_HOST_PORT_VERSION = 1;
export const FORGE_HOST_PORT_NAMESPACE = "@zihanw/pi-forge/host/v1";
export const FORGE_HOST_PORT_OPERATIONS = ["listProfiles", "resolveProfile", "prepare"];
export const FORGE_HOST_CHANNEL = {
    discover: `${FORGE_HOST_PORT_NAMESPACE}/discover`,
    available: `${FORGE_HOST_PORT_NAMESPACE}/available`,
    request: `${FORGE_HOST_PORT_NAMESPACE}/request`,
    reply: `${FORGE_HOST_PORT_NAMESPACE}/reply`,
    unavailable: `${FORGE_HOST_PORT_NAMESPACE}/unavailable`,
};
// ---------------------------------------------------------------------------
// Errors and validation.
// ---------------------------------------------------------------------------
export class ForgeHostPortError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function validateListProfilesRequest(value) {
    if (value === undefined || value === null)
        return { ok: true, data: {} };
    if (!isRecord(value))
        return { ok: false, error: "listProfiles request must be an empty object." };
    // The request intentionally carries no fields; reject any unknown fields so a
    // future/old consumer cannot silently send material that the host must own.
    if (Object.keys(value).length > 0) {
        return { ok: false, error: `listProfiles request must be empty; unexpected fields: ${Object.keys(value).join(", ")}` };
    }
    return { ok: true, data: {} };
}
export function validateListProfilesResponse(value) {
    if (!isRecord(value) || !Array.isArray(value.profiles)) {
        return { ok: false, error: "listProfiles response must contain a profiles array." };
    }
    for (const profile of value.profiles) {
        if (!isRecord(profile) || typeof profile.profileId !== "string" || !isRecord(profile.model)
            || typeof profile.model.provider !== "string" || typeof profile.model.id !== "string"
            || typeof profile.thinkingLevel !== "string" || typeof profile.usable !== "boolean") {
            return { ok: false, error: "listProfiles response contains a malformed profile summary." };
        }
    }
    if (!isJsonCompatible(value))
        return { ok: false, error: "listProfiles response is not JSON-compatible." };
    return { ok: true, data: value };
}
const FORGE_PREPARE_REQUEST_FIELDS = new Set([
    "profile", "task", "access", "backend",
]);
const FORGE_ACCESS_LEVELS = new Set(["none", "read-only", "workspace-write"]);
const FORGE_NETWORK_POLICIES = new Set(["deny", "allow"]);
const FORGE_TASK_FIELDS = new Set(["text"]);
const FORGE_ACCESS_FIELDS = new Set(["level", "network", "allowProcess"]);
const FORGE_BACKEND_FIELDS = new Set(["model", "thinkingLevel", "toolCatalog"]);
const FORGE_MODEL_FIELDS = new Set(["provider", "id"]);
const FORGE_TOOL_FIELDS = new Set(["id", "name", "effects"]);
function assertExactKeys(record, fields, path) {
    const unknown = Object.keys(record).filter((key) => !fields.has(key));
    if (unknown.length > 0) {
        return { ok: false, error: `${path} contains unsupported fields: ${unknown.join(", ")}.` };
    }
    return undefined;
}
export function validateResolveProfileRequest(value) {
    if (!isRecord(value))
        return { ok: false, error: "resolveProfile request must be an object." };
    if (Object.keys(value).length !== 1 || typeof value.profile !== "string" || !value.profile.trim()) {
        return { ok: false, error: "resolveProfile request requires a non-empty profile selector." };
    }
    if (!isJsonCompatible(value))
        return { ok: false, error: "resolveProfile request is not JSON-compatible." };
    return { ok: true, data: value };
}
export function validateResolveProfileResponse(value) {
    if (!isRecord(value) || !("snapshot" in value) || !isRecord(value.snapshot)) {
        return { ok: false, error: "resolveProfile response must contain a snapshot object." };
    }
    if (!isJsonCompatible(value))
        return { ok: false, error: "resolveProfile response is not JSON-compatible." };
    return { ok: true, data: value };
}
export function validatePrepareRequest(value) {
    if (!isRecord(value))
        return { ok: false, error: "prepare request must be an object." };
    const top = assertExactKeys(value, FORGE_PREPARE_REQUEST_FIELDS, "prepare request");
    if (top)
        return top;
    if (typeof value.profile !== "string" || !value.profile.trim()) {
        return { ok: false, error: "prepare request requires a non-empty profile selector." };
    }
    if (!isRecord(value.task))
        return { ok: false, error: "prepare request requires task to be an object." };
    const task = assertExactKeys(value.task, FORGE_TASK_FIELDS, "prepare request task");
    if (task)
        return task;
    if (typeof value.task.text !== "string") {
        return { ok: false, error: "prepare request requires task.text to be a string." };
    }
    if (!isRecord(value.access))
        return { ok: false, error: "prepare request requires access to be an object." };
    const access = assertExactKeys(value.access, FORGE_ACCESS_FIELDS, "prepare request access");
    if (access)
        return access;
    if (typeof value.access.level !== "string" || !FORGE_ACCESS_LEVELS.has(value.access.level)) {
        return { ok: false, error: "prepare request access.level must be one of none/read-only/workspace-write." };
    }
    if (typeof value.access.network !== "string" || !FORGE_NETWORK_POLICIES.has(value.access.network)) {
        return { ok: false, error: "prepare request access.network must be deny or allow." };
    }
    if (typeof value.access.allowProcess !== "boolean") {
        return { ok: false, error: "prepare request access.allowProcess must be a boolean." };
    }
    if (!isRecord(value.backend))
        return { ok: false, error: "prepare request requires backend to be an object." };
    const backend = assertExactKeys(value.backend, FORGE_BACKEND_FIELDS, "prepare request backend");
    if (backend)
        return backend;
    if (!isRecord(value.backend.model))
        return { ok: false, error: "prepare request backend.model must be an object." };
    const model = assertExactKeys(value.backend.model, FORGE_MODEL_FIELDS, "prepare request backend.model");
    if (model)
        return model;
    if (typeof value.backend.model.provider !== "string" || !value.backend.model.provider.trim()) {
        return { ok: false, error: "prepare request backend.model.provider must be a non-empty string." };
    }
    if (typeof value.backend.model.id !== "string" || !value.backend.model.id.trim()) {
        return { ok: false, error: "prepare request backend.model.id must be a non-empty string." };
    }
    if (typeof value.backend.thinkingLevel !== "string" || !value.backend.thinkingLevel.trim()) {
        return { ok: false, error: "prepare request backend.thinkingLevel must be a non-empty string." };
    }
    if (!Array.isArray(value.backend.toolCatalog)) {
        return { ok: false, error: "prepare request backend.toolCatalog must be an array." };
    }
    for (const [index, tool] of value.backend.toolCatalog.entries()) {
        if (!isRecord(tool))
            return { ok: false, error: `prepare request backend.toolCatalog[${index}] must be an object.` };
        const toolKeys = assertExactKeys(tool, FORGE_TOOL_FIELDS, `prepare request backend.toolCatalog[${index}]`);
        if (toolKeys)
            return toolKeys;
        if (typeof tool.id !== "string" || !tool.id.trim()) {
            return { ok: false, error: `prepare request backend.toolCatalog[${index}].id must be a non-empty string.` };
        }
        if (tool.name !== undefined && typeof tool.name !== "string") {
            return { ok: false, error: `prepare request backend.toolCatalog[${index}].name must be a string when provided.` };
        }
        if (tool.effects !== undefined && (!Array.isArray(tool.effects) || tool.effects.some((effect) => typeof effect !== "string"))) {
            return { ok: false, error: `prepare request backend.toolCatalog[${index}].effects must be an array of strings when provided.` };
        }
    }
    if (!isJsonCompatible(value))
        return { ok: false, error: "prepare request is not JSON-compatible." };
    return { ok: true, data: value };
}
export function validatePrepareResponse(value) {
    if (!isRecord(value))
        return { ok: false, error: "prepare response must be an object." };
    if (typeof value.profileId !== "string" || typeof value.systemPrompt !== "string"
        || !isRecord(value.model) || typeof value.model.provider !== "string" || typeof value.model.id !== "string"
        || typeof value.thinkingLevel !== "string" || typeof value.preparedAt !== "string"
        || !Array.isArray(value.messages) || !Array.isArray(value.effectiveToolIds)
        || !Array.isArray(value.effectiveToolNames) || !Array.isArray(value.diagnostics)
        || !isRecord(value.profileSnapshot)) {
        return { ok: false, error: "prepare response is missing required fields." };
    }
    if (!isJsonCompatible(value))
        return { ok: false, error: "prepare response is not JSON-compatible." };
    return { ok: true, data: value };
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Reject functions, symbols, bigint, undefined, non-finite numbers, and cycles. */
function isJsonCompatible(value, seen = new Set()) {
    if (value === null)
        return true;
    if (typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (typeof value !== "object")
        return false; // function, symbol, bigint, undefined
    if (seen.has(value))
        return false;
    seen.add(value);
    if (Array.isArray(value))
        return value.every((item) => isJsonCompatible(item, seen));
    const prototype = Object.getPrototypeOf(value);
    // Only plain JSON object records; reject Date/Map/Set/class instances.
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    return Object.values(value).every((item) => isJsonCompatible(item, seen));
}
// ---------------------------------------------------------------------------
// Wire parsing.
// ---------------------------------------------------------------------------
function parseDiscover(data) {
    if (!isRecord(data) || data.type !== "discover")
        return undefined;
    const { protocolVersion, minVersion, maxVersion, clientId } = data;
    if (typeof protocolVersion !== "number" || typeof minVersion !== "number" || typeof maxVersion !== "number" || typeof clientId !== "string")
        return undefined;
    return { type: "discover", protocolVersion, minVersion, maxVersion, clientId };
}
function parseAvailable(data) {
    if (!isRecord(data) || data.type !== "available")
        return undefined;
    const { hostId, protocolVersion, minVersion, maxVersion, capabilities, generation } = data;
    if (typeof hostId !== "string" || typeof protocolVersion !== "number" || typeof minVersion !== "number"
        || typeof maxVersion !== "number" || !Array.isArray(capabilities) || capabilities.some((cap) => typeof cap !== "string") || typeof generation !== "number") {
        return undefined;
    }
    return { type: "available", hostId, protocolVersion, minVersion, maxVersion, capabilities, generation };
}
function parseRequest(data) {
    if (!isRecord(data) || data.type !== "request")
        return undefined;
    const { requestId, hostId, generation, operation, payload } = data;
    if (typeof requestId !== "string" || typeof hostId !== "string" || typeof generation !== "number" || typeof operation !== "string")
        return undefined;
    return { type: "request", requestId, hostId, generation, operation, payload };
}
function parseReply(data) {
    if (!isRecord(data) || data.type !== "reply")
        return undefined;
    const { requestId, hostId, generation, ok } = data;
    if (typeof requestId !== "string" || typeof hostId !== "string" || typeof generation !== "number" || typeof ok !== "boolean")
        return undefined;
    return {
        type: "reply",
        requestId,
        hostId,
        generation,
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
function versionCompatible(hostMin, hostMax, wantMin, wantMax) {
    return hostMax >= wantMin && wantMax >= hostMin;
}
function normalizeHostResult(result) {
    if (isRecord(result) && result.ok === true)
        return { ok: true, data: result.data };
    if (isRecord(result) && result.ok === false) {
        return { ok: false, error: typeof result.error === "string" && result.error ? result.error : "Forge host operation failed." };
    }
    return { ok: false, error: "Forge host returned a malformed operation result." };
}
const DEFAULT_CLIENT_TIMEOUT_MS = 2_000;
// ---------------------------------------------------------------------------
// Host side.
// ---------------------------------------------------------------------------
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
        this.transport.emit(FORGE_HOST_CHANNEL.available, this.availableMessage());
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
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
        // Requests are bound to this host identity and generation; a stale or
        // foreign-generation request must never reach the handler.
        if (message.hostId !== this.hostId || message.generation !== this.generationId)
            return;
        let result;
        try {
            result = typeof this.options.handle === "function"
                ? this.options.handle(message.operation, message.payload)
                : { ok: false, error: "Forge host has no operation handler." };
        }
        catch (error) {
            result = { ok: false, error: `Forge host operation threw: ${error instanceof Error ? error.message : String(error)}` };
        }
        this.transport.emit(FORGE_HOST_CHANNEL.reply, {
            ...normalizeHostResult(result),
            type: "reply",
            requestId: message.requestId,
            hostId: this.hostId,
            generation: this.generationId,
        });
    }
}
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
                if (!versionCompatible(FORGE_HOST_PORT_VERSION, FORGE_HOST_PORT_VERSION, message.minVersion, message.maxVersion))
                    return;
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
                if (!message
                    || message.requestId !== requestId
                    || message.hostId !== connection.hostId
                    || message.generation !== connection.generation) {
                    return;
                }
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
            this.transport.emit(FORGE_HOST_CHANNEL.request, {
                type: "request",
                requestId,
                hostId: connection.hostId,
                generation: connection.generation,
                operation,
                payload,
            });
        });
    }
    disconnect() {
        this.activeConnection = undefined;
        this.teardownPersistentListener();
        this.unavailableHandlers = [];
    }
    get subscriptionCount() {
        return this.connectionUnsubscribe === undefined ? 0 : 1;
    }
}
//# sourceMappingURL=host-port.js.map