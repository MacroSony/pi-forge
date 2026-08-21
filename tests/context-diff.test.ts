import assert from "node:assert/strict";
import test from "node:test";
import {
	createBlock,
	createTurnSnapshot,
	diffTurns,
	estimateApproxTokens,
	hashText,
	turnApproxTokens,
} from "../src/context-diff.ts";
import type { Block, TurnSnapshot } from "../src/context-diff.ts";
import {
	blockAddedTurnSet,
	blockModifiedMidArrayTurnSet,
	blockRemovedTurnSet,
	contextDiffFixtureSets,
	firstBlockChangeTurnSet,
	identicalConsecutiveTurns,
	multiBlockMixedChangesTurnSet,
} from "./fixtures/context-diff-fixtures.ts";

function block(key: string, role: string, text: string): Block {
	return createBlock(key, role, text);
}

function turn(turnId: string, blocks: Block[]): TurnSnapshot {
	return createTurnSnapshot({ turnId, blocks });
}

function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
	assert.ok(
		Math.abs(actual - expected) <= epsilon,
		`expected ${actual} to be within ${epsilon} of ${expected}`,
	);
}

test("hashText is deterministic and sensitive to text changes", () => {
	const text = "same block text";
	assert.equal(hashText(text), hashText(text));
	assert.notEqual(hashText("same block text"), hashText("same block text!"));
	assert.match(hashText(text), /^[0-9a-f]{8}$/);
});

test("estimateApproxTokens follows the chars/4 approximation", () => {
	assert.equal(estimateApproxTokens(""), 1);
	assert.equal(estimateApproxTokens("a"), 1);
	assert.equal(estimateApproxTokens("abcd"), 1);
	assert.equal(estimateApproxTokens("abcde"), 2);
	assert.equal(estimateApproxTokens("abcdefgh"), 2);
	assert.equal(estimateApproxTokens("abcdefghi"), 3);
});

test("createBlock computes chars, approxTokens, and hash", () => {
	const b = block("system", "system", "Hello, world!");
	assert.equal(b.chars, 13);
	assert.equal(b.approxTokens, 4);
	assert.equal(b.hash, hashText(JSON.stringify({ role: "system", text: "Hello, world!" })));
});

test("turnApproxTokens sums block tokens", () => {
	const t = turn("t", [block("a", "user", "abcd"), block("b", "user", "abcdefgh")]);
	assert.equal(turnApproxTokens(t), 3);
});

test("turnApproxTokens rounds the complete request instead of each tiny block", () => {
	const t = turn("t", [block("a", "user", "a"), block("b", "user", "b"), block("c", "user", "c")]);
	assert.equal(turnApproxTokens(t), 1);
});

test("block role changes are wire changes even when visible text is identical", () => {
	const previous = turn("prev", [block("message", "user", "same text")]);
	const current = turn("curr", [block("message", "assistant", "same text")]);
	const diff = diffTurns(previous, current);

	assert.notEqual(previous.blocks[0]!.hash, current.blocks[0]!.hash);
	assert.equal(diff.blocks[0]!.status, "modified");
	assert.equal(diff.prefixTokens, 0);
	assert.equal(diff.prefixRatio, 0);
});

test("identical consecutive fixtures produce all-same blocks and full cache prefix", () => {
	const [previous, current] = identicalConsecutiveTurns.turns;
	const diff = diffTurns(previous, current);

	assert.equal(diff.blocks.length, current.blocks.length);
	assert.ok(diff.blocks.every((b) => b.status === "same"));
	assert.equal(diff.prefixTokens, turnApproxTokens(current));
	assert.equal(diff.prefixRatio, 1);
	assert.equal(diff.deltaTokens, 0);
	assert.deepEqual(diff.summary, {
		sameBlocks: current.blocks.length,
		addedBlocks: 0,
		removedBlocks: 0,
		modifiedBlocks: 0,
		changedBlocks: 0,
		addedTokens: 0,
		removedTokens: 0,
		netTokens: 0,
	});
});

test("block added fixture marks an added tail block and keeps prefix through old prompt", () => {
	const [previous, current] = blockAddedTurnSet.turns;
	const diff = diffTurns(previous, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["same", "same", "same", "same", "added"],
	);
	const addedBlock = diff.blocks[4]!;
	assert.equal(addedBlock.before, undefined);
	assert.equal(addedBlock.after?.key, "message-4");
	assert.equal(addedBlock.tokenDelta, addedBlock.after?.approxTokens);
	const previousChars = previous.blocks.reduce((sum, block) => sum + block.chars, 0);
	const conservativePrefix = Math.floor(previousChars / 4);
	assert.equal(diff.prefixTokens, conservativePrefix);
	assertClose(diff.prefixRatio, conservativePrefix / turnApproxTokens(current));
	assert.equal(diff.deltaTokens, turnApproxTokens(current) - turnApproxTokens(previous));
	assert.equal(diff.summary.addedBlocks, 1);
	assert.equal(diff.summary.addedTokens, diff.blocks[4].tokenDelta);
	assert.equal(diff.summary.removedTokens, 0);
	assert.equal(diff.summary.changedBlocks, 1);
});

test("stable block keys prevent a middle insertion from cascading into modifications", () => {
	const previous = turn("prev", [
		block("system", "system", "Stable system"),
		block("history", "user", "Stable history"),
		block("tail", "assistant", "Stable tail"),
	]);
	const current = turn("curr", [
		block("system", "system", "Stable system"),
		block("inserted", "user", "New middle block"),
		block("history", "user", "Stable history"),
		block("tail", "assistant", "Stable tail"),
	]);
	const diff = diffTurns(previous, current);

	assert.deepEqual(diff.blocks.map((item) => item.status), ["same", "added", "same", "same"]);
	assert.equal(diff.blocks[2]!.before?.key, "history");
	assert.equal(diff.blocks[3]!.before?.key, "tail");
	assert.equal(diff.summary.modifiedBlocks, 0);
});

test("block removed fixture marks a removed tail block and keeps prefix through remaining prompt", () => {
	const [previous, current] = blockRemovedTurnSet.turns;
	const diff = diffTurns(previous, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["same", "same", "same", "removed"],
	);
	const removedBlock = diff.blocks[3]!;
	assert.equal(removedBlock.after, undefined);
	assert.equal(removedBlock.tokenDelta, diff.deltaTokens);
	assert.equal(diff.prefixTokens, turnApproxTokens(current));
	assert.equal(diff.prefixRatio, 1);
	assert.equal(diff.deltaTokens, turnApproxTokens(current) - turnApproxTokens(previous));
	assert.equal(diff.summary.removedBlocks, 1);
	assert.equal(diff.summary.removedTokens, -diff.deltaTokens);
	assert.equal(diff.summary.changedBlocks, 1);
});

test("changed-block chips and summaries share one conservative request-level rounding", () => {
	const previous = turn("prev", [block("base", "user", "abcd")]);
	const current = turn("curr", [
		block("base", "user", "abcd"),
		block("one", "user", "x"),
		block("two", "user", "x"),
		block("three", "user", "x"),
	]);
	const diff = diffTurns(previous, current);

	assert.equal(diff.deltaTokens, 1);
	assert.deepEqual(diff.blocks.slice(1).map((block) => block.tokenDelta), [1, 0, 0]);
	assert.equal(diff.summary.addedTokens, 1);
	assert.equal(diff.summary.removedTokens, 0);
	assert.equal(diff.summary.addedTokens - diff.summary.removedTokens, diff.deltaTokens);
});

test("block modified mid-array fixture trims inside the modified block", () => {
	const [previous, current] = blockModifiedMidArrayTurnSet.turns;
	const diff = diffTurns(previous, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["same", "same", "modified", "same"],
	);
	const modifiedBlock = diff.blocks[2]!;
	assert.equal(modifiedBlock.before?.key, "message-2");
	assert.equal(modifiedBlock.after?.key, "message-2");
	assert.equal(modifiedBlock.tokenDelta, (modifiedBlock.after?.approxTokens ?? 0) - (modifiedBlock.before?.approxTokens ?? 0));
	const conservativePrefix = 81;
	assert.equal(diff.prefixTokens, conservativePrefix);
	assertClose(diff.prefixRatio, conservativePrefix / turnApproxTokens(current));
	assert.equal(diff.deltaTokens, 5);
	assert.equal(diff.summary.modifiedBlocks, 1);
	assert.equal(diff.summary.changedBlocks, 1);
	assert.equal(diff.summary.addedTokens, 5);
	assert.equal(diff.summary.removedTokens, 0);
});

test("first-block change puts the cache boundary at the top", () => {
	const [previous, current] = firstBlockChangeTurnSet.turns;
	const diff = diffTurns(previous, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["modified", "same", "same", "same"],
	);
	const firstBlock = diff.blocks[0]!;
	assert.equal(firstBlock.before?.key, "system");
	assert.equal(firstBlock.after?.key, "system");
	const conservativePrefix = Math.floor(11 / 4);
	assert.equal(diff.prefixTokens, conservativePrefix);
	assertClose(diff.prefixRatio, conservativePrefix / turnApproxTokens(current));
	assert.equal(diff.deltaTokens, 3);
	assert.equal(diff.summary.modifiedBlocks, 1);
	assert.equal(diff.summary.addedTokens, 3);
});

test("multi-block mixed changes fixture combines modified, same, and added blocks", () => {
	const [previous, current] = multiBlockMixedChangesTurnSet.turns;
	const diff = diffTurns(previous, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["same", "modified", "same", "same", "added"],
	);
	const conservativePrefix = 55;
	assert.equal(diff.prefixTokens, conservativePrefix);
	assertClose(diff.prefixRatio, conservativePrefix / turnApproxTokens(current));
	assert.equal(diff.deltaTokens, 30);
	assert.equal(diff.summary.modifiedBlocks, 1);
	assert.equal(diff.summary.addedBlocks, 1);
	assert.equal(diff.summary.changedBlocks, 2);
	assert.equal(diff.summary.addedTokens, 30);
	assert.equal(diff.summary.removedTokens, 0);
});

test("fixture sets expose realistic payload-capture shapes alongside turn snapshots", () => {
	for (const set of contextDiffFixtureSets) {
		assert.equal(set.payloads.length, set.turns.length, set.name);
		assert.equal(set.captures.length, set.turns.length, set.name);

		for (let i = 0; i < set.captures.length; i++) {
			const capture = set.captures[i];
			assert.equal(capture.capturedAt, set.turns[i].capturedAt, `${set.name}[${i}]`);
			assert.equal(capture.stackId, set.turns[i].stackId, `${set.name}[${i}]`);
			assert.equal(capture.truncated, false, `${set.name}[${i}]`);
			assert.equal(capture.chars, capture.text.length, `${set.name}[${i}]`);
			assert.equal(capture.approxTokens, Math.max(1, Math.ceil(capture.chars / 4)), `${set.name}[${i}]`);
			assert.ok(capture.payload !== undefined, `${set.name}[${i}]`);
		}
	}
});

test("all fixture sets produce a token rollup that matches current minus previous", () => {
	for (const set of contextDiffFixtureSets) {
		const [previous, current] = set.turns;
		const diff = diffTurns(previous, current);
		const currentTokens = turnApproxTokens(current);
		const previousTokens = turnApproxTokens(previous);

		assert.equal(
			diff.deltaTokens,
			currentTokens - previousTokens,
			set.name,
		);
		assert.equal(
			diff.summary.netTokens,
			diff.deltaTokens,
			set.name,
		);
		assert.equal(
			diff.summary.addedTokens - diff.summary.removedTokens,
			diff.deltaTokens,
			set.name,
		);
		assert.ok(diff.prefixRatio >= 0 && diff.prefixRatio <= 1, set.name);
	}
});

test("empty turns produce an empty diff", () => {
	const previous = turn("prev", []);
	const current = turn("curr", []);
	const diff = diffTurns(previous, current);

	assert.deepEqual(diff.blocks, []);
	assert.equal(diff.prefixTokens, 0);
	assert.equal(diff.prefixRatio, 0);
	assert.equal(diff.deltaTokens, 0);
	assert.equal(diff.summary.changedBlocks, 0);
});

test("first capture with no previous snapshot marks every block as added", () => {
	const current = turn("turn-1", [
		block("system", "system", "You are helpful."),
		block("message-1", "user", "Hello!"),
	]);
	const diff = diffTurns(undefined, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["added", "added"],
	);
	assert.equal(diff.prefixTokens, 0);
	assert.equal(diff.prefixRatio, 0);
	assert.equal(diff.deltaTokens, turnApproxTokens(current));
	assert.equal(diff.summary.addedBlocks, 2);
	assert.equal(diff.summary.changedBlocks, 2);
});

test("previous non-empty to empty current marks every block as removed", () => {
	const previous = turn("turn-1", [
		block("system", "system", "You are helpful."),
		block("message-1", "user", "Hello!"),
	]);
	const current = turn("turn-2", []);
	const diff = diffTurns(previous, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["removed", "removed"],
	);
	assert.equal(diff.prefixTokens, 0);
	assert.equal(diff.prefixRatio, 0);
	assert.equal(diff.deltaTokens, -turnApproxTokens(previous));
	assert.equal(diff.summary.removedBlocks, 2);
	assert.equal(diff.summary.changedBlocks, 2);
});

test("single identical block has full cache prefix", () => {
	const previous = turn("prev", [block("system", "system", "Same prompt")]);
	const current = turn("curr", [block("system", "system", "Same prompt")]);
	const diff = diffTurns(previous, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["same"],
	);
	assert.equal(diff.prefixTokens, turnApproxTokens(current));
	assert.equal(diff.prefixRatio, 1);
	assert.equal(diff.deltaTokens, 0);
});

test("single changed block trims inside the only block", () => {
	const previous = turn("prev", [block("system", "system", "Same prompt")]);
	const current = turn("curr", [block("system", "system", "Same prompt plus more")]);
	const diff = diffTurns(previous, current);
	const common = 11;
	const prefixTokens = Math.floor(common / 4);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["modified"],
	);
	assert.equal(diff.prefixTokens, prefixTokens);
	assertClose(diff.prefixRatio, prefixTokens / turnApproxTokens(current));
	assert.equal(diff.deltaTokens, turnApproxTokens(current) - turnApproxTokens(previous));
});

test("all-changed multi-block turn reports modified blocks and a small cache prefix", () => {
	const previous = turn("prev", [
		block("system", "system", "Alpha system prompt"),
		block("message-1", "user", "Alpha user request"),
		block("message-2", "assistant", "Alpha assistant response"),
	]);
	const current = turn("curr", [
		block("system", "system", "Beta system prompt"),
		block("message-1", "user", "Beta user request"),
		block("message-2", "assistant", "Beta assistant response"),
	]);
	const diff = diffTurns(previous, current);

	assert.deepEqual(
		diff.blocks.map((b) => b.status),
		["modified", "modified", "modified"],
	);
	assert.equal(diff.summary.modifiedBlocks, 3);
	assert.equal(diff.summary.changedBlocks, 3);
	assert.ok(diff.prefixTokens < turnApproxTokens(current));
	assert.equal(diff.deltaTokens, turnApproxTokens(current) - turnApproxTokens(previous));
});

test("all-same multi-block turn reports no changes and full cache prefix", () => {
	const previous = turn("prev", [
		block("system", "system", "Stable system"),
		block("message-1", "user", "Stable user"),
	]);
	const current = turn("curr", [
		block("system", "system", "Stable system"),
		block("message-1", "user", "Stable user"),
	]);
	const diff = diffTurns(previous, current);

	assert.equal(diff.blocks.every((b) => b.status === "same"), true);
	assert.equal(diff.prefixRatio, 1);
	assert.equal(diff.deltaTokens, 0);
	assert.equal(diff.summary.changedBlocks, 0);
});

test("diffTurns does not mutate input snapshots", () => {
	const previous = turn("prev", [block("system", "system", "Stable")]);
	const current = turn("curr", [block("system", "system", "Stable")]);
	const previousBefore = structuredClone(previous);
	const currentBefore = structuredClone(current);

	diffTurns(previous, current);

	assert.deepEqual(previous, previousBefore);
	assert.deepEqual(current, currentBefore);
});
