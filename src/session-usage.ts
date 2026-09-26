/**
 * Read-only prompt-cache usage for the current session branch.
 *
 * Everything here is derived from usage the provider already reported and Pi
 * already persisted. It never changes requests, cache breakpoints, warming or
 * session entries, and it starts no inference.
 */

/** `details` key a tool result may use to report model usage that ran inside the tool call. */
export const FORGE_NESTED_USAGE_KEY = "forgeNestedUsage";

/**
 * Experimental nested-usage contract (schemaVersion 1).
 *
 * A tool whose execution itself calls models (for example a subagent) may put
 * this object at `toolResult.details.forgeNestedUsage`. Token fields follow the
 * pi-ai `Usage` convention: `input` counts only uncached input tokens.
 * `cacheRead` and `cacheWrite` must be given together; omit both when the
 * producer does not know them. The shape may change when its first producer
 * adopts it.
 */
export interface ForgeNestedUsage {
	schemaVersion: 1;
	/** Model requests made during the tool call; zero requires all supplied token counts to be zero. */
	requests: number;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface CacheUsageTotals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface NestedUsageTotals extends CacheUsageTotals {
	/** Tool results carrying a valid contract whose cache counts are included. */
	calls: number;
	/** Valid tool results without cache counts; excluded from all request/token totals above. */
	cacheUnknownCalls: number;
	/** Tool results whose `forgeNestedUsage` value is malformed; ignored. */
	invalidCalls: number;
}

export interface SessionCacheUsageView {
	/** Requests made by the session's own model on the current branch. */
	main: {
		/** Latest usage-bearing assistant request, not necessarily the latest attempted request. */
		lastRequest?: CacheUsageTotals;
		/** Requests after the latest user message. */
		turn: CacheUsageTotals;
		session: CacheUsageTotals;
	};
	/** Usage reported by tool calls through {@link ForgeNestedUsage}; never mixed into `main`. */
	nested: {
		turn: NestedUsageTotals;
		session: NestedUsageTotals;
	};
}

function emptyTotals(): CacheUsageTotals {
	return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function emptyNested(): NestedUsageTotals {
	return { ...emptyTotals(), calls: 0, cacheUnknownCalls: 0, invalidCalls: 0 };
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Strict parser for {@link ForgeNestedUsage}; returns undefined for any malformed value. */
export function parseForgeNestedUsage(value: unknown): ForgeNestedUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const allowed = ["schemaVersion", "requests", "input", "output", "cacheRead", "cacheWrite"];
	if (Object.keys(raw).some((key) => !allowed.includes(key))) return undefined;
	if (raw.schemaVersion !== 1) return undefined;
	if (!isCount(raw.requests) || !isCount(raw.input) || !isCount(raw.output)) return undefined;
	const hasRead = raw.cacheRead !== undefined;
	const hasWrite = raw.cacheWrite !== undefined;
	if (hasRead !== hasWrite) return undefined;
	if (hasRead && (!isCount(raw.cacheRead) || !isCount(raw.cacheWrite))) return undefined;
	if (raw.requests === 0 && [raw.input, raw.output, raw.cacheRead, raw.cacheWrite].some((count) => typeof count === "number" && count > 0)) return undefined;
	return {
		schemaVersion: 1,
		requests: raw.requests,
		input: raw.input,
		output: raw.output,
		...(hasRead ? { cacheRead: raw.cacheRead as number, cacheWrite: raw.cacheWrite as number } : {}),
	};
}

function messageOf(entry: unknown): Record<string, unknown> | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as { type?: unknown; message?: unknown };
	if (record.type !== "message" || !record.message || typeof record.message !== "object") return undefined;
	return record.message as Record<string, unknown>;
}

function requestUsage(message: Record<string, unknown>): CacheUsageTotals | undefined {
	if (message.role !== "assistant") return undefined;
	const usage = message.usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return undefined;
	const totals = {
		requests: 1,
		input: tokenCount(usage.input),
		output: tokenCount(usage.output),
		cacheRead: tokenCount(usage.cacheRead),
		cacheWrite: tokenCount(usage.cacheWrite),
	};
	// Aborted or failed requests can persist without any reported usage.
	return totals.input + totals.output + totals.cacheRead + totals.cacheWrite > 0 ? totals : undefined;
}

function add(target: CacheUsageTotals, value: CacheUsageTotals): void {
	target.requests += value.requests;
	target.input += value.input;
	target.output += value.output;
	target.cacheRead += value.cacheRead;
	target.cacheWrite += value.cacheWrite;
}

function addNested(target: NestedUsageTotals, details: unknown): void {
	if (!details || typeof details !== "object" || !(FORGE_NESTED_USAGE_KEY in details)) return;
	const usage = parseForgeNestedUsage((details as Record<string, unknown>)[FORGE_NESTED_USAGE_KEY]);
	if (!usage) {
		target.invalidCalls += 1;
		return;
	}
	if (usage.cacheRead === undefined || usage.cacheWrite === undefined) {
		target.cacheUnknownCalls += 1;
		return;
	}
	target.calls += 1;
	add(target, { requests: usage.requests, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
}

/** Summarize provider-reported usage from current-branch session entries (root to leaf). */
export function summarizeSessionCacheUsage(entries: readonly unknown[]): SessionCacheUsageView {
	let turnStart = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (messageOf(entries[index])?.role === "user") {
			turnStart = index + 1;
			break;
		}
	}

	const view: SessionCacheUsageView = {
		main: { turn: emptyTotals(), session: emptyTotals() },
		nested: { turn: emptyNested(), session: emptyNested() },
	};
	entries.forEach((entry, index) => {
		const message = messageOf(entry);
		if (!message) return;
		const inTurn = index >= turnStart;
		const request = requestUsage(message);
		if (request) {
			add(view.main.session, request);
			if (inTurn) add(view.main.turn, request);
			view.main.lastRequest = request;
		}
		if (message.role === "toolResult") {
			addNested(view.nested.session, message.details);
			if (inTurn) addNested(view.nested.turn, message.details);
		}
	});
	return view;
}

/** cacheRead / (uncached input + cacheRead + cacheWrite); undefined when nothing was sent. */
export function cacheHitRate(totals: Pick<CacheUsageTotals, "input" | "cacheRead" | "cacheWrite">): number | undefined {
	const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	return prompt > 0 ? totals.cacheRead / prompt : undefined;
}
