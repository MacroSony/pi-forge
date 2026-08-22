/**
 * Host-neutral rolling context-diff history.
 *
 * Keeps the last N turn snapshots captured from provider payloads and exposes
 * the latest engine-computed diff plus compact summaries for recent turns.
 */
import { diffTurns, turnApproxTokens, type TurnDiff, type TurnSnapshot } from "./context-diff.ts";
import { extractTurnSnapshot, type ContextDiffCapture } from "./context-diff-snapshot.ts";

export const CONTEXT_DIFF_HISTORY_LIMIT = 20;

export interface ContextDiffHistory {
	turns: TurnSnapshot[];
	latestDiff?: TurnDiff;
	nextTurnNumber?: number;
	usageByTurnId: Map<string, ContextDiffProviderUsage>;
	cacheReportingModels: Set<string>;
}

export interface ContextDiffProviderUsageInput {
	provider: string;
	model: string;
	stopReason: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface ContextDiffProviderUsage extends ContextDiffProviderUsageInput {
	promptTokens: number;
	cacheHitRatio: number | null;
	cacheStatus: "reported" | "not-reported";
}

export interface ContextDiffTurnSummary {
	turnId: string;
	capturedAt: string;
	stackId: string;
	approxTokens: number;
	blockCount: number;
	chars: number;
	deltaTokens?: number;
	prefixTokens?: number;
	prefixRatio?: number;
	changedBlocks?: number;
	usage?: ContextDiffProviderUsage;
}

export interface ContextDiffView {
	turns: ContextDiffTurnSummary[];
	latest: { turn: TurnSnapshot; diff: TurnDiff; usage?: ContextDiffProviderUsage } | null;
	latestDiff: TurnDiff | null;
}

export function createContextDiffHistory(): ContextDiffHistory {
	return {
		turns: [],
		nextTurnNumber: 1,
		usageByTurnId: new Map(),
		cacheReportingModels: new Set(),
	};
}

/** Append a captured payload, evict old turns past the limit, and compute the latest diff. */
export function appendContextDiffCapture(
	history: ContextDiffHistory,
	capture: ContextDiffCapture,
): TurnDiff | undefined {
	const nextTurnNumber = history.nextTurnNumber ?? 1;
	const turnId = capture.turnId ?? `turn-${nextTurnNumber}`;
	history.nextTurnNumber = nextTurnNumber + 1;
	const snapshot = extractTurnSnapshot({
		...capture,
		turnId,
	});
	const previous = history.turns.at(-1);
	history.turns.push(snapshot);
	if (history.turns.length > CONTEXT_DIFF_HISTORY_LIMIT) {
		const evicted = history.turns.shift();
		if (evicted) history.usageByTurnId.delete(evicted.turnId);
	}
	const diff = diffTurns(previous, snapshot);
	history.latestDiff = diff;
	return diff;
}

/** Attach the authoritative usage returned on the assistant message for one captured provider request. */
export function attachContextDiffUsage(
	history: ContextDiffHistory,
	turnId: string,
	usage: ContextDiffProviderUsageInput,
): boolean {
	if (!history.turns.some((turn) => turn.turnId === turnId)) return false;
	const modelKey = `${usage.provider}/${usage.model}`;
	const currentReportsCache = usage.cacheRead > 0 || usage.cacheWrite > 0;
	const cacheReported = currentReportsCache || history.cacheReportingModels.has(modelKey);
	if (currentReportsCache) history.cacheReportingModels.add(modelKey);
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	history.usageByTurnId.set(turnId, {
		...usage,
		promptTokens,
		cacheHitRatio: cacheReported && promptTokens > 0 ? usage.cacheRead / promptTokens : null,
		cacheStatus: cacheReported ? "reported" : "not-reported",
	});
	return true;
}

/** Build the response-shaped view: compact summaries for recent turns + latest full diff. */
export function getContextDiffView(history: ContextDiffHistory): ContextDiffView {
	const turns = history.turns.map((turn, index) => {
		const previous = index > 0 ? history.turns[index - 1] : undefined;
		const diff = diffTurns(previous, turn);
		return {
			turnId: turn.turnId,
			capturedAt: turn.capturedAt,
			stackId: turn.stackId,
			approxTokens: turnApproxTokens(turn),
			blockCount: turn.blocks.length,
			chars: turn.blocks.reduce((sum, block) => sum + block.chars, 0),
			deltaTokens: diff.deltaTokens,
			prefixTokens: diff.prefixTokens,
			prefixRatio: diff.prefixRatio,
			changedBlocks: diff.summary.changedBlocks,
			usage: history.usageByTurnId.get(turn.turnId),
		};
	});
	const latest = history.turns.length > 0 && history.latestDiff
		? {
			turn: history.turns[history.turns.length - 1]!,
			diff: history.latestDiff,
			usage: history.usageByTurnId.get(history.turns[history.turns.length - 1]!.turnId),
		}
		: null;
	return { turns, latest, latestDiff: history.latestDiff ?? null };
}
