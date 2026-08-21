import { randomUUID } from "node:crypto";
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
export const UI_CONTRIBUTION_PORT_VERSION = 1;
export const UI_CONTRIBUTION_PORT_NAMESPACE = "@zihanw/pi-forge/ui-contribution/v1";
export const UI_CONTRIBUTION_PORT_OPERATIONS = ["listContributions", "writeValues"] as const;
export type UiContributionPortOperation = (typeof UI_CONTRIBUTION_PORT_OPERATIONS)[number];

export const UI_CONTRIBUTION_CHANNEL = {
	discover: `${UI_CONTRIBUTION_PORT_NAMESPACE}/discover`,
	available: `${UI_CONTRIBUTION_PORT_NAMESPACE}/available`,
	request: `${UI_CONTRIBUTION_PORT_NAMESPACE}/request`,
	reply: `${UI_CONTRIBUTION_PORT_NAMESPACE}/reply`,
	unavailable: `${UI_CONTRIBUTION_PORT_NAMESPACE}/unavailable`,
} as const;

export interface UiContributionTransport {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export type UiContributionWireMessage =
	| { type: "discover"; protocolVersion: number; minVersion: number; maxVersion: number; clientId: string }
	| { type: "available"; hostId: string; protocolVersion: number; minVersion: number; maxVersion: number; capabilities: string[]; generation: number }
	| { type: "request"; requestId: string; hostId: string; generation: number; operation: string; payload: unknown }
	| { type: "reply"; requestId: string; hostId: string; generation: number; ok: boolean; data?: unknown; error?: string }
	| { type: "unavailable"; hostId: string; generation: number };

export type UiContributionPortResult =
	| { ok: true; data: unknown }
	| { ok: false; error: string };

export interface UiContributionProviderOptions {
	providerId?: string;
	capabilities?: readonly string[];
	minVersion?: number;
	maxVersion?: number;
	/** Operation handler; must never throw across the bus. */
	handle(operation: string, payload: unknown): UiContributionPortResult;
}

export interface UiContributionConnection {
	hostId: string;
	protocolVersion: number;
	capabilities: readonly string[];
	generation: number;
}

// ---------------------------------------------------------------------------
// Public v1 DTOs.
// ---------------------------------------------------------------------------

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

export type UiWriteValuesResponse =
	| { ok: true; values?: FormValues }
	| { ok: false; errors: Record<string, string> };

export type ValidationResult<T = unknown> =
	| { ok: true; data: T }
	| { ok: false; error: string };

export class UiContributionPortError extends Error {
	readonly code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid";
	constructor(code: UiContributionPortError["code"], message: string) {
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

export function validateListContributionsRequest(value: unknown): ValidationResult<Record<string, never>> {
	if (value === undefined || value === null) return { ok: true, data: {} };
	if (!isRecord(value)) return { ok: false, error: "listContributions request must be an empty object." };
	if (Object.keys(value).length > 0) {
		return { ok: false, error: `listContributions request must be empty; unexpected fields: ${Object.keys(value).join(", ")}` };
	}
	return { ok: true, data: {} };
}

export function validateListContributionsResponse(value: unknown): ValidationResult<UiListContributionsResponse> {
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
	if (!isJsonCompatible(value)) return { ok: false, error: "listContributions response is not JSON-compatible." };
	return { ok: true, data: value as unknown as UiListContributionsResponse };
}

export function validateUiContributionTabDescriptor(value: unknown): ValidationResult<UiContributionTabDescriptor> {
	if (!isRecord(value)) return { ok: false, error: "tab descriptor must be an object." };
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
	if (!schema.ok) return { ok: false, error: `tab descriptor schema: ${schema.error}` };
	if (!isRecord(value.values)) return { ok: false, error: "tab descriptor values must be an object." };
	if (!isJsonCompatible(value)) return { ok: false, error: "tab descriptor is not JSON-compatible." };
	return { ok: true, data: value as unknown as UiContributionTabDescriptor };
}

export function validateWriteValuesRequest(value: unknown): ValidationResult<UiWriteValuesRequest> {
	if (!isRecord(value)) return { ok: false, error: "writeValues request must be an object." };
	const unknown = Object.keys(value).filter((key) => !WRITE_REQUEST_FIELDS.has(key));
	if (unknown.length > 0) {
		return { ok: false, error: `writeValues request contains unsupported fields: ${unknown.join(", ")}.` };
	}
	if (typeof value.tabId !== "string" || !value.tabId.trim()) {
		return { ok: false, error: "writeValues request requires a non-empty tabId." };
	}
	if (!isRecord(value.patch)) return { ok: false, error: "writeValues request requires patch to be an object." };
	if (!isJsonCompatible(value)) return { ok: false, error: "writeValues request is not JSON-compatible." };
	return { ok: true, data: value as unknown as UiWriteValuesRequest };
}

export function validateWriteValuesResponse(value: unknown): ValidationResult<UiWriteValuesResponse> {
	if (!isRecord(value) || typeof value.ok !== "boolean") {
		return { ok: false, error: "writeValues response must contain an ok boolean." };
	}
	if (value.ok) {
		if (value.values !== undefined && !isRecord(value.values)) {
			return { ok: false, error: "writeValues success values must be an object when provided." };
		}
	} else {
		const errors = value.errors;
		if (!isRecord(errors) || Object.keys(errors).some((key) => typeof errors[key] !== "string")) {
			return { ok: false, error: "writeValues failure must contain an errors object of strings." };
		}
	}
	if (!isJsonCompatible(value)) return { ok: false, error: "writeValues response is not JSON-compatible." };
	return { ok: true, data: value as unknown as UiWriteValuesResponse };
}

export function validateFormSchema(value: unknown): ValidationResult<FormSchema> {
	if (!isRecord(value)) return { ok: false, error: "FormSchema must be an object." };
	if (value.title !== undefined && typeof value.title !== "string") return { ok: false, error: "FormSchema title must be a string when provided." };
	if (value.description !== undefined && typeof value.description !== "string") return { ok: false, error: "FormSchema description must be a string when provided." };
	if (!Array.isArray(value.fields)) return { ok: false, error: "FormSchema fields must be an array." };
	for (const [index, field] of value.fields.entries()) {
		const fieldResult = validateSchemaField(field);
		if (!fieldResult.ok) return { ok: false, error: `FormSchema fields[${index}]: ${fieldResult.error}` };
	}
	if (!isJsonCompatible(value)) return { ok: false, error: "FormSchema is not JSON-compatible." };
	return { ok: true, data: value as unknown as FormSchema };
}

function validateSchemaField(value: unknown): ValidationResult<unknown> {
	if (!isRecord(value)) return { ok: false, error: "field must be an object." };
	const allowed = new Set([
		"key", "label", "type", "description", "required", "default", "options",
		"min", "max", "maxLength", "pattern", "placeholder", "recordFields", "keyLabel", "keyPlaceholder",
	]);
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		return { ok: false, error: `field contains unsupported fields: ${unknown.join(", ")}.` };
	}
	if (typeof value.key !== "string" || !value.key.trim()) return { ok: false, error: "field key must be a non-empty string." };
	if (typeof value.label !== "string") return { ok: false, error: "field label must be a string." };
	if (typeof value.type !== "string" || !FIELD_TYPES.has(value.type)) {
		return { ok: false, error: `field type must be one of ${[...FIELD_TYPES].join("/")}.` };
	}
	if (value.description !== undefined && typeof value.description !== "string") return { ok: false, error: "field description must be a string when provided." };
	if (value.required !== undefined && typeof value.required !== "boolean") return { ok: false, error: "field required must be a boolean when provided." };
	if (value.default !== undefined && !isJsonCompatible(value.default)) return { ok: false, error: "field default must be JSON-compatible when provided." };
	if (value.min !== undefined && (typeof value.min !== "number" || !Number.isFinite(value.min))) return { ok: false, error: "field min must be a finite number when provided." };
	if (value.max !== undefined && (typeof value.max !== "number" || !Number.isFinite(value.max))) return { ok: false, error: "field max must be a finite number when provided." };
	if (value.maxLength !== undefined && (typeof value.maxLength !== "number" || !Number.isInteger(value.maxLength))) return { ok: false, error: "field maxLength must be an integer when provided." };
	if (value.pattern !== undefined && typeof value.pattern !== "string") return { ok: false, error: "field pattern must be a string when provided." };
	if (value.placeholder !== undefined && typeof value.placeholder !== "string") return { ok: false, error: "field placeholder must be a string when provided." };
	if (value.keyLabel !== undefined && typeof value.keyLabel !== "string") return { ok: false, error: "field keyLabel must be a string when provided." };
	if (value.keyPlaceholder !== undefined && typeof value.keyPlaceholder !== "string") return { ok: false, error: "field keyPlaceholder must be a string when provided." };

	if (value.type === "enum") {
		if (value.options !== undefined) {
			if (!Array.isArray(value.options)) return { ok: false, error: "enum options must be an array when provided." };
			for (const [index, option] of value.options.entries()) {
				const optionResult = validateEnumOption(option);
				if (!optionResult.ok) return { ok: false, error: `options[${index}]: ${optionResult.error}` };
			}
		}
	}
	if (value.type === "number" && value.min !== undefined && value.max !== undefined && value.min > value.max) {
		return { ok: false, error: "field min cannot be greater than max." };
	}
	if (value.type === "record") {
		if (value.recordFields !== undefined) {
			if (!Array.isArray(value.recordFields)) return { ok: false, error: "recordFields must be an array when provided." };
			for (const [index, rowField] of value.recordFields.entries()) {
				const rowResult = validateSchemaField(rowField);
				if (!rowResult.ok) return { ok: false, error: `recordFields[${index}]: ${rowResult.error}` };
			}
		}
	}
	return { ok: true, data: value };
}

function validateEnumOption(value: unknown): ValidationResult<unknown> {
	if (typeof value === "string") return { ok: true, data: value };
	if (!isRecord(value)) return { ok: false, error: "enum option must be a string or an object." };
	if (typeof value.value !== "string" || !value.value) return { ok: false, error: "enum option value must be a non-empty string." };
	if (value.label !== undefined && typeof value.label !== "string") return { ok: false, error: "enum option label must be a string when provided." };
	return { ok: true, data: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reject functions, symbols, bigint, undefined, non-finite numbers, and cycles. */
function isJsonCompatible(value: unknown, seen = new Set<object>()): boolean {
	if (value === null) return true;
	if (typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.every((item) => isJsonCompatible(item, seen));
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.values(value).every((item) => isJsonCompatible(item, seen));
}

// ---------------------------------------------------------------------------
// Wire parsing.
// ---------------------------------------------------------------------------

function parseDiscover(data: unknown): Extract<UiContributionWireMessage, { type: "discover" }> | undefined {
	if (!isRecord(data) || data.type !== "discover") return undefined;
	const { protocolVersion, minVersion, maxVersion, clientId } = data;
	if (typeof protocolVersion !== "number" || typeof minVersion !== "number" || typeof maxVersion !== "number" || typeof clientId !== "string") return undefined;
	return { type: "discover", protocolVersion, minVersion, maxVersion, clientId };
}

function parseAvailable(data: unknown): Extract<UiContributionWireMessage, { type: "available" }> | undefined {
	if (!isRecord(data) || data.type !== "available") return undefined;
	const { hostId, protocolVersion, minVersion, maxVersion, capabilities, generation } = data;
	if (typeof hostId !== "string" || typeof protocolVersion !== "number" || typeof minVersion !== "number"
		|| typeof maxVersion !== "number" || !Array.isArray(capabilities) || capabilities.some((cap) => typeof cap !== "string") || typeof generation !== "number") {
		return undefined;
	}
	return { type: "available", hostId, protocolVersion, minVersion, maxVersion, capabilities, generation };
}

function parseRequest(data: unknown): Extract<UiContributionWireMessage, { type: "request" }> | undefined {
	if (!isRecord(data) || data.type !== "request") return undefined;
	const { requestId, hostId, generation, operation, payload } = data;
	if (typeof requestId !== "string" || typeof hostId !== "string" || typeof generation !== "number" || typeof operation !== "string") return undefined;
	return { type: "request", requestId, hostId, generation, operation, payload };
}

function parseReply(data: unknown): Extract<UiContributionWireMessage, { type: "reply" }> | undefined {
	if (!isRecord(data) || data.type !== "reply") return undefined;
	const { requestId, hostId, generation, ok } = data;
	if (typeof requestId !== "string" || typeof hostId !== "string" || typeof generation !== "number" || typeof ok !== "boolean") return undefined;
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

function parseUnavailable(data: unknown): Extract<UiContributionWireMessage, { type: "unavailable" }> | undefined {
	if (!isRecord(data) || data.type !== "unavailable") return undefined;
	const { hostId, generation } = data;
	if (typeof hostId !== "string" || typeof generation !== "number") return undefined;
	return { type: "unavailable", hostId, generation };
}

function versionCompatible(hostMin: number, hostMax: number, wantMin: number, wantMax: number): boolean {
	return hostMax >= wantMin && wantMax >= hostMin;
}

function normalizeProviderResult(result: unknown): UiContributionPortResult {
	if (isRecord(result) && result.ok === true) return { ok: true, data: result.data };
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
	private readonly transport: UiContributionTransport;
	private readonly options: UiContributionProviderOptions;
	readonly hostId: string;
	private generationId = 1;
	private started = false;
	private unsubscribers: (() => void)[] = [];

	constructor(transport: UiContributionTransport, options: UiContributionProviderOptions) {
		this.transport = transport;
		this.options = options;
		this.hostId = options.providerId ?? `ui-contribution-${randomUUID()}`;
	}

	get generation(): number {
		return this.generationId;
	}

	get isLive(): boolean {
		return this.started;
	}

	private availableMessage(): UiContributionWireMessage {
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

	start(): void {
		if (this.started) return;
		this.started = true;
		this.unsubscribers.push(this.transport.on(UI_CONTRIBUTION_CHANNEL.discover, (data) => this.onDiscover(data)));
		this.unsubscribers.push(this.transport.on(UI_CONTRIBUTION_CHANNEL.request, (data) => this.onRequest(data)));
		this.transport.emit(UI_CONTRIBUTION_CHANNEL.available, this.availableMessage());
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		this.transport.emit(UI_CONTRIBUTION_CHANNEL.unavailable, {
			type: "unavailable",
			hostId: this.hostId,
			generation: this.generationId,
		});
		this.generationId += 1;
	}

	private onDiscover(data: unknown): void {
		if (!this.started) return;
		const message = parseDiscover(data);
		if (!message || message.protocolVersion !== UI_CONTRIBUTION_PORT_VERSION) return;
		if (!versionCompatible(
			this.options.minVersion ?? UI_CONTRIBUTION_PORT_VERSION,
			this.options.maxVersion ?? UI_CONTRIBUTION_PORT_VERSION,
			message.minVersion,
			message.maxVersion,
		)) {
			return;
		}
		this.transport.emit(UI_CONTRIBUTION_CHANNEL.available, this.availableMessage());
	}

	private onRequest(data: unknown): void {
		if (!this.started) return;
		const message = parseRequest(data);
		if (!message) return;
		if (message.hostId !== this.hostId || message.generation !== this.generationId) return;

		let result: UiContributionPortResult;
		try {
			result = typeof this.options.handle === "function"
				? this.options.handle(message.operation, message.payload)
				: { ok: false, error: "UI contribution provider has no operation handler." };
		} catch (error) {
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

// ---------------------------------------------------------------------------
// Client side.
// ---------------------------------------------------------------------------

export interface UiContributionClientOptions {
	clientId?: string;
	defaultTimeoutMs?: number;
	discoverSettleMs?: number;
}

export class UiContributionClient {
	private readonly transport: UiContributionTransport;
	readonly clientId: string;
	private readonly defaultTimeoutMs: number;
	private readonly discoverSettleMs: number;
	private connectionUnsubscribe?: () => void;
	private unavailableHandlers: (() => void)[] = [];
	private activeConnection?: UiContributionConnection;

	constructor(transport: UiContributionTransport, options: UiContributionClientOptions = {}) {
		this.transport = transport;
		this.clientId = options.clientId ?? `ui-contribution-client-${randomUUID()}`;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
		this.discoverSettleMs = options.discoverSettleMs ?? 25;
	}

	onUnavailable(handler: () => void): () => void {
		if (this.connectionUnsubscribe === undefined) {
			this.connectionUnsubscribe = this.transport.on(UI_CONTRIBUTION_CHANNEL.unavailable, (data) => this.onUnavailableMessage(data));
		}
		this.unavailableHandlers.push(handler);
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			const index = this.unavailableHandlers.indexOf(handler);
			if (index !== -1) this.unavailableHandlers.splice(index, 1);
			if (this.unavailableHandlers.length === 0 && this.activeConnection === undefined) {
				this.teardownPersistentListener();
			}
		};
	}

	private teardownPersistentListener(): void {
		if (this.connectionUnsubscribe !== undefined) {
			this.connectionUnsubscribe();
			this.connectionUnsubscribe = undefined;
		}
	}

	private onUnavailableMessage(data: unknown): void {
		const message = parseUnavailable(data);
		if (!message) return;
		if (this.activeConnection && message.hostId === this.activeConnection.hostId && message.generation === this.activeConnection.generation) {
			this.activeConnection = undefined;
			for (const handler of [...this.unavailableHandlers]) {
				try {
					handler();
				} catch {
					// A throwing client handler must not break provider disposal dispatch.
				}
			}
		}
	}

	async discover(timeoutMs?: number): Promise<UiContributionConnection> {
		const expectedTimeout = timeoutMs ?? this.defaultTimeoutMs;
		return new Promise<UiContributionConnection>((resolve, reject) => {
			const hosts = new Map<string, UiContributionConnection>();
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let settleTimer: NodeJS.Timeout | undefined;

			const settle = (error?: UiContributionPortError, connection?: UiContributionConnection) => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				if (settleTimer !== undefined) clearTimeout(settleTimer);
				unsubscribeAll();
				if (error) reject(error);
				else resolve(connection!);
			};

			const onAvailable = (data: unknown) => {
				const message = parseAvailable(data);
				if (!message || message.protocolVersion !== UI_CONTRIBUTION_PORT_VERSION) return;
				if (!versionCompatible(UI_CONTRIBUTION_PORT_VERSION, UI_CONTRIBUTION_PORT_VERSION, message.minVersion, message.maxVersion)) return;
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

	connect(connection: UiContributionConnection): UiContributionConnection {
		if (this.activeConnection && this.activeConnection.hostId !== connection.hostId) {
			throw new UiContributionPortError("duplicate", "This client is already connected to another UI contribution provider.");
		}
		this.activeConnection = connection;
		if (this.connectionUnsubscribe === undefined) {
			this.connectionUnsubscribe = this.transport.on(UI_CONTRIBUTION_CHANNEL.unavailable, (data) => this.onUnavailableMessage(data));
		}
		return connection;
	}

	async request(
		connection: UiContributionConnection,
		operation: string,
		payload: unknown,
		timeoutMs?: number,
	): Promise<UiContributionPortResult> {
		if (this.activeConnection !== connection) {
			return { ok: false, error: `UI contribution provider ${connection.hostId} is not the client's active connection.` };
		}
		if (!UI_CONTRIBUTION_PORT_OPERATIONS.includes(operation as UiContributionPortOperation)) {
			return { ok: false, error: `Unknown UI contribution operation: ${operation}` };
		}
		const requestId = randomUUID();
		const expectedTimeout = timeoutMs ?? this.defaultTimeoutMs;

		return new Promise<UiContributionPortResult>((resolve) => {
			const unsubscribeReply = this.transport.on(UI_CONTRIBUTION_CHANNEL.reply, (data) => {
				const message = parseReply(data);
				if (
					!message
					|| message.requestId !== requestId
					|| message.hostId !== connection.hostId
					|| message.generation !== connection.generation
				) {
					return;
				}
				cleanup();
				if (message.ok) resolve({ ok: true, data: message.data });
				else resolve({ ok: false, error: message.error ?? "UI contribution provider operation failed." });
			});
			const unsubscribeUnavailable = this.transport.on(UI_CONTRIBUTION_CHANNEL.unavailable, (data) => {
				const message = parseUnavailable(data);
				if (message && message.hostId === connection.hostId && message.generation === connection.generation) {
					cleanup();
					resolve({ ok: false, error: `UI contribution provider ${connection.hostId} became unavailable.` });
				}
			});
			let timer: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (timer !== undefined) clearTimeout(timer);
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

	async listContributions(connection: UiContributionConnection, timeoutMs?: number): Promise<UiContributionPortResult> {
		const result = await this.request(connection, "listContributions", {}, timeoutMs);
		if (!result.ok) return result;
		const validated = validateListContributionsResponse(result.data);
		if (!validated.ok) return { ok: false, error: validated.error };
		return { ok: true, data: validated.data };
	}

	async writeValues(connection: UiContributionConnection, tabId: string, patch: FormValues, timeoutMs?: number): Promise<UiContributionPortResult> {
		const request: UiWriteValuesRequest = { tabId, patch };
		const validatedRequest = validateWriteValuesRequest(request);
		if (!validatedRequest.ok) return { ok: false, error: validatedRequest.error };
		const result = await this.request(connection, "writeValues", validatedRequest.data, timeoutMs);
		if (!result.ok) return result;
		const validated = validateWriteValuesResponse(result.data);
		if (!validated.ok) return { ok: false, error: validated.error };
		return { ok: true, data: validated.data };
	}

	disconnect(): void {
		this.activeConnection = undefined;
		this.teardownPersistentListener();
		this.unavailableHandlers = [];
	}

	get subscriptionCount(): number {
		return this.connectionUnsubscribe === undefined ? 0 : 1;
	}
}
