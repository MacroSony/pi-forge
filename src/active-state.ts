import { createHash, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { resolve } from "node:path";

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

export const FORGE_ACTIVE_STATE_SCHEMA_VERSION = "1" as const;
export const FORGE_ACTIVE_STATE_CHANNEL = "@zihanw/pi-forge/active-state/v1";
export const FORGE_ACTIVE_STATE_REQUEST_CHANNEL = "@zihanw/pi-forge/active-state/request/v1";

/** Hash domain separator from the parent contract. Do not change without a new version. */
export const FORGE_ACTIVE_STATE_PROJECT_KEY_PREFIX = "pi-forge-project-v1\0";

/**
 * Scoped resource key grammar from the parent contract. Stricter than the
 * internal resource grammar (length-bounded, exactly one colon).
 */
export const FORGE_ACTIVE_STATE_SCOPED_KEY_PATTERN = /^(global|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Opaque lower-hex SHA-256 project key. */
export const FORGE_ACTIVE_STATE_PROJECT_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Bounded publisher-instance grammar shared with the downstream Pi Pet/Clawd
 * appearance consumer. UUIDs pass; control characters, path separators, and
 * other punctuation are rejected so an instance id can never look like a path
 * or smuggle control bytes across the bus.
 */
export const FORGE_ACTIVE_STATE_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const FORGE_ACTIVE_STATE_MAX_SESSION_ID_LENGTH = 1024;
export const FORGE_ACTIVE_STATE_MAX_INSTANCE_ID_LENGTH = 128;

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

export type ActiveStateValidationResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: string };

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

export function isValidActiveStateSessionId(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= FORGE_ACTIVE_STATE_MAX_SESSION_ID_LENGTH;
}

export function isValidActiveStateScopedKey(value: unknown): value is string {
	return typeof value === "string" && FORGE_ACTIVE_STATE_SCOPED_KEY_PATTERN.test(value);
}

export function isValidActiveStateProjectKey(value: unknown): value is string {
	return typeof value === "string" && FORGE_ACTIVE_STATE_PROJECT_KEY_PATTERN.test(value);
}

export function isValidActiveStateInstanceId(value: unknown): value is string {
	return typeof value === "string" && FORGE_ACTIVE_STATE_INSTANCE_ID_PATTERN.test(value);
}

/**
 * Opaque project identity from the session working directory. The raw path and
 * hostname never leave this function; only the 64-char digest crosses the bus.
 */
export function activeStateProjectKey(cwd: string, hostnameValue: string = osHostname()): string | null {
	if (typeof cwd !== "string" || cwd.length === 0) return null;
	let resolved: string;
	try {
		resolved = resolve(cwd);
	} catch {
		return null;
	}
	return createHash("sha256")
		.update(`${FORGE_ACTIVE_STATE_PROJECT_KEY_PREFIX}${hostnameValue}\0${resolved}`)
		.digest("hex");
}

export function validateActiveStateRequest(value: unknown): ActiveStateValidationResult<ForgeActiveStateRequest> {
	if (!isPlainRecord(value)) return { ok: false, error: "active-state request must be an object." };
	for (const key of Object.keys(value)) {
		if (key !== "schemaVersion" && key !== "sessionId") {
			return { ok: false, error: `active-state request contains unsupported field: ${key}.` };
		}
	}
	if (value.schemaVersion !== FORGE_ACTIVE_STATE_SCHEMA_VERSION) {
		return { ok: false, error: "active-state request has an unsupported schemaVersion." };
	}
	if (value.sessionId !== undefined && !isValidActiveStateSessionId(value.sessionId)) {
		return { ok: false, error: "active-state request sessionId is malformed or oversized." };
	}
	return {
		ok: true,
		data: {
			schemaVersion: FORGE_ACTIVE_STATE_SCHEMA_VERSION,
			...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
		},
	};
}

export function validateActiveStateEvent(value: unknown): ActiveStateValidationResult<ForgeActiveStateEvent> {
	if (!isPlainRecord(value)) return { ok: false, error: "active-state event must be an object." };
	const allowed = new Set(["schemaVersion", "sessionId", "instanceId", "revision", "stackKey", "profileKey", "projectKey"]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) return { ok: false, error: `active-state event contains unsupported field: ${key}.` };
	}
	if (value.schemaVersion !== FORGE_ACTIVE_STATE_SCHEMA_VERSION) {
		return { ok: false, error: "active-state event has an unsupported schemaVersion." };
	}
	if (!isValidActiveStateSessionId(value.sessionId)) {
		return { ok: false, error: "active-state event sessionId is malformed or oversized." };
	}
	if (!isValidActiveStateInstanceId(value.instanceId)) {
		return { ok: false, error: "active-state event instanceId is malformed or oversized." };
	}
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) {
		return { ok: false, error: "active-state event revision must be a non-negative safe integer." };
	}
	if (value.stackKey !== null && !isValidActiveStateScopedKey(value.stackKey)) {
		return { ok: false, error: "active-state event stackKey is malformed." };
	}
	if (value.profileKey !== null && !isValidActiveStateScopedKey(value.profileKey)) {
		return { ok: false, error: "active-state event profileKey is malformed." };
	}
	if (value.projectKey !== null && !isValidActiveStateProjectKey(value.projectKey)) {
		return { ok: false, error: "active-state event projectKey is malformed." };
	}
	// Project resource bindings require an opaque projectKey. Fail closed so a
	// consumer can never bind a project-scoped stack/profile to a missing key.
	if (value.projectKey === null) {
		for (const key of [value.stackKey, value.profileKey]) {
			if (typeof key === "string" && key.startsWith("project:")) {
				return { ok: false, error: "active-state event carries a project-scoped binding without a projectKey." };
			}
		}
	}
	return { ok: true, data: value as unknown as ForgeActiveStateEvent };
}

/**
 * Publishes active-state snapshots on the neutral channel and answers
 * late-subscriber snapshot requests. One publisher instance corresponds to one
 * attached Pi session identity; a session-id change retires the old instance
 * (after a final cleared snapshot) and attaches a new instance.
 */
export class ForgeActiveStatePublisher {
	private readonly transport: ActiveStateTransport;
	private readonly read: () => ForgeActiveStateWorkspaceView;
	private readonly hostnameValue: string;
	private readonly createInstanceId: () => string;
	private sessionValue?: ForgeActiveStateSession;
	private instanceIdValue?: string;
	private revisionValue = 0;
	private requestUnsubscribe?: () => void;
	private requestListenerAttached = false;
	private suspended = false;

	constructor(options: ForgeActiveStatePublisherOptions) {
		this.transport = options.transport;
		this.read = options.readWorkspace;
		this.hostnameValue = options.hostname ?? osHostname();
		this.createInstanceId = options.createInstanceId ?? (() => randomUUID());
	}

	get attached(): boolean {
		return this.sessionValue !== undefined && this.instanceIdValue !== undefined;
	}

	get sessionId(): string | undefined {
		return this.sessionValue?.sessionId;
	}

	get instanceId(): string | undefined {
		return this.instanceIdValue;
	}

	get revision(): number {
		return this.revisionValue;
	}

	/**
	 * Pause publication and request replies while a lifecycle restore is in
	 * flight. The workspace publishes several intermediate snapshots during
	 * `restoreBranchScopedRuntime`; emitting those would leak the new workspace
	 * under the old session id before the publisher is rebound. Call
	 * `bindSession` once the restore is complete to resume with the latest
	 * coherent snapshot.
	 */
	suspend(): void {
		this.suspended = true;
	}

	/** Bind or rebind the Pi session, resume publication, and publish the current snapshot. */
	bindSession(session: ForgeActiveStateSession): void {
		if (!isValidActiveStateSessionId(session?.sessionId)) {
			// Invalid session context: fail closed instead of retaining a stale
			// binding that no consumer can safely attribute.
			this.dispose();
			return;
		}
		if (this.sessionValue && this.sessionValue.sessionId !== session.sessionId) {
			// Emit the retiring session's clear only after the restore has
			// completed, so no intermediate workspace snapshot leaks under the
			// wrong session id.
			this.dispose();
			// A synchronous clear callback may have installed another session.
			// Do not overwrite that newer binding from this stale bind call.
			if (this.sessionValue) return;
		}
		if (!this.instanceIdValue) {
			this.instanceIdValue = this.createInstanceId();
			this.revisionValue = 0;
		}
		this.sessionValue = { sessionId: session.sessionId, cwd: session.cwd };
		this.ensureRequestListener();
		// Resume only after the complete new state and listener are installed.
		this.suspended = false;
		this.publish();
	}

	/** Publish the current workspace view with a fresh revision. */
	publish(): void {
		if (this.suspended) return;
		if (!this.sessionValue || !this.instanceIdValue) return;
		const epoch = this.advanceEpoch();
		this.emitEvent(this.buildEvent(this.readSafely(), epoch.instanceId, epoch.revision));
	}

	/**
	 * Emit one final cleared snapshot for the bound session, unregister the
	 * request listener, and detach. Safe to call more than once.
	 */
	dispose(): void {
		const session = this.sessionValue;
		let clear: ForgeActiveStateEvent | undefined;
		if (session && this.instanceIdValue) {
			const epoch = this.advanceEpoch();
			clear = this.buildClearEvent(session, epoch.instanceId, epoch.revision);
		}

		// Retire the old lifecycle before publishing its clear. A synchronous
		// consumer callback must not be able to request/publish/dispose through
		// the old binding or recurse into another clear.
		this.suspended = true;
		this.unsubscribeRequest();
		this.sessionValue = undefined;
		this.instanceIdValue = undefined;
		this.revisionValue = 0;
		this.emitEvent(clear);
		// Preserve a reentrant bind's resumed state; otherwise restore the
		// historical post-dispose state for a later bind.
		if (!this.sessionValue && !this.instanceIdValue) this.suspended = false;
	}

	private ensureRequestListener(): void {
		if (this.requestListenerAttached) return;
		let unsubscribe: (() => void) | undefined;
		try {
			unsubscribe = this.transport.on(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, (data) => this.onRequest(data));
		} catch {
			// Optional bus registration must never break Forge lifecycle.
			return;
		}
		this.requestListenerAttached = true;
		this.requestUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : undefined;
	}

	private unsubscribeRequest(): void {
		const unsubscribe = this.requestUnsubscribe;
		this.requestUnsubscribe = undefined;
		this.requestListenerAttached = false;
		if (!unsubscribe) return;
		try {
			unsubscribe();
		} catch {
			// Optional bus teardown must never break Forge lifecycle.
		}
	}

	private onRequest(data: unknown): void {
		// Suppress snapshot replies while a restore is in flight: the only
		// complete answer is the snapshot published once the rebind completes.
		if (this.suspended) return;
		const request = validateActiveStateRequest(data);
		if (!request.ok) return;
		if (!this.sessionValue || !this.instanceIdValue) return;
		if (request.data.sessionId !== undefined && request.data.sessionId !== this.sessionValue.sessionId) return;
		// Snapshot requests repeat the current revision rather than advancing it.
		this.emitEvent(this.buildEvent(this.readSafely(), this.instanceIdValue, this.revisionValue));
	}

	private buildEvent(
		view: ForgeActiveStateWorkspaceView,
		instanceId: string,
		revision: number,
	): ForgeActiveStateEvent | undefined {
		const session = this.sessionValue;
		if (!session) return undefined;
		const projectKey = activeStateProjectKey(session.cwd, this.hostnameValue);
		const stackCandidate = isValidActiveStateScopedKey(view.stackKey) ? view.stackKey : null;
		// Project-scoped bindings require a project key. An empty/unresolvable
		// cwd must fail closed rather than emit a snapshot the contract rejects,
		// and the profile provenance must be dropped with it: the profile matched
		// a stack we cannot safely identify.
		const droppedProjectBinding = projectKey === null && stackCandidate !== null && stackCandidate.startsWith("project:");
		const stackKey = droppedProjectBinding ? null : stackCandidate;
		return {
			schemaVersion: FORGE_ACTIVE_STATE_SCHEMA_VERSION,
			sessionId: session.sessionId,
			instanceId,
			revision,
			stackKey,
			profileKey: droppedProjectBinding ? null : compatibleProfileKey(view.profile, stackKey, projectKey),
			projectKey,
		};
	}

	private buildClearEvent(
		session: ForgeActiveStateSession,
		instanceId: string,
		revision: number,
	): ForgeActiveStateEvent {
		return {
			schemaVersion: FORGE_ACTIVE_STATE_SCHEMA_VERSION,
			sessionId: session.sessionId,
			instanceId,
			revision,
			stackKey: null,
			profileKey: null,
			projectKey: activeStateProjectKey(session.cwd, this.hostnameValue),
		};
	}

	private emitEvent(event: ForgeActiveStateEvent | undefined): void {
		if (!event) return;
		// Defense in depth: never put a self-rejected snapshot on the bus.
		if (!validateActiveStateEvent(event).ok) return;
		try {
			this.transport.emit(FORGE_ACTIVE_STATE_CHANNEL, event);
		} catch {
			// Optional bus failures must never affect Forge lifecycle or
			// provider behavior.
		}
	}

	private readSafely(): ForgeActiveStateWorkspaceView {
		try {
			const view = this.read();
			return view && typeof view === "object" ? view : {};
		} catch {
			// Optional listeners/readers must never alter Forge behavior.
			return {};
		}
	}

	private advanceEpoch(): { instanceId: string; revision: number } {
		if (this.revisionValue >= Number.MAX_SAFE_INTEGER) {
			// Rotate to a fresh instance at the safe-integer boundary. Rolling
			// the revision back to 1 on the same instance would look stale to
			// consumers that reject non-increasing revisions.
			this.instanceIdValue = this.createInstanceId();
			this.revisionValue = 1;
		} else {
			this.revisionValue += 1;
		}
		return { instanceId: this.instanceIdValue!, revision: this.revisionValue };
	}
}

/**
 * A profile binding is cosmetic compatibility provenance, not a claim that the
 * current model/tool policy still matches the profile. It is retained only
 * while the profile's recorded prompt stack equals the effective stack.
 */
function compatibleProfileKey(
	profile: ForgeActiveStateWorkspaceProfile | undefined,
	stackKey: string | null,
	projectKey: string | null,
): string | null {
	if (!profile || typeof profile.profileId !== "string") return null;
	const scope = profile.scope === "global" || profile.scope === "project" ? profile.scope : "project";
	const candidate = `${scope}:${profile.profileId}`;
	if (!isValidActiveStateScopedKey(candidate)) return null;
	// A project-scoped profile binding is only meaningful with a project key.
	if (scope === "project" && projectKey === null) return null;
	const recordedStack = typeof profile.promptStack === "string" ? profile.promptStack : null;
	if (recordedStack !== stackKey) return null;
	return candidate;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
