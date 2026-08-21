/**
 * Host-neutral context diff engine.
 *
 * Pure functions only: no DOM, no Vue, no Node APIs. Consecutive turn
 * snapshots are compared with a simple prefix-walk that models KV-cache
 * reuse without attempting a full Myers diff.
 */

export interface Block {
	key: string;
	role: string;
	text: string;
	chars: number;
	approxTokens: number;
	hash: string;
}

export interface TurnSnapshot {
	turnId: string;
	capturedAt: string;
	stackId: string;
	blocks: Block[];
}

export type DiffBlockStatus = "same" | "added" | "removed" | "modified";

export interface DiffBlock {
	status: DiffBlockStatus;
	before?: Block;
	after?: Block;
	tokenDelta: number;
}

export interface TurnDiffSummary {
	sameBlocks: number;
	addedBlocks: number;
	removedBlocks: number;
	modifiedBlocks: number;
	changedBlocks: number;
	/** Net tokens introduced by added or lengthened modified blocks. */
	addedTokens: number;
	/** Net tokens removed by removed or shortened modified blocks. */
	removedTokens: number;
	/** Net total token change (`addedTokens - removedTokens`). */
	netTokens: number;
}

export interface TurnDiff {
	blocks: DiffBlock[];
	prefixTokens: number;
	prefixRatio: number;
	deltaTokens: number;
	summary: TurnDiffSummary;
}

/** Estimate tokens from characters using the same chars/4 approximation as payload capture. */
export function estimateApproxTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

/** Pure string hash used as the block identity shortcut. */
export function hashText(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createBlock(key: string, role: string, text: string, serialized?: unknown): Block {
	const hashInput = serialized === undefined
		? { role, text }
		: { role, text, serialized };
	const serializedHashInput = stringifyHashInput(hashInput);
	return {
		key,
		role,
		text,
		chars: text.length,
		approxTokens: estimateApproxTokens(text),
		hash: hashText(serializedHashInput),
	};
}

export function createTurnSnapshot(input: {
	turnId: string;
	capturedAt?: string;
	stackId?: string;
	blocks?: Block[];
}): TurnSnapshot {
	return {
		turnId: input.turnId,
		capturedAt: input.capturedAt ?? "",
		stackId: input.stackId ?? "",
		blocks: input.blocks ?? [],
	};
}

export function turnApproxTokens(turn: TurnSnapshot): number {
	const chars = turn.blocks.reduce((sum, block) => sum + block.chars, 0);
	return chars === 0 ? 0 : Math.ceil(chars / 4);
}

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let index = 0;
	while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) {
		index++;
	}
	return index;
}

function stringifyHashInput(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

/**
 * A block hash includes fields that affect the provider wire request, while
 * the visible block text remains the useful prompt excerpt. When a hash
 * differs because metadata changed without changing the excerpt, no part of
 * that excerpt is safe to count as a reusable prefix.
 */
function safeCommonPrefixLength(before: Block, after: Block): number {
	if (before.role !== after.role || before.text === after.text) return 0;
	return commonPrefixLength(before.text, after.text);
}

function classify(before: Block | undefined, after: Block | undefined): DiffBlock {
	if (before && after) {
		if (before.hash === after.hash) {
			return { status: "same", before, after, tokenDelta: 0 };
		}
		return {
			status: "modified",
			before,
			after,
			tokenDelta: 0,
		};
	}
	if (before) {
		return { status: "removed", before, tokenDelta: 0 };
	}
	return { status: "added", after, tokenDelta: 0 };
}

/**
 * Allocate the request-level chars/4 delta across changed blocks. Per-block
 * token deltas are deliberately based on character deltas, with the single
 * request-level rounding remainder distributed across blocks so the chips and
 * summary describe the same integer total.
 */
function assignTokenDeltas(blocks: DiffBlock[], deltaTokens: number): void {
	const candidates = blocks
		.map((block) => ({
			block,
			charDelta: (block.after?.chars ?? 0) - (block.before?.chars ?? 0),
		}))
		.filter(({ block, charDelta }) => block.status !== "same" && charDelta !== 0);
	if (candidates.length === 0) return;

	let allocated = 0;
	for (const candidate of candidates) {
		candidate.block.tokenDelta = Math.trunc(candidate.charDelta / 4);
		allocated += candidate.block.tokenDelta;
	}

	let remainder = deltaTokens - allocated;
	if (remainder === 0) return;
	const direction = remainder > 0 ? 1 : -1;
	const preferred = candidates.filter(({ charDelta }) => direction > 0 ? charDelta > 0 : charDelta < 0);
	const targets = preferred.length > 0 ? preferred : candidates;
	const wholeShare = Math.trunc(Math.abs(remainder) / targets.length);
	if (wholeShare > 0) {
		for (const target of targets) target.block.tokenDelta += direction * wholeShare;
		remainder -= direction * wholeShare * targets.length;
	}
	for (let index = 0; remainder !== 0; index++) {
		targets[index % targets.length]!.block.tokenDelta += direction;
		remainder -= direction;
	}
}

function summarize(blocks: DiffBlock[], netTokens: number): TurnDiffSummary {
	let sameBlocks = 0;
	let addedBlocks = 0;
	let removedBlocks = 0;
	let modifiedBlocks = 0;
	let addedTokens = 0;
	let removedTokens = 0;

	for (const block of blocks) {
		switch (block.status) {
			case "same":
				sameBlocks++;
				break;
			case "added":
				addedBlocks++;
				if (block.tokenDelta > 0) addedTokens += block.tokenDelta;
				if (block.tokenDelta < 0) removedTokens += -block.tokenDelta;
				break;
			case "removed":
				removedBlocks++;
				if (block.tokenDelta > 0) addedTokens += block.tokenDelta;
				if (block.tokenDelta < 0) removedTokens += -block.tokenDelta;
				break;
			case "modified":
				modifiedBlocks++;
				if (block.tokenDelta > 0) {
					addedTokens += block.tokenDelta;
				} else {
					removedTokens += -block.tokenDelta;
				}
				break;
		}
	}

	return {
		sameBlocks,
		addedBlocks,
		removedBlocks,
		modifiedBlocks,
		changedBlocks: addedBlocks + removedBlocks + modifiedBlocks,
		addedTokens,
		removedTokens,
		netTokens,
	};
}

function hasUniqueStableKeys(blocks: Block[]): boolean {
	const keys = blocks.map((block) => block.key);
	return keys.every((key) => key.length > 0) && new Set(keys).size === keys.length;
}

function alignBlocks(beforeBlocks: Block[], afterBlocks: Block[]): Array<{ before?: Block; after?: Block }> {
	const afterKeys = new Set(afterBlocks.map((block) => block.key));
	const useKeys = hasUniqueStableKeys(beforeBlocks)
		&& hasUniqueStableKeys(afterBlocks)
		&& beforeBlocks.some((block) => afterKeys.has(block.key));
	if (!useKeys) {
		return alignPositional(beforeBlocks, afterBlocks);
	}

	const beforeByKey = new Map(beforeBlocks.map((block) => [block.key, block]));
	const beforeIndexByKey = new Map(beforeBlocks.map((block, index) => [block.key, index]));
	const aligned: Array<{ before?: Block; after?: Block }> = [];
	let beforeCursor = 0;
	let afterCursor = 0;
	for (let afterIndex = 0; afterIndex < afterBlocks.length; afterIndex++) {
		const after = afterBlocks[afterIndex]!;
		const beforeIndex = beforeIndexByKey.get(after.key);
		if (beforeIndex === undefined || beforeIndex < beforeCursor) continue;
		aligned.push(...alignPositional(
			beforeBlocks.slice(beforeCursor, beforeIndex),
			afterBlocks.slice(afterCursor, afterIndex),
		));
		aligned.push({ before: beforeByKey.get(after.key), after });
		beforeCursor = beforeIndex + 1;
		afterCursor = afterIndex + 1;
	}
	aligned.push(...alignPositional(beforeBlocks.slice(beforeCursor), afterBlocks.slice(afterCursor)));
	return aligned;
}

function alignPositional(beforeBlocks: Block[], afterBlocks: Block[]): Array<{ before?: Block; after?: Block }> {
	const maxLength = Math.max(beforeBlocks.length, afterBlocks.length);
	return Array.from({ length: maxLength }, (_, index) => ({
		before: beforeBlocks[index],
		after: afterBlocks[index],
	}));
}

/**
 * Diff two consecutive turn snapshots.
 *
 * The cache-boundary walk compares block arrays positionally while hashes
 * match. This preserves the serialized-prefix meaning even when a later
 * block is moved. Classification uses stable block keys after the boundary so
 * a middle insertion does not make every following block look modified.
 */
export function diffTurns(
	previous: TurnSnapshot | null | undefined,
	current: TurnSnapshot,
): TurnDiff {
	const beforeBlocks = previous?.blocks ?? [];
	const afterBlocks = current.blocks;
	const diffBlocks = alignBlocks(beforeBlocks, afterBlocks).map(({ before, after }) => classify(before, after));
	let prefixChars = 0;
	let boundaryCrossed = false;
	for (let index = 0; index < Math.max(beforeBlocks.length, afterBlocks.length); index++) {
		const before = beforeBlocks[index];
		const after = afterBlocks[index];

		if (!boundaryCrossed) {
			if (before && after && before.hash === after.hash) {
				prefixChars += after.chars;
				continue;
			}

			if (before && after) {
				prefixChars += safeCommonPrefixLength(before, after);
			}
			boundaryCrossed = true;
		}
	}

	const currentTokens = turnApproxTokens(current);
	const previousTokens = previous ? turnApproxTokens(previous) : 0;
	const currentChars = afterBlocks.reduce((sum, block) => sum + block.chars, 0);
	const prefixTokens = !boundaryCrossed || prefixChars >= currentChars
		? currentTokens
		: Math.min(currentTokens, Math.floor(prefixChars / 4));
	const deltaTokens = currentTokens - previousTokens;
	assignTokenDeltas(diffBlocks, deltaTokens);
	const prefixRatio = currentTokens === 0 ? 0 : prefixTokens / currentTokens;

	return {
		blocks: diffBlocks,
		prefixTokens,
		prefixRatio,
		deltaTokens,
		summary: summarize(diffBlocks, deltaTokens),
	};
}
