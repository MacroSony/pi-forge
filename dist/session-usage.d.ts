/**
 * Read-only prompt-cache usage for the current session branch.
 *
 * Everything here is derived from usage the provider already reported and Pi
 * already persisted. It never changes requests, cache breakpoints, warming or
 * session entries, and it starts no inference.
 */
/** `details` key a tool result may use to report model usage that ran inside the tool call. */
export declare const FORGE_NESTED_USAGE_KEY = "forgeNestedUsage";
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
/** Strict parser for {@link ForgeNestedUsage}; returns undefined for any malformed value. */
export declare function parseForgeNestedUsage(value: unknown): ForgeNestedUsage | undefined;
/** Summarize provider-reported usage from current-branch session entries (root to leaf). */
export declare function summarizeSessionCacheUsage(entries: readonly unknown[]): SessionCacheUsageView;
/** cacheRead / (uncached input + cacheRead + cacheWrite); undefined when nothing was sent. */
export declare function cacheHitRate(totals: Pick<CacheUsageTotals, "input" | "cacheRead" | "cacheWrite">): number | undefined;
//# sourceMappingURL=session-usage.d.ts.map