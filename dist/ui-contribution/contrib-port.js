import { randomUUID } from "node:crypto";
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
export const UI_CONTRIBUTION_PORT_VERSION = 1;
export const UI_CONTRIBUTION_PORT_NAMESPACE = "@zihanw/pi-forge/ui-contribution/v1";
export const UI_CONTRIBUTION_PORT_OPERATIONS = ["listContributions", "writeValues"];
export const UI_CONTRIBUTION_CHANNEL = {
    discover: `${UI_CONTRIBUTION_PORT_NAMESPACE}/discover`,
    available: `${UI_CONTRIBUTION_PORT_NAMESPACE}/available`,
    request: `${UI_CONTRIBUTION_PORT_NAMESPACE}/request`,
    reply: `${UI_CONTRIBUTION_PORT_NAMESPACE}/reply`,
    unavailable: `${UI_CONTRIBUTION_PORT_NAMESPACE}/unavailable`,
};
export class UiContributionPortError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------
const FIELD_TYPES = new Set(["boolean", "number", "enum", "string", "record"]);
const LIST_FIELDS = new Set(["tabs"]);
const WRITE_REQUEST_FIELDS = new Set(["tabId", "patch"]);
export function validateListContributionsRequest(value) {
    if (value === undefined || value === null)
        return { ok: true, data: {} };
    if (!isRecord(value))
        return { ok: false, error: "listContributions request must be an empty object." };
    if (Object.keys(value).length > 0) {
        return { ok: false, error: `listContributions request must be empty; unexpected fields: ${Object.keys(value).join(", ")}` };
    }
    return { ok: true, data: {} };
}
export function validateListContributionsResponse(value) {
    if (!isRecord(value) || !Array.isArray(value.tabs)) {
        return { ok: false, error: "listContributions response must contain a tabs array." };
    }
    const unknown = Object.keys(value).filter((key) => !LIST_FIELDS.has(key));
    if (unknown.length > 0) {
        return { ok: false, error: `listContributions response contains unsupported fields: ${unknown.join(", ")}.` };
    }
    for (const [index, tab] of value.tabs.entries()) {
        const tabResult = validateUiContributionTabDescriptor(tab);
        if (!tabResult.ok) {
            return { ok: false, error: `listContributions response tabs[${index}]: ${tabResult.error}` };
        }
    }
    if (!isJsonCompatible(value))
        return { ok: false, error: "listContributions response is not JSON-compatible." };
    return { ok: true, data: value };
}
export function validateUiContributionTabDescriptor(value) {
    if (!isRecord(value))
        return { ok: false, error: "tab descriptor must be an object." };
    const allowed = new Set(["tabId", "title", "icon", "schema", "values"]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        return { ok: false, error: `tab descriptor contains unsupported fields: ${unknown.join(", ")}.` };
    }
    if (typeof value.tabId !== "string" || !value.tabId.trim()) {
        return { ok: false, error: "tab descriptor tabId must be a non-empty string." };
    }
    if (typeof value.title !== "string") {
        return { ok: false, error: "tab descriptor title must be a string." };
    }
    if (typeof value.icon !== "string") {
        return { ok: false, error: "tab descriptor icon must be a string." };
    }
    const schema = validateFormSchema(value.schema);
    if (!schema.ok)
        return { ok: false, error: `tab descriptor schema: ${schema.error}` };
    if (!isRecord(value.values))
        return { ok: false, error: "tab descriptor values must be an object." };
    if (!isJsonCompatible(value))
        return { ok: false, error: "tab descriptor is not JSON-compatible." };
    return { ok: true, data: value };
}
export function validateWriteValuesRequest(value) {
    if (!isRecord(value))
        return { ok: false, error: "writeValues request must be an object." };
    const unknown = Object.keys(value).filter((key) => !WRITE_REQUEST_FIELDS.has(key));
    if (unknown.length > 0) {
        return { ok: false, error: `writeValues request contains unsupported fields: ${unknown.join(", ")}.` };
    }
    if (typeof value.tabId !== "string" || !value.tabId.trim()) {
        return { ok: false, error: "writeValues request requires a non-empty tabId." };
    }
    if (!isRecord(value.patch))
        return { ok: false, error: "writeValues request requires patch to be an object." };
    if (!isJsonCompatible(value))
        return { ok: false, error: "writeValues request is not JSON-compatible." };
    return { ok: true, data: value };
}
export function validateWriteValuesResponse(value) {
    if (!isRecord(value) || typeof value.ok !== "boolean") {
        return { ok: false, error: "writeValues response must contain an ok boolean." };
    }
    if (value.ok) {
        if (value.values !== undefined && !isRecord(value.values)) {
            return { ok: false, error: "writeValues success values must be an object when provided." };
        }
    }
    else {
        const errors = value.errors;
        if (!isRecord(errors) || Object.keys(errors).some((key) => typeof errors[key] !== "string")) {
            return { ok: false, error: "writeValues failure must contain an errors object of strings." };
        }
    }
    if (!isJsonCompatible(value))
        return { ok: false, error: "writeValues response is not JSON-compatible." };
    return { ok: true, data: value };
}
export function validateFormSchema(value) {
    if (!isRecord(value))
        return { ok: false, error: "FormSchema must be an object." };
    if (value.title !== undefined && typeof value.title !== "string")
        return { ok: false, error: "FormSchema title must be a string when provided." };
    if (value.description !== undefined && typeof value.description !== "string")
        return { ok: false, error: "FormSchema description must be a string when provided." };
    if (!Array.isArray(value.fields))
        return { ok: false, error: "FormSchema fields must be an array." };
    for (const [index, field] of value.fields.entries()) {
        const fieldResult = validateSchemaField(field);
        if (!fieldResult.ok)
            return { ok: false, error: `FormSchema fields[${index}]: ${fieldResult.error}` };
    }
    if (!isJsonCompatible(value))
        return { ok: false, error: "FormSchema is not JSON-compatible." };
    return { ok: true, data: value };
}
function validateSchemaField(value) {
    if (!isRecord(value))
        return { ok: false, error: "field must be an object." };
    const allowed = new Set([
        "key", "label", "type", "description", "required", "default", "options",
        "min", "max", "maxLength", "pattern", "placeholder", "recordFields", "keyLabel", "keyPlaceholder",
    ]);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
        return { ok: false, error: `field contains unsupported fields: ${unknown.join(", ")}.` };
    }
    if (typeof value.key !== "string" || !value.key.trim())
        return { ok: false, error: "field key must be a non-empty string." };
    if (typeof value.label !== "string")
        return { ok: false, error: "field label must be a string." };
    if (typeof value.type !== "string" || !FIELD_TYPES.has(value.type)) {
        return { ok: false, error: `field type must be one of ${[...FIELD_TYPES].join("/")}.` };
    }
    if (value.description !== undefined && typeof value.description !== "string")
        return { ok: false, error: "field description must be a string when provided." };
    if (value.required !== undefined && typeof value.required !== "boolean")
        return { ok: false, error: "field required must be a boolean when provided." };
    if (value.default !== undefined && !isJsonCompatible(value.default))
        return { ok: false, error: "field default must be JSON-compatible when provided." };
    if (value.min !== undefined && (typeof value.min !== "number" || !Number.isFinite(value.min)))
        return { ok: false, error: "field min must be a finite number when provided." };
    if (value.max !== undefined && (typeof value.max !== "number" || !Number.isFinite(value.max)))
        return { ok: false, error: "field max must be a finite number when provided." };
    if (value.maxLength !== undefined && (typeof value.maxLength !== "number" || !Number.isInteger(value.maxLength)))
        return { ok: false, error: "field maxLength must be an integer when provided." };
    if (value.pattern !== undefined && typeof value.pattern !== "string")
        return { ok: false, error: "field pattern must be a string when provided." };
    if (value.placeholder !== undefined && typeof value.placeholder !== "string")
        return { ok: false, error: "field placeholder must be a string when provided." };
    if (value.keyLabel !== undefined && typeof value.keyLabel !== "string")
        return { ok: false, error: "field keyLabel must be a string when provided." };
    if (value.keyPlaceholder !== undefined && typeof value.keyPlaceholder !== "string")
        return { ok: false, error: "field keyPlaceholder must be a string when provided." };
    if (value.type === "enum") {
        if (value.options !== undefined) {
            if (!Array.isArray(value.options))
                return { ok: false, error: "enum options must be an array when provided." };
            for (const [index, option] of value.options.entries()) {
                const optionResult = validateEnumOption(option);
                if (!optionResult.ok)
                    return { ok: false, error: `options[${index}]: ${optionResult.error}` };
            }
        }
    }
    if (value.type === "number" && value.min !== undefined && value.max !== undefined && value.min > value.max) {
        return { ok: false, error: "field min cannot be greater than max." };
    }
    if (value.type === "record") {
        if (value.recordFields !== undefined) {
            if (!Array.isArray(value.recordFields))
                return { ok: false, error: "recordFields must be an array when provided." };
            for (const [index, rowField] of value.recordFields.entries()) {
                const rowResult = validateSchemaField(rowField);
                if (!rowResult.ok)
                    return { ok: false, error: `recordFields[${index}]: ${rowResult.error}` };
            }
        }
    }
    return { ok: true, data: value };
}
function validateEnumOption(value) {
    if (typeof value === "string")
        return { ok: true, data: value };
    if (!isRecord(value))
        return { ok: false, error: "enum option must be a string or an object." };
    if (typeof value.value !== "string" || !value.value)
        return { ok: false, error: "enum option value must be a non-empty string." };
    if (value.label !== undefined && typeof value.label !== "string")
        return { ok: false, error: "enum option label must be a string when provided." };
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
        return false;
    if (seen.has(value))
        return false;
    seen.add(value);
    if (Array.isArray(value))
        return value.every((item) => isJsonCompatible(item, seen));
    const prototype = Object.getPrototypeOf(value);
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
function normalizeProviderResult(result) {
    if (isRecord(result) && result.ok === true)
        return { ok: true, data: result.data };
    if (isRecord(result) && result.ok === false) {
        return { ok: false, error: typeof result.error === "string" && result.error ? result.error : "UI contribution provider operation failed." };
    }
    return { ok: false, error: "UI contribution provider returned a malformed operation result." };
}
const DEFAULT_CLIENT_TIMEOUT_MS = 2_000;
// ---------------------------------------------------------------------------
// Provider side.
// ---------------------------------------------------------------------------
export class UiContributionProvider {
    transport;
    options;
    hostId;
    generationId = 1;
    started = false;
    unsubscribers = [];
    constructor(transport, options) {
        this.transport = transport;
        this.options = options;
        this.hostId = options.providerId ?? `ui-contribution-${randomUUID()}`;
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
            protocolVersion: UI_CONTRIBUTION_PORT_VERSION,
            minVersion: this.options.minVersion ?? UI_CONTRIBUTION_PORT_VERSION,
            maxVersion: this.options.maxVersion ?? UI_CONTRIBUTION_PORT_VERSION,
            capabilities: [...(this.options.capabilities ?? UI_CONTRIBUTION_PORT_OPERATIONS)],
            generation: this.generationId,
        };
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.unsubscribers.push(this.transport.on(UI_CONTRIBUTION_CHANNEL.discover, (data) => this.onDiscover(data)));
        this.unsubscribers.push(this.transport.on(UI_CONTRIBUTION_CHANNEL.request, (data) => this.onRequest(data)));
        this.transport.emit(UI_CONTRIBUTION_CHANNEL.available, this.availableMessage());
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        for (const unsubscribe of this.unsubscribers.splice(0))
            unsubscribe();
        this.transport.emit(UI_CONTRIBUTION_CHANNEL.unavailable, {
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
        if (!message || message.protocolVersion !== UI_CONTRIBUTION_PORT_VERSION)
            return;
        if (!versionCompatible(this.options.minVersion ?? UI_CONTRIBUTION_PORT_VERSION, this.options.maxVersion ?? UI_CONTRIBUTION_PORT_VERSION, message.minVersion, message.maxVersion)) {
            return;
        }
        this.transport.emit(UI_CONTRIBUTION_CHANNEL.available, this.availableMessage());
    }
    onRequest(data) {
        if (!this.started)
            return;
        const message = parseRequest(data);
        if (!message)
            return;
        if (message.hostId !== this.hostId || message.generation !== this.generationId)
            return;
        let result;
        try {
            result = typeof this.options.handle === "function"
                ? this.options.handle(message.operation, message.payload)
                : { ok: false, error: "UI contribution provider has no operation handler." };
        }
        catch (error) {
            result = { ok: false, error: `UI contribution provider operation threw: ${error instanceof Error ? error.message : String(error)}` };
        }
        this.transport.emit(UI_CONTRIBUTION_CHANNEL.reply, {
            ...normalizeProviderResult(result),
            type: "reply",
            requestId: message.requestId,
            hostId: this.hostId,
            generation: this.generationId,
        });
    }
}
export class UiContributionClient {
    transport;
    clientId;
    defaultTimeoutMs;
    discoverSettleMs;
    connectionUnsubscribe;
    unavailableHandlers = [];
    activeConnection;
    constructor(transport, options = {}) {
        this.transport = transport;
        this.clientId = options.clientId ?? `ui-contribution-client-${randomUUID()}`;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
        this.discoverSettleMs = options.discoverSettleMs ?? 25;
    }
    onUnavailable(handler) {
        if (this.connectionUnsubscribe === undefined) {
            this.connectionUnsubscribe = this.transport.on(UI_CONTRIBUTION_CHANNEL.unavailable, (data) => this.onUnavailableMessage(data));
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
                    // A throwing client handler must not break provider disposal dispatch.
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
                if (!message || message.protocolVersion !== UI_CONTRIBUTION_PORT_VERSION)
                    return;
                if (!versionCompatible(UI_CONTRIBUTION_PORT_VERSION, UI_CONTRIBUTION_PORT_VERSION, message.minVersion, message.maxVersion))
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
                    settle(new UiContributionPortError("duplicate", "Multiple compatible UI contribution providers are live."));
                    return;
                }
                if (settleTimer === undefined) {
                    settleTimer = setTimeout(() => settle(undefined, hosts.values().next().value), this.discoverSettleMs);
                }
            };
            const unsubAvailable = this.transport.on(UI_CONTRIBUTION_CHANNEL.available, onAvailable);
            const unsubUnavailable = this.transport.on(UI_CONTRIBUTION_CHANNEL.unavailable, (data) => {
                const message = parseUnavailable(data);
                const known = message ? hosts.get(message.hostId) : undefined;
                if (known && message && message.generation === known.generation) {
                    settle(new UiContributionPortError("unavailable", `UI contribution provider ${message.hostId} became unavailable during discovery.`));
                }
            });
            const unsubscribeAll = () => {
                unsubAvailable();
                unsubUnavailable();
            };
            timer = setTimeout(() => settle(new UiContributionPortError("timeout", "UI contribution provider discovery timed out.")), expectedTimeout);
            this.transport.emit(UI_CONTRIBUTION_CHANNEL.discover, {
                type: "discover",
                protocolVersion: UI_CONTRIBUTION_PORT_VERSION,
                minVersion: UI_CONTRIBUTION_PORT_VERSION,
                maxVersion: UI_CONTRIBUTION_PORT_VERSION,
                clientId: this.clientId,
            });
        });
    }
    connect(connection) {
        if (this.activeConnection && this.activeConnection.hostId !== connection.hostId) {
            throw new UiContributionPortError("duplicate", "This client is already connected to another UI contribution provider.");
        }
        this.activeConnection = connection;
        if (this.connectionUnsubscribe === undefined) {
            this.connectionUnsubscribe = this.transport.on(UI_CONTRIBUTION_CHANNEL.unavailable, (data) => this.onUnavailableMessage(data));
        }
        return connection;
    }
    async request(connection, operation, payload, timeoutMs) {
        if (this.activeConnection !== connection) {
            return { ok: false, error: `UI contribution provider ${connection.hostId} is not the client's active connection.` };
        }
        if (!UI_CONTRIBUTION_PORT_OPERATIONS.includes(operation)) {
            return { ok: false, error: `Unknown UI contribution operation: ${operation}` };
        }
        const requestId = randomUUID();
        const expectedTimeout = timeoutMs ?? this.defaultTimeoutMs;
        return new Promise((resolve) => {
            const unsubscribeReply = this.transport.on(UI_CONTRIBUTION_CHANNEL.reply, (data) => {
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
                    resolve({ ok: false, error: message.error ?? "UI contribution provider operation failed." });
            });
            const unsubscribeUnavailable = this.transport.on(UI_CONTRIBUTION_CHANNEL.unavailable, (data) => {
                const message = parseUnavailable(data);
                if (message && message.hostId === connection.hostId && message.generation === connection.generation) {
                    cleanup();
                    resolve({ ok: false, error: `UI contribution provider ${connection.hostId} became unavailable.` });
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
                resolve({ ok: false, error: `UI contribution operation ${operation} timed out.` });
            }, expectedTimeout);
            this.transport.emit(UI_CONTRIBUTION_CHANNEL.request, {
                type: "request",
                requestId,
                hostId: connection.hostId,
                generation: connection.generation,
                operation,
                payload,
            });
        });
    }
    async listContributions(connection, timeoutMs) {
        const result = await this.request(connection, "listContributions", {}, timeoutMs);
        if (!result.ok)
            return result;
        const validated = validateListContributionsResponse(result.data);
        if (!validated.ok)
            return { ok: false, error: validated.error };
        return { ok: true, data: validated.data };
    }
    async writeValues(connection, tabId, patch, timeoutMs) {
        const request = { tabId, patch };
        const validatedRequest = validateWriteValuesRequest(request);
        if (!validatedRequest.ok)
            return { ok: false, error: validatedRequest.error };
        const result = await this.request(connection, "writeValues", validatedRequest.data, timeoutMs);
        if (!result.ok)
            return result;
        const validated = validateWriteValuesResponse(result.data);
        if (!validated.ok)
            return { ok: false, error: validated.error };
        return { ok: true, data: validated.data };
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
//# sourceMappingURL=contrib-port.js.map