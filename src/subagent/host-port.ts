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
	| { type: "request"; requestId: string; operation: string; payload: unknown }
	| { type: "reply"; requestId: string; ok: boolean; data?: unknown; error?: string }
	| { type: "unavailable"; hostId: string; generation: number };

export type ForgeHostPortResult =
	| { ok: true; data: unknown }
	| { ok: false; error: string };

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

const DEFAULT_CLIENT_TIMEOUT_MS = 2_000;

export class ForgeHostPortError extends Error {
	readonly code: "timeout" | "duplicate" | "unavailable" | "protocol" | "invalid";
	constructor(code: ForgeHostPortError["code"], message: string) {
		super(message);
		this.code = code;
	}
}

function normalizeHostResult(result: unknown): ForgeHostPortResult {
	if (isRecord(result) && result.ok === true) {
		return { ok: true, data: result.data };
	}
	if (isRecord(result) && result.ok === false) {
		return { ok: false, error: typeof result.error === "string" && result.error ? result.error : "Forge host operation failed." };
	}
	return { ok: false, error: "Forge host returned a malformed operation result." };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function versionCompatible(
	hostMin: number,
	hostMax: number,
	wantMin: number,
	wantMax: number,
): boolean {
	return hostMax >= wantMin && wantMax >= hostMin;
}

function parseDiscover(data: unknown): Extract<ForgeHostWireMessage, { type: "discover" }> | undefined {
	if (!isRecord(data) || data.type !== "discover") return undefined;
	const { protocolVersion, minVersion, maxVersion, clientId } = data;
	if (
		typeof protocolVersion !== "number"
		|| typeof minVersion !== "number"
		|| typeof maxVersion !== "number"
		|| typeof clientId !== "string"
	) {
		return undefined;
	}
	return { type: "discover", protocolVersion, minVersion, maxVersion, clientId };
}

function parseRequest(data: unknown): Extract<ForgeHostWireMessage, { type: "request" }> | undefined {
	if (!isRecord(data) || data.type !== "request") return undefined;
	const { requestId, operation, payload } = data;
	if (typeof requestId !== "string" || typeof operation !== "string") return undefined;
	return { type: "request", requestId, operation, payload };
}

function parseAvailable(data: unknown): Extract<ForgeHostWireMessage, { type: "available" }> | undefined {
	if (!isRecord(data) || data.type !== "available") return undefined;
	const { hostId, protocolVersion, minVersion, maxVersion, capabilities, generation } = data;
	if (
		typeof hostId !== "string"
		|| typeof protocolVersion !== "number"
		|| typeof minVersion !== "number"
		|| typeof maxVersion !== "number"
		|| !Array.isArray(capabilities)
		|| capabilities.some((cap) => typeof cap !== "string")
		|| typeof generation !== "number"
	) {
		return undefined;
	}
	return { type: "available", hostId, protocolVersion, minVersion, maxVersion, capabilities, generation };
}

function parseReply(data: unknown): Extract<ForgeHostWireMessage, { type: "reply" }> | undefined {
	if (!isRecord(data) || data.type !== "reply") return undefined;
	const { requestId, ok } = data;
	if (typeof requestId !== "string" || typeof ok !== "boolean") return undefined;
	return {
		type: "reply",
		requestId,
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

/** Host side: registers discover/request listeners and owns generation + disposal. */
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
		// Announce so already-subscribed clients learn about this host.
		this.transport.emit(FORGE_HOST_CHANNEL.available, this.availableMessage());
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		// Unsubscribe first so a client handler that throws cannot abort teardown
		// or leave discover/request listeners registered.
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
		if (
			!versionCompatible(
				this.options.minVersion ?? FORGE_HOST_PORT_VERSION,
				this.options.maxVersion ?? FORGE_HOST_PORT_VERSION,
				message.minVersion,
				message.maxVersion,
			)
		) {
			return;
		}
		this.transport.emit(FORGE_HOST_CHANNEL.available, this.availableMessage());
	}

	private onRequest(data: unknown): void {
		if (!this.started) return;
		const message = parseRequest(data);
		if (!message) return;
		let result: ForgeHostPortResult;
		try {
			result = typeof this.options.handle === "function"
				? this.options.handle(message.operation, message.payload)
				: { ok: false, error: "Forge host has no operation handler." };
		} catch (error) {
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

export interface ForgeHostClientOptions {
	clientId?: string;
	defaultTimeoutMs?: number;
	/** How long after the first compatible host reply to keep collecting others before deciding. */
	discoverSettleMs?: number;
}

/** Client side: bounded-discovery, correlation-based requests, and listener cleanup. */
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

	/** Subscribe to host-disposal events until disconnect(). */
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
			// Keep the persistent listener while connected so later requests still
			// observe disposal; only release it when nothing is waiting on it.
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

	/** Discover a single compatible host; duplicate hosts or timeout fail explicitly. */
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
				if (
					!versionCompatible(
						FORGE_HOST_PORT_VERSION,
						FORGE_HOST_PORT_VERSION,
						message.minVersion,
						message.maxVersion,
					)
				) {
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

	/** Invoke a documented operation with correlation and a bounded timeout. */
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
				if (!message || message.requestId !== requestId) return;
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
			this.transport.emit(FORGE_HOST_CHANNEL.request, { type: "request", requestId, operation, payload });
		});
	}

	/** Disconnect: drop all subscriptions and forget the active connection. */
	disconnect(): void {
		this.activeConnection = undefined;
		this.teardownPersistentListener();
		this.unavailableHandlers = [];
	}

	/** Number of persistent bus subscriptions owned by this client (for cleanup tests). */
	get subscriptionCount(): number {
		return this.connectionUnsubscribe === undefined ? 0 : 1;
	}
}

