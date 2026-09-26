import type { InstructionToolPatch } from "./codecs/instruction-mode.ts";
import type { SessionCacheUsageView } from "./session-usage.ts";

/** A derived session view, never a second persisted instruction state. */
export interface InstructionStateGuard {
	sessionId: string;
	leafId: string | null;
	revision: string;
}

export interface InstructionChoice {
	kind: "mode" | "binding";
	id: string;
	label: string;
	content: string;
	tools: InstructionToolPatch;
	fingerprint: string;
	problem?: string;
}

export interface InstructionStateView {
	guard: InstructionStateGuard;
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
		tools: InstructionToolPatch;
	}>;
}

export type InstructionStateMutation =
	| { action: "off"; activationId: string; guard: InstructionStateGuard }
	| { action: "reset"; guard: InstructionStateGuard };

export interface InstructionUseRequest {
	guard: InstructionStateGuard;
	kind: "mode" | "binding";
	id: string;
	fingerprint: string;
}

export type InstructionAvailableResult =
	| { ok: true; state: InstructionStateView; choices: InstructionChoice[] }
	| { ok: false; status: number; error: string };

export type InstructionStateResult =
	| { ok: true; state: InstructionStateView }
	| { ok: false; status: number; error: string };

/** Exact input validation is shared by HTTP and direct application callers. */
export function isInstructionStateMutation(value: unknown): value is InstructionStateMutation {
	if (!plain(value)) return false;
	const keys = value.action === "off" ? ["action", "activationId", "guard"] : ["action", "guard"];
	if (value.action !== "off" && value.action !== "reset") return false;
	if (Object.keys(value).some((key) => !keys.includes(key))) return false;
	if (value.action === "off" && !text(value.activationId, 128)) return false;
	const guard = value.guard;
	return plain(guard) && Object.keys(guard).length === 3
		&& Object.keys(guard).every((key) => ["sessionId", "leafId", "revision"].includes(key))
		&& text(guard.sessionId, 1024) && (guard.leafId === null || text(guard.leafId, 1024))
		&& text(guard.revision, 256);
}

/** Exact validation for the guarded, human-only activation operation. */
export function isInstructionUseRequest(value: unknown): value is InstructionUseRequest {
	if (!plain(value) || Object.keys(value).length !== 4) return false;
	if (Object.keys(value).some((key) => !["guard", "kind", "id", "fingerprint"].includes(key))) return false;
	if (value.kind !== "mode" && value.kind !== "binding") return false;
	if (!text(value.id, 128) || !text(value.fingerprint, 256)) return false;
	return isGuard(value.guard);
}

function isGuard(value: unknown): value is InstructionStateGuard {
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
