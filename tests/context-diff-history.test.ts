import assert from "node:assert/strict";
import test from "node:test";
import { createBlock, diffTurns, turnApproxTokens } from "../src/context-diff.ts";
import {
	appendContextDiffCapture,
	CONTEXT_DIFF_HISTORY_LIMIT,
	createContextDiffHistory,
	getContextDiffView,
} from "../src/context-diff-history.ts";
import { extractTurnSnapshot, type ContextDiffCapture } from "../src/context-diff-snapshot.ts";

function capture(capturedAt: string, messages: Array<{ role: string; content: string }>, stackId = "stack-context-diff"): ContextDiffCapture {
	return {
		capturedAt,
		stackId,
		payload: { model: "gpt-4.1", messages },
		text: JSON.stringify({ model: "gpt-4.1", messages }),
	};
}

test("extractTurnSnapshot converts an OpenAI-style payload into ordered blocks", () => {
	const messages = [
		{ role: "system", content: "System prompt" },
		{ role: "user", content: "User message" },
		{ role: "assistant", content: "Assistant message" },
	];
	const snapshot = extractTurnSnapshot(capture("2025-01-01T00:00:00.000Z", messages));

	assert.equal(snapshot.turnId, "2025-01-01T00:00:00.000Z");
	assert.equal(snapshot.stackId, "stack-context-diff");
	assert.deepEqual(snapshot.blocks.map((block) => block.key), ["system", "message-1", "message-2"]);
	assert.deepEqual(snapshot.blocks.map((block) => block.role), ["system", "user", "assistant"]);
	assert.deepEqual(snapshot.blocks.map((block) => block.text), ["System prompt", "User message", "Assistant message"]);
	assert.equal(snapshot.blocks[0]!.hash, createBlock("system", "system", "System prompt").hash);
	assert.equal(snapshot.blocks[0]!.chars, 13);
	assert.equal(snapshot.blocks[0]!.approxTokens, 4);
});

test("extractTurnSnapshot handles Anthropic-style system and content arrays", () => {
	const snapshot = extractTurnSnapshot({
		capturedAt: "2025-01-01T00:01:00.000Z",
		stackId: "stack",
		payload: {
			system: "You are helpful.",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Hello" },
						{ type: "image" },
					],
				},
			],
		},
		text: "serialized",
	});

	assert.equal(snapshot.blocks.length, 2);
	assert.equal(snapshot.blocks[0]!.key, "system");
	assert.equal(snapshot.blocks[0]!.text, "You are helpful.");
	assert.equal(snapshot.blocks[1]!.key, "message-0");
	assert.equal(snapshot.blocks[1]!.role, "user");
	assert.equal(snapshot.blocks[1]!.text, "Hello\n[image content]");
});

test("extractTurnSnapshot falls back to the serialized text when no payload object is available", () => {
	const snapshot = extractTurnSnapshot({
		capturedAt: "2025-01-01T00:02:00.000Z",
		stackId: "stack",
		payload: undefined,
		text: "raw serialized payload",
	});

	assert.equal(snapshot.blocks.length, 1);
	assert.equal(snapshot.blocks[0]!.key, "payload-text");
	assert.equal(snapshot.blocks[0]!.text, "raw serialized payload");
});

test("appendContextDiffCapture rolls history and evicts beyond the limit", () => {
	const history = createContextDiffHistory();
	const firstCapturedAt = "2025-01-01T00:00:00.000Z";
	for (let i = 0; i < 25; i++) {
		const capturedAt = new Date(Date.parse(firstCapturedAt) + i * 60_000).toISOString();
		appendContextDiffCapture(history, capture(capturedAt, [
			{ role: "user", content: `message ${i}` },
		]));
	}

	assert.equal(history.turns.length, CONTEXT_DIFF_HISTORY_LIMIT);
	assert.equal(history.turns[0]!.turnId, "turn-6");
	assert.equal(history.turns.at(-1)!.turnId, "turn-25");
	assert.ok(history.latestDiff);

	const previous = history.turns.at(-2)!;
	const current = history.turns.at(-1)!;
	const expectedDiff = diffTurns(previous, current);
	assert.equal(history.latestDiff!.deltaTokens, expectedDiff.deltaTokens);
	assert.equal(history.latestDiff!.prefixTokens, expectedDiff.prefixTokens);
});

test("appendContextDiffCapture returns a diff even for the first capture", () => {
	const history = createContextDiffHistory();
	const diff = appendContextDiffCapture(history, capture("2025-01-01T00:00:00.000Z", [
		{ role: "system", content: "System" },
	]));

	assert.ok(diff);
	assert.equal(diff.blocks.length, 1);
	assert.equal(diff.blocks[0]!.status, "added");
	assert.equal(diff.summary.addedBlocks, 1);
});

test("getContextDiffView summarizes recent turns and exposes the latest diff", () => {
	const history = createContextDiffHistory();
	appendContextDiffCapture(history, capture("2025-01-01T00:00:00.000Z", [
		{ role: "system", content: "Same system" },
		{ role: "user", content: "First user" },
	]));
	appendContextDiffCapture(history, capture("2025-01-01T00:01:00.000Z", [
		{ role: "system", content: "Same system" },
		{ role: "user", content: "Second user" },
	]));

	const view = getContextDiffView(history);
	assert.equal(view.turns.length, 2);
	assert.equal(view.turns[0]!.deltaTokens, turnApproxTokens(history.turns[0]!));
	assert.equal(view.turns[1]!.deltaTokens, turnApproxTokens(history.turns[1]!) - turnApproxTokens(history.turns[0]!));
	assert.equal(view.turns[1]!.changedBlocks, 1);
	assert.equal(view.turns[1]!.prefixRatio, diffTurns(history.turns[0]!, history.turns[1]!).prefixRatio);
	assert.ok(view.turns[1]!.prefixRatio! > 0 && view.turns[1]!.prefixRatio! < 1);
	assert.ok(view.latest);
	assert.equal(view.latest.diff, history.latestDiff);
	assert.equal(view.latest.turn, history.turns.at(-1));
});
