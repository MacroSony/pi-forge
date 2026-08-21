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

export function createBlock(key: string, role: string, text: string): Block {
	return {
		key,
		role,
		text,
		chars: text.length,
		approxTokens: estimateApproxTokens(text),
		hash: hashText(text),
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
	return turn.blocks.reduce((sum, block) => sum + block.approxTokens, 0);
}

function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let index = 0;
	while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) {
		index++;
	}
	return index;
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
			tokenDelta: after.approxTokens - before.approxTokens,
		};
	}
	if (before) {
		return { status: "removed", before, tokenDelta: -before.approxTokens };
	}
	return { status: "added", after, tokenDelta: after?.approxTokens ?? 0 };
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
				addedTokens += block.after?.approxTokens ?? 0;
				break;
			case "removed":
				removedBlocks++;
				removedTokens += block.before?.approxTokens ?? 0;
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

/**
 * Diff two consecutive turn snapshots.
 *
 * The cache-boundary walk compares block arrays positionally while hashes
 * match. At the first mismatch it counts the char-level common prefix inside
 * that block; remaining blocks are classified as same/added/removed/modified.
 * This intentionally avoids a full Myers diff.
 */
export function diffTurns(
	previous: TurnSnapshot | null | undefined,
	current: TurnSnapshot,
): TurnDiff {
	const beforeBlocks = previous?.blocks ?? [];
	const afterBlocks = current.blocks;
	const maxLength = Math.max(beforeBlocks.length, afterBlocks.length);
	const diffBlocks: DiffBlock[] = [];
	let prefixTokens = 0;
	let boundaryCrossed = false;

	for (let index = 0; index < maxLength; index++) {
		const before = beforeBlocks[index];
		const after = afterBlocks[index];

		if (!boundaryCrossed) {
			if (before && after && before.hash === after.hash) {
				diffBlocks.push({ status: "same", before, after, tokenDelta: 0 });
				prefixTokens += after.approxTokens;
				continue;
			}

			if (before && after) {
				prefixTokens += Math.ceil(commonPrefixLength(before.text, after.text) / 4);
			}
			boundaryCrossed = true;
		}

		diffBlocks.push(classify(before, after));
	}

	const currentTokens = turnApproxTokens(current);
	const previousTokens = previous ? turnApproxTokens(previous) : 0;
	const deltaTokens = currentTokens - previousTokens;
	const prefixRatio = currentTokens === 0 ? 0 : prefixTokens / currentTokens;

	return {
		blocks: diffBlocks,
		prefixTokens,
		prefixRatio,
		deltaTokens,
		summary: summarize(diffBlocks, deltaTokens),
	};
}
