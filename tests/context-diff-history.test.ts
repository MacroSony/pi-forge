import assert from "node:assert/strict";
import test from "node:test";
import { createBlock, diffTurns, turnApproxTokens } from "../src/context-diff.ts";
import {
	appendContextDiffCapture,
	attachContextDiffUsage,
	CONTEXT_DIFF_HISTORY_LIMIT,
	createContextDiffHistory,
	getContextDiffView,
} from "../src/context-diff-history.ts";
import { extractTurnSnapshot, type ContextDiffCapture } from "../src/context-diff-snapshot.ts";
import { createProviderPayloadCaptureWithSerialization } from "../src/payload-capture.ts";

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
	assert.deepEqual(snapshot.blocks.map((block) => block.key), [
		"request-model",
		"message-system-57362e4d",
		"message-user-3d22cb12",
		"message-assistant-c0a65ea4",
	]);
	assert.deepEqual(snapshot.blocks.map((block) => block.role), ["request", "system", "user", "assistant"]);
	assert.deepEqual(snapshot.blocks.slice(1).map((block) => block.text), ["System prompt", "User message", "Assistant message"]);
	assert.equal(snapshot.blocks[1]!.hash, createBlock("ignored", "system", "System prompt", {
		section: "messages",
		value: messages[0],
	}).hash);
	assert.equal(snapshot.blocks[1]!.chars, 13);
	assert.equal(snapshot.blocks[1]!.approxTokens, 4);
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
	assert.match(snapshot.blocks[1]!.key, /^message-user-[0-9a-f]{8}$/);
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
	assert.equal(diff.blocks.length, 2);
	assert.deepEqual(diff.blocks.map((block) => block.status), ["added", "added"]);
	assert.equal(diff.summary.addedBlocks, 2);
});

test("the real extractor aligns inserted messages by content-derived keys", () => {
	const previous = extractTurnSnapshot(capture("2025-01-01T00:02:00.000Z", [
		{ role: "user", content: "A" },
		{ role: "assistant", content: "B" },
	]));
	const current = extractTurnSnapshot(capture("2025-01-01T00:03:00.000Z", [
		{ role: "user", content: "Inserted" },
		{ role: "user", content: "A" },
		{ role: "assistant", content: "B" },
	]));
	const diff = diffTurns(previous, current);

	assert.deepEqual(diff.blocks.slice(1).map((block) => block.status), ["added", "same", "same"]);
	assert.equal(diff.blocks[2]!.before?.text, "A");
	assert.equal(diff.blocks[3]!.before?.text, "B");
});

test("faithful serialization keeps truncated request regions in the cache identity", () => {
	const previousMessages = Array.from({ length: 81 }, (_, index) => ({
		role: "user",
		content: index === 80 ? "tail-before" : `message-${index}`,
	}));
	const currentMessages = previousMessages.map((message, index) => index === 80
		? { ...message, content: "tail-after" }
		: message);
	const previousCapture = createProviderPayloadCaptureWithSerialization({
		model: "gpt-4.1",
		messages: previousMessages,
	});
	const currentCapture = createProviderPayloadCaptureWithSerialization({
		model: "gpt-4.1",
		messages: currentMessages,
	});
	assert.deepEqual(previousCapture.capture.payload, currentCapture.capture.payload);

	const previous = extractTurnSnapshot({
		...previousCapture.capture,
		capturedAt: "2025-01-01T00:04:00.000Z",
		serializedPayload: previousCapture.serializedPayload,
	});
	const current = extractTurnSnapshot({
		...currentCapture.capture,
		capturedAt: "2025-01-01T00:05:00.000Z",
		serializedPayload: currentCapture.serializedPayload,
	});
	const diff = diffTurns(previous, current);

	assert.equal(previous.blocks.length, 82);
	assert.equal(current.blocks.length, 82);
	assert.equal(diff.blocks.at(-1)!.status, "modified");
	assert.notEqual(previous.blocks.at(-1)!.hash, current.blocks.at(-1)!.hash);
});

test("snapshot hashes preserve message metadata and request-level tool definitions", () => {
	const previous = extractTurnSnapshot({
		capturedAt: "2025-01-01T00:03:00.000Z",
		stackId: "stack",
		payload: {
			model: "gpt-4.1",
			messages: [{
				role: "user",
				name: "caller",
				tool_call_id: "call-1",
				content: "same text",
				tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }],
			}],
			tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
		},
		text: "previous",
	});
	const current = extractTurnSnapshot({
		capturedAt: "2025-01-01T00:04:00.000Z",
		stackId: "stack",
		payload: {
			model: "gpt-4.1",
			messages: [{
				role: "assistant",
				name: "caller",
				tool_call_id: "call-2",
				content: "same text",
				tool_calls: [{ id: "call-2", type: "function", function: { name: "lookup", arguments: '{"full":true}' } }],
			}],
			tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { full: { type: "boolean" } } } } }],
		},
		text: "current",
	});

	assert.deepEqual(current.blocks.map((block) => block.key), [
		"request-model",
		"message-assistant-15912d92",
		"request-tools",
	]);
	assert.equal(previous.blocks[0]!.hash, current.blocks[0]!.hash);
	assert.notEqual(previous.blocks[1]!.hash, current.blocks[1]!.hash);
	assert.notEqual(previous.blocks[2]!.hash, current.blocks[2]!.hash);
	const diff = diffTurns(previous, current);
	assert.deepEqual(diff.blocks.map((block) => block.status), ["same", "modified", "modified"]);
	assert.ok(diff.prefixRatio < 1);
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

test("provider usage exposes real prompt/cache counts without confusing estimates", () => {
	const history = createContextDiffHistory();
	appendContextDiffCapture(history, capture("2025-01-01T00:00:00.000Z", [{ role: "user", content: "first" }]));
	const firstTurnId = history.turns.at(-1)!.turnId;
	attachContextDiffUsage(history, firstTurnId, {
		provider: "test",
		model: "model",
		stopReason: "stop",
		input: 100,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 120,
	});

	appendContextDiffCapture(history, capture("2025-01-01T00:01:00.000Z", [{ role: "user", content: "second" }]));
	const secondTurnId = history.turns.at(-1)!.turnId;
	attachContextDiffUsage(history, secondTurnId, {
		provider: "test",
		model: "model",
		stopReason: "toolUse",
		input: 25,
		output: 10,
		cacheRead: 75,
		cacheWrite: 0,
		totalTokens: 110,
	});

	appendContextDiffCapture(history, capture("2025-01-01T00:02:00.000Z", [{ role: "user", content: "third" }]));
	const thirdTurnId = history.turns.at(-1)!.turnId;
	attachContextDiffUsage(history, thirdTurnId, {
		provider: "test",
		model: "model",
		stopReason: "stop",
		input: 100,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 105,
	});

	const view = getContextDiffView(history);
	assert.deepEqual(view.turns.map((turn) => turn.usage?.cacheStatus), ["not-reported", "reported", "reported"]);
	assert.equal(view.turns[0]!.usage?.cacheHitRatio, null);
	assert.equal(view.turns[1]!.usage?.promptTokens, 100);
	assert.equal(view.turns[1]!.usage?.cacheHitRatio, 0.75);
	assert.equal(view.turns[2]!.usage?.cacheHitRatio, 0);
	assert.equal(view.latest?.usage?.cacheHitRatio, 0);
	assert.equal(view.latest?.diff.prefixRatio, view.latestDiff?.prefixRatio);
});
