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
export const FORGE_HOST_PORT_OPERATIONS = ["listProfiles", "prepare"] as const;
export type ForgeHostPortOperation = (typeof FORGE_HOST_PORT_OPERATIONS)[number];

export const FORGE_HOST_CHANNEL = {
	discover: `${FORGE_HOST_PORT_NAMESPACE}/discover`,
	available: `${FORGE_HOST_PORT_NAMESPACE}/available`,
	request: `${FORGE_HOST_PORT_NAMESPACE}/request`,
	reply: `${FORGE_HOST_PORT_NAMESPACE}/reply`,
	unavailable: `${FORGE_HOST_PORT_NAMESPACE}/unavailable`,
} as const;

export interface ForgeHostTransport {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export type ForgeHostWireMessage =
	| { type: "discover"; protocolVersion: number; minVersion: number; maxVersion: number; clientId: string }
	| { type: "available"; hostId: string; protocolVersion: number; minVersion: number; maxVersion: number; capabilities: string[]; generation: number }
	| { type: "request"; requestId: string; hostId: string; generation: number; operation: string; payload: unknown }
	| { type: "reply"; requestId: string; hostId: string; generation: number; ok: boolean; data?: unknown; error?: string }
	| { type: "unavailable"; hostId: string; generation: number };

export type ForgeHostPortResult =
	| { ok: true; data: unknown }
	| { ok: false; error: string };

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

// ---------------------------------------------------------------------------
// Public v1 DTOs for the two operations.
// ---------------------------------------------------------------------------

export interface ForgeProfileSummary {
	profileId: string;
	scope: "project" | "global";
	name?: string;
	description?: string;
	autoActivate?: boolean;
	model: { provider: string; id: string };
	thinkingLevel: string;
	promptStack: string | null;
	usable: boolean;
	diagnostics: Array<{ level: string; message: string; field?: string }>;
}

export interface ForgeListProfilesResponse {
	profiles: ForgeProfileSummary[];
}

export interface ForgeAccessRequest {
	level: string;
	workspaces: string[];
	network: string;
	executionBoundary?: string;
	process?: boolean;
}

export interface ForgeBackendTool {
	id: string;
	name?: string;
	effects?: string[];
}

export interface ForgeBackendFacts {
	model: { provider: string; id: string };
	thinkingLevel: string;
	toolCatalog: ForgeBackendTool[];
}

export interface ForgePrepareRequest {
	profile: string;
	task: { text: string };
	access: ForgeAccessRequest;
	limits: Record<string, unknown>;
	backend: ForgeBackendFacts;
	resultProjection: { maxChars: number };
	parent: { depth: number; maxDepth: number };
	remoteEgressConsent: boolean;
}

export interface ForgePrepareResponse {
	profileId: string;
	model: { provider: string; id: string };
	thinkingLevel: string;
	systemPrompt: string;
	messages: unknown[];
	effectiveToolIds: string[];
	effectiveToolNames: string[];
	diagnostics: unknown[];
	profileSnapshot: unknown;
	preparedAt: string;
}

// ---------------------------------------------------------------------------
// Errors and validation.
// ---------------------------------------------------------------------------

export class ForgeHostPortError extends Error {
	readonly code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid";
	constructor(code: ForgeHostPortError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

type ValidationResult =
	| { ok: true; data: unknown }
	| { ok: false; error: string };

export function validateListProfilesRequest(value: unknown): ValidationResult {
	if (value === undefined || value === null) return { ok: true, data: {} };
	if (!isRecord(value)) return { ok: false, error: "listProfiles request must be an empty object." };
	// The request intentionally carries no fields; reject any unknown fields so a
	// future/old consumer cannot silently send material that the host must own.
	if (Object.keys(value).length > 0) {
		return { ok: false, error: `listProfiles request must be empty; unexpected fields: ${Object.keys(value).join(", ")}` };
	}
	return { ok: true, data: {} };
}

export function validateListProfilesResponse(value: unknown): ValidationResult {
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
	if (!isJsonCompatible(value)) return { ok: false, error: "listProfiles response is not JSON-compatible." };
	return { ok: true, data: value };
}

const FORGE_PREPARE_REQUEST_FIELDS = new Set([
	"profile", "task", "access", "limits", "backend", "resultProjection", "parent", "remoteEgressConsent",
]);

export function validatePrepareRequest(value: unknown): ValidationResult {
	if (!isRecord(value)) return { ok: false, error: "prepare request must be an object." };
	const unknown = Object.keys(value).filter((key) => !FORGE_PREPARE_REQUEST_FIELDS.has(key));
	if (unknown.length > 0) {
		return { ok: false, error: `prepare request contains unsupported fields: ${unknown.join(", ")}.` };
	}
	if (typeof value.profile !== "string" || !value.profile.trim()) {
		return { ok: false, error: "prepare request requires a non-empty profile selector." };
	}
	if (!isRecord(value.task) || typeof value.task.text !== "string") {
		return { ok: false, error: "prepare request requires task.text." };
	}
	if (!isRecord(value.access) || typeof value.access.level !== "string" || !Array.isArray(value.access.workspaces)
		|| typeof value.access.network !== "string") {
		return { ok: false, error: "prepare request requires access with level, workspaces, and network." };
	}
	if (!isRecord(value.limits)) return { ok: false, error: "prepare request requires limits to be an object." };
	if (!isRecord(value.resultProjection) || typeof value.resultProjection.maxChars !== "number") {
		return { ok: false, error: "prepare request requires resultProjection.maxChars." };
	}
	if (!isRecord(value.parent) || typeof value.parent.depth !== "number" || typeof value.parent.maxDepth !== "number") {
		return { ok: false, error: "prepare request requires parent.depth and parent.maxDepth." };
	}
	if (typeof value.remoteEgressConsent !== "boolean") {
		return { ok: false, error: "prepare request requires remoteEgressConsent to be a boolean." };
	}
	if (!isRecord(value.backend) || !isRecord(value.backend.model)
		|| typeof value.backend.model.provider !== "string" || typeof value.backend.model.id !== "string"
		|| typeof value.backend.thinkingLevel !== "string" || !Array.isArray(value.backend.toolCatalog)) {
		return { ok: false, error: "prepare request requires backend.model, backend.thinkingLevel, and backend.toolCatalog." };
	}
	for (const tool of value.backend.toolCatalog) {
		if (!isRecord(tool) || typeof tool.id !== "string") {
			return { ok: false, error: "prepare request backend.toolCatalog contains a malformed tool." };
		}
	}
	if (!isJsonCompatible(value)) return { ok: false, error: "prepare request is not JSON-compatible." };
	return { ok: true, data: value };
}

export function validatePrepareResponse(value: unknown): ValidationResult {
	if (!isRecord(value)) return { ok: false, error: "prepare response must be an object." };
	if (typeof value.profileId !== "string" || typeof value.systemPrompt !== "string"
		|| !isRecord(value.model) || typeof value.model.provider !== "string" || typeof value.model.id !== "string"
		|| typeof value.thinkingLevel !== "string" || typeof value.preparedAt !== "string"
		|| !Array.isArray(value.messages) || !Array.isArray(value.effectiveToolIds)
		|| !Array.isArray(value.effectiveToolNames) || !Array.isArray(value.diagnostics)
		|| !isRecord(value.profileSnapshot)) {
		return { ok: false, error: "prepare response is missing required fields." };
	}
	if (!isJsonCompatible(value)) return { ok: false, error: "prepare response is not JSON-compatible." };
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
	if (typeof value !== "object") return false; // function, symbol, bigint, undefined
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.every((item) => isJsonCompatible(item, seen));
	return Object.values(value).every((item) => isJsonCompatible(item, seen));
}

// ---------------------------------------------------------------------------
// Wire parsing.
// ---------------------------------------------------------------------------

function parseDiscover(data: unknown): Extract<ForgeHostWireMessage, { type: "discover" }> | undefined {
	if (!isRecord(data) || data.type !== "discover") return undefined;
	const { protocolVersion, minVersion, maxVersion, clientId } = data;
	if (typeof protocolVersion !== "number" || typeof minVersion !== "number" || typeof maxVersion !== "number" || typeof clientId !== "string") return undefined;
	return { type: "discover", protocolVersion, minVersion, maxVersion, clientId };
}

function parseAvailable(data: unknown): Extract<ForgeHostWireMessage, { type: "available" }> | undefined {
	if (!isRecord(data) || data.type !== "available") return undefined;
	const { hostId, protocolVersion, minVersion, maxVersion, capabilities, generation } = data;
	if (typeof hostId !== "string" || typeof protocolVersion !== "number" || typeof minVersion !== "number"
		|| typeof maxVersion !== "number" || !Array.isArray(capabilities) || capabilities.some((cap) => typeof cap !== "string") || typeof generation !== "number") {
		return undefined;
	}
	return { type: "available", hostId, protocolVersion, minVersion, maxVersion, capabilities, generation };
}

function parseRequest(data: unknown): Extract<ForgeHostWireMessage, { type: "request" }> | undefined {
	if (!isRecord(data) || data.type !== "request") return undefined;
	const { requestId, hostId, generation, operation, payload } = data;
	if (typeof requestId !== "string" || typeof hostId !== "string" || typeof generation !== "number" || typeof operation !== "string") return undefined;
	return { type: "request", requestId, hostId, generation, operation, payload };
}

function parseReply(data: unknown): Extract<ForgeHostWireMessage, { type: "reply" }> | undefined {
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

function parseUnavailable(data: unknown): Extract<ForgeHostWireMessage, { type: "unavailable" }> | undefined {
	if (!isRecord(data) || data.type !== "unavailable") return undefined;
	const { hostId, generation } = data;
	if (typeof hostId !== "string" || typeof generation !== "number") return undefined;
	return { type: "unavailable", hostId, generation };
}

function versionCompatible(hostMin: number, hostMax: number, wantMin: number, wantMax: number): boolean {
	return hostMax >= wantMin && wantMax >= hostMin;
}

function normalizeHostResult(result: unknown): ForgeHostPortResult {
	if (isRecord(result) && result.ok === true) return { ok: true, data: result.data };
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
	private readonly transport: ForgeHostTransport;
	private readonly options: ForgeHostOptions;
	readonly hostId: string;
	private generationId = 1;
	private started = false;
	private unsubscribers: (() => void)[] = [];

	constructor(transport: ForgeHostTransport, options: ForgeHostOptions) {
		this.transport = transport;
		this.options = options;
		this.hostId = options.hostId ?? `forge-host-${randomUUID()}`;
	}

	get generation(): number {
		return this.generationId;
	}

	get isLive(): boolean {
		return this.started;
	}

	private availableMessage(): ForgeHostWireMessage {
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

	start(): void {
		if (this.started) return;
		this.started = true;
		this.unsubscribers.push(this.transport.on(FORGE_HOST_CHANNEL.discover, (data) => this.onDiscover(data)));
		this.unsubscribers.push(this.transport.on(FORGE_HOST_CHANNEL.request, (data) => this.onRequest(data)));
		this.transport.emit(FORGE_HOST_CHANNEL.available, this.availableMessage());
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		this.transport.emit(FORGE_HOST_CHANNEL.unavailable, {
			type: "unavailable",
			hostId: this.hostId,
			generation: this.generationId,
		});
		this.generationId += 1;
	}

	private onDiscover(data: unknown): void {
		if (!this.started) return;
		const message = parseDiscover(data);
		if (!message || message.protocolVersion !== FORGE_HOST_PORT_VERSION) return;
		if (!versionCompatible(
			this.options.minVersion ?? FORGE_HOST_PORT_VERSION,
			this.options.maxVersion ?? FORGE_HOST_PORT_VERSION,
			message.minVersion,
			message.maxVersion,
		)) {
			return;
		}
		this.transport.emit(FORGE_HOST_CHANNEL.available, this.availableMessage());
	}

	private onRequest(data: unknown): void {
		if (!this.started) return;
		const message = parseRequest(data);
		if (!message) return;
		// Requests are bound to this host identity and generation; a stale or
		// foreign-generation request must never reach the handler.
		if (message.hostId !== this.hostId || message.generation !== this.generationId) return;

		let result: ForgeHostPortResult;
		try {
			result = typeof this.options.handle === "function"
				? this.options.handle(message.operation, message.payload)
				: { ok: false, error: "Forge host has no operation handler." };
		} catch (error) {
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

// ---------------------------------------------------------------------------
// Client side.
// ---------------------------------------------------------------------------

export interface ForgeHostClientOptions {
	clientId?: string;
	defaultTimeoutMs?: number;
	/** How long after the first compatible host reply to keep collecting others before deciding. */
	discoverSettleMs?: number;
}

export class ForgeHostClient {
	private readonly transport: ForgeHostTransport;
	readonly clientId: string;
	private readonly defaultTimeoutMs: number;
	private readonly discoverSettleMs: number;
	private connectionUnsubscribe?: () => void;
	private unavailableHandlers: (() => void)[] = [];
	private activeConnection?: ForgeHostConnection;

	constructor(transport: ForgeHostTransport, options: ForgeHostClientOptions = {}) {
		this.transport = transport;
		this.clientId = options.clientId ?? `forge-client-${randomUUID()}`;
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
		this.discoverSettleMs = options.discoverSettleMs ?? 25;
	}

	onUnavailable(handler: () => void): () => void {
		if (this.connectionUnsubscribe === undefined) {
			this.connectionUnsubscribe = this.transport.on(FORGE_HOST_CHANNEL.unavailable, (data) => this.onUnavailableMessage(data));
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
					// A throwing client handler must not break host disposal dispatch.
				}
			}
		}
	}

	async discover(timeoutMs?: number): Promise<ForgeHostConnection> {
		const expectedTimeout = timeoutMs ?? this.defaultTimeoutMs;
		return new Promise<ForgeHostConnection>((resolve, reject) => {
			const hosts = new Map<string, ForgeHostConnection>();
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let settleTimer: NodeJS.Timeout | undefined;

			const settle = (error?: ForgeHostPortError, connection?: ForgeHostConnection) => {
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
				if (!message || message.protocolVersion !== FORGE_HOST_PORT_VERSION) return;
				if (!versionCompatible(FORGE_HOST_PORT_VERSION, FORGE_HOST_PORT_VERSION, message.minVersion, message.maxVersion)) return;
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

	connect(connection: ForgeHostConnection): ForgeHostConnection {
		if (this.activeConnection && this.activeConnection.hostId !== connection.hostId) {
			throw new ForgeHostPortError("duplicate", "This client is already connected to another Forge host.");
		}
		this.activeConnection = connection;
		if (this.connectionUnsubscribe === undefined) {
			this.connectionUnsubscribe = this.transport.on(FORGE_HOST_CHANNEL.unavailable, (data) => this.onUnavailableMessage(data));
		}
		return connection;
	}

	async request(
		connection: ForgeHostConnection,
		operation: string,
		payload: unknown,
		timeoutMs?: number,
	): Promise<ForgeHostPortResult> {
		if (this.activeConnection !== connection) {
			return { ok: false, error: `Forge host ${connection.hostId} is not the client's active connection.` };
		}
		if (!FORGE_HOST_PORT_OPERATIONS.includes(operation as ForgeHostPortOperation)) {
			return { ok: false, error: `Unknown Forge host operation: ${operation}` };
		}
		const requestId = randomUUID();
		const expectedTimeout = timeoutMs ?? this.defaultTimeoutMs;

		return new Promise<ForgeHostPortResult>((resolve) => {
			const unsubscribeReply = this.transport.on(FORGE_HOST_CHANNEL.reply, (data) => {
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
				else resolve({ ok: false, error: message.error ?? "Forge host operation failed." });
			});
			const unsubscribeUnavailable = this.transport.on(FORGE_HOST_CHANNEL.unavailable, (data) => {
				const message = parseUnavailable(data);
				if (message && message.hostId === connection.hostId && message.generation === connection.generation) {
					cleanup();
					resolve({ ok: false, error: `Forge host ${connection.hostId} became unavailable.` });
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

	disconnect(): void {
		this.activeConnection = undefined;
		this.teardownPersistentListener();
		this.unavailableHandlers = [];
	}

	get subscriptionCount(): number {
		return this.connectionUnsubscribe === undefined ? 0 : 1;
	}
}
