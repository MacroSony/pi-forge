import type { CapabilityToolPatch } from "./codecs/capability.ts";
import type { SessionCacheUsageView } from "./session-usage.ts";

/** A derived session view, never a second persisted capability state. */
export interface CapabilityStateGuard {
	sessionId: string;
	leafId: string | null;
	revision: string;
}

export interface CapabilityChoice {
	kind: "capability" | "binding";
	id: string;
	label: string;
	content: string;
	tools: CapabilityToolPatch;
	fingerprint: string;
	problem?: string;
}

export interface CapabilityStateView {
	guard: CapabilityStateGuard;
	/** Active loaded Preset fingerprint for inspection freshness, not a write receipt. */
	presetRevision?: string;
	trusted: boolean;
	restoring: boolean;
	delivery: "none" | "pending" | "prepared";
	textPresentation: "native" | "user";
	effectiveTools: string[];
	/** Read-only provider-reported usage for the current branch; absent when unavailable. */
	cacheUsage?: SessionCacheUsageView;
	problem?: string;
	active: Array<{
		activationId: string;
		source: string;
		name?: string;
		actor: "user" | "agent";
		content: string;
		tools: CapabilityToolPatch;
	}>;
}

export type CapabilityStateMutation =
	| { action: "disable"; activationId: string; guard: CapabilityStateGuard }
	| { action: "reset"; guard: CapabilityStateGuard };

export interface CapabilityEnableRequest {
	guard: CapabilityStateGuard;
	kind: "capability" | "binding";
	id: string;
	fingerprint: string;
}

export type CapabilityAvailableResult =
	| { ok: true; state: CapabilityStateView; choices: CapabilityChoice[] }
	| { ok: false; status: number; error: string };

export type CapabilityStateResult =
	| { ok: true; state: CapabilityStateView }
	| { ok: false; status: number; error: string };

/** Exact input validation is shared by HTTP and direct application callers. */
export function isCapabilityStateMutation(value: unknown): value is CapabilityStateMutation {
	if (!plain(value)) return false;
	const keys = value.action === "disable" ? ["action", "activationId", "guard"] : ["action", "guard"];
	if (value.action !== "disable" && value.action !== "reset") return false;
	if (Object.keys(value).some((key) => !keys.includes(key))) return false;
	if (value.action === "disable" && !text(value.activationId, 128)) return false;
	const guard = value.guard;
	return plain(guard) && Object.keys(guard).length === 3
		&& Object.keys(guard).every((key) => ["sessionId", "leafId", "revision"].includes(key))
		&& text(guard.sessionId, 1024) && (guard.leafId === null || text(guard.leafId, 1024))
		&& text(guard.revision, 256);
}

/** Exact validation for the guarded, human-only activation operation. */
export function isCapabilityEnableRequest(value: unknown): value is CapabilityEnableRequest {
	if (!plain(value) || Object.keys(value).length !== 4) return false;
	if (Object.keys(value).some((key) => !["guard", "kind", "id", "fingerprint"].includes(key))) return false;
	if (value.kind !== "capability" && value.kind !== "binding") return false;
	if (!text(value.id, 128) || !text(value.fingerprint, 256)) return false;
	return isGuard(value.guard);
}

function isGuard(value: unknown): value is CapabilityStateGuard {
	return plain(value) && Object.keys(value).length === 3
		&& Object.keys(value).every((key) => ["sessionId", "leafId", "revision"].includes(key))
		&& text(value.sessionId, 1024) && (value.leafId === null || text(value.leafId, 1024))
		&& text(value.revision, 256);
}

function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}

function plain(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
