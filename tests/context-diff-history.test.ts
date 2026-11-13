import assert from "node:assert/strict";
import test from "node:test";
import { createBlock, diffTurns, turnApproxTokens } from "../src/context-diff.ts";
import {
	appendContextDiffCapture,
	attachContextDiffUsage,
	CONTEXT_DIFF_HISTORY_LIMIT,
	CONTEXT_DIFF_HISTORY_MAX_CHARS,
	createContextDiffHistory,
	getContextDiffView,
	getLatestContextDiffUsage,
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

test("latest usage lookup skips newer turns that have no response usage", () => {
	const history = createContextDiffHistory();
	appendContextDiffCapture(history, capture("2025-01-01T00:00:00.000Z", [{ role: "user", content: "first" }]));
	const firstTurnId = history.turns.at(-1)!.turnId;
	attachContextDiffUsage(history, firstTurnId, {
		provider: "test",
		model: "model",
		stopReason: "stop",
		input: 10,
		output: 1,
		cacheRead: 9,
		cacheWrite: 0,
		totalTokens: 20,
	});
	appendContextDiffCapture(history, capture("2025-01-01T00:01:00.000Z", [{ role: "user", content: "second" }]));

	assert.equal(getLatestContextDiffUsage(history)?.cacheRead, 9);
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

function fakeBase64(seed: number, length: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let state = seed >>> 0;
	let out = "";
	for (let index = 0; index < length; index++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out += alphabet[state >>> 26];
	}
	return out;
}

function appendPayload(history: ReturnType<typeof createContextDiffHistory>, payload: unknown, capturedAt: string) {
	const { capture: displayCapture, serializedPayload } = createProviderPayloadCaptureWithSerialization(payload, { stackId: "stack" });
	return appendContextDiffCapture(history, { ...displayCapture, capturedAt, serializedPayload });
}

test("Responses input images are elided from snapshots but still change block identity", () => {
	const imageA = `data:image/png;base64,${fakeBase64(1, 200_000)}`;
	const imageB = `data:image/png;base64,${fakeBase64(2, 200_000)}`;
	const payload = (image: string) => ({
		model: "gpt-6-astra",
		instructions: "system",
		input: [
			{ role: "user", content: [{ type: "input_text", text: "看一下战况" }] },
			{ type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: image }] },
		],
	});
	const history = createContextDiffHistory();
	appendPayload(history, payload(imageA), "2025-01-01T00:00:00.000Z");
	const same = appendPayload(history, payload(imageA), "2025-01-01T00:01:00.000Z");
	const changed = appendPayload(history, payload(imageB), "2025-01-01T00:02:00.000Z");

	const inputBlock = history.turns.at(-1)!.blocks.find((block) => block.key === "request-input")!;
	assert.ok(inputBlock.text.length < 2_000, `input block retained ${inputBlock.text.length} chars`);
	assert.doesNotMatch(inputBlock.text, /base64,/);
	assert.match(inputBlock.text, /image\/png data omitted · 200022 chars · fp [0-9a-f]{8}/);
	assert.equal(same!.blocks.find((block) => block.after?.key === "request-input")!.status, "same");
	assert.equal(changed!.blocks.find((block) => block.after?.key === "request-input")!.status, "modified");
});

test("bare base64 media (Anthropic/Gemini style) is elided from snapshots", () => {
	const data = fakeBase64(3, 50_000);
	const { serializedPayload } = createProviderPayloadCaptureWithSerialization({
		model: "claude",
		messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }],
	});
	assert.ok(!serializedPayload.includes(data));
	assert.match(serializedPayload, /image\/png data omitted · 50000 chars · fp [0-9a-f]{8}/);
});

test("structured media fields are elided whatever their size", () => {
	const small = fakeBase64(4, 7_996);
	const { serializedPayload } = createProviderPayloadCaptureWithSerialization({
		model: "m",
		contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: small } }] }],
		messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: fakeBase64(5, 20_000), format: "wav" } }] }],
		assets: { "<image-1>": { type: "image", format: "png", data_base64: fakeBase64(6, 30_000) } },
	});
	assert.ok(!serializedPayload.includes(small));
	assert.match(serializedPayload, /image\/jpeg data omitted · 7996 chars/);
	assert.match(serializedPayload, /wav data omitted · 20000 chars/);
	assert.match(serializedPayload, /png data omitted · 30000 chars/);
});

test("binary byte arrays (Bedrock image source.bytes) are elided instead of serialized per index", () => {
	const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
	const { serializedPayload } = createProviderPayloadCaptureWithSerialization({
		modelId: "m",
		messages: [{ role: "user", content: [{ image: { format: "png", source: { bytes } } }] }],
	});
	assert.ok(serializedPayload.length < 2_000, `serialized ${serializedPayload.length} chars`);
	assert.match(serializedPayload, /binary data omitted · 100000 bytes · fp [0-9a-f]{8}/);
});

test("long plain strings that only look like base64 are kept verbatim and still diff", () => {
	const samples = {
		hex: "deadbeef".repeat(2_000),
		identifier: "a".repeat(12_000),
		urlSafe: `${"Ab0_-".repeat(2_400)}`,
	};
	for (const [name, text] of Object.entries(samples)) {
		const { serializedPayload } = createProviderPayloadCaptureWithSerialization({ model: "m", messages: [{ role: "user", content: text }] });
		assert.equal(JSON.parse(serializedPayload).messages[0].content, text, name);
	}
	const history = createContextDiffHistory();
	const text = "deadbeef".repeat(25_000);
	appendPayload(history, { model: "m", messages: [{ role: "user", content: text }] }, "2025-01-01T00:00:00.000Z");
	const edited = `${text.slice(0, 100_001)}X${text.slice(100_002)}`;
	const diff = appendPayload(history, { model: "m", messages: [{ role: "user", content: edited }] }, "2025-01-01T00:01:00.000Z");
	assert.ok(diff!.blocks.some((block) => block.status !== "same"), "an edit to long plain text must show up in the diff");
});

test("a data field outside a media block is never elided", () => {
	const text = "QUJD".repeat(5_000);
	const { serializedPayload } = createProviderPayloadCaptureWithSerialization({ model: "m", tools: [{ name: "t", data: text }] });
	assert.equal(JSON.parse(serializedPayload).tools[0].data, text);
});

test("ordinary long text is kept verbatim in the faithful serialization", () => {
	const text = "第一行 ordinary prose, with spaces.\n".repeat(1_000);
	const { serializedPayload } = createProviderPayloadCaptureWithSerialization({ model: "m", messages: [{ role: "user", content: text }] });
	assert.equal(JSON.parse(serializedPayload).messages[0].content, text);
});

test("screenshot-heavy sessions keep retained history bounded", () => {
	const history = createContextDiffHistory();
	const input: unknown[] = [];
	for (let turn = 0; turn < 40; turn++) {
		input.push({ type: "function_call_output", call_id: `c${turn}`, output: [{ type: "input_image", image_url: `data:image/png;base64,${fakeBase64(turn, 100_000)}` }] });
		appendPayload(history, { model: "gpt-6-astra", input: [...input] }, `2025-01-01T00:${String(turn).padStart(2, "0")}:00.000Z`);
	}
	const retained = history.turns.reduce((sum, turn) => sum + turn.blocks.reduce((inner, block) => inner + block.chars, 0), 0);
	assert.equal(history.turns.length, CONTEXT_DIFF_HISTORY_LIMIT);
	assert.ok(retained < 2_000_000, `retained ${retained} chars`);
});

test("history evicts old turns past the character budget but keeps the latest two", () => {
	const history = createContextDiffHistory();
	const huge = "x ".repeat(Math.ceil(CONTEXT_DIFF_HISTORY_MAX_CHARS / 8));
	for (let turn = 0; turn < 5; turn++) {
		appendPayload(history, { model: "m", messages: [{ role: "user", content: `${turn}${huge}` }] }, `2025-01-01T00:0${turn}:00.000Z`);
	}
	const retained = history.turns.reduce((sum, turn) => sum + turn.blocks.reduce((inner, block) => inner + block.chars, 0), 0);
	assert.ok(retained <= CONTEXT_DIFF_HISTORY_MAX_CHARS, `retained ${retained} chars`);
	assert.ok(history.turns.length >= 2 && history.turns.length < 5, `kept ${history.turns.length} turns`);
	assert.ok(history.latestDiff);
});

test("tool arguments that resemble media blocks are kept verbatim and still diff", () => {
	const hex = "deadbeef".repeat(25_000);
	const payload = (data: string) => ({
		model: "m",
		messages: [{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "t1", name: "export", input: { format: "hex", data } },
				{ type: "tool_use", id: "t2", name: "upload", input: { source: { type: "base64", media_type: "text/plain", data: "QUJD" } } },
			],
		}],
		contents: [{ role: "model", parts: [{ functionCall: { name: "save", args: { mimeType: "text/plain", data } } }] }],
	});
	const { serializedPayload } = createProviderPayloadCaptureWithSerialization(payload(hex));
	const parsed = JSON.parse(serializedPayload);
	assert.equal(parsed.messages[0].content[0].input.data, hex);
	assert.equal(parsed.messages[0].content[1].input.source.data, "QUJD");
	assert.equal(parsed.contents[0].parts[0].functionCall.args.data, hex);

	const history = createContextDiffHistory();
	appendPayload(history, payload(hex), "2025-01-01T00:00:00.000Z");
	const edited = `${hex.slice(0, 100_001)}0${hex.slice(100_002)}`;
	const diff = appendPayload(history, payload(edited), "2025-01-01T00:01:00.000Z");
	assert.ok(diff!.blocks.some((block) => block.status !== "same"), "an edit to tool arguments must show up in the diff");
});

test("Anthropic document blocks and tool-result images are elided", () => {
	const pdf = fakeBase64(7, 40_000);
	const png = fakeBase64(8, 40_000);
	const { serializedPayload } = createProviderPayloadCaptureWithSerialization({
		model: "claude",
		messages: [{
			role: "user",
			content: [
				{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
				{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] },
			],
		}],
	});
	assert.ok(!serializedPayload.includes(pdf) && !serializedPayload.includes(png));
	assert.match(serializedPayload, /application\/pdf data omitted · 40000 chars/);
	assert.match(serializedPayload, /image\/png data omitted · 40000 chars/);
});

test("binary payloads are elided in the display capture and SharedArrayBuffer keeps identity", () => {
	const bytes = new Uint8Array(2_000_000).map((_, index) => index % 7);
	const { capture } = createProviderPayloadCaptureWithSerialization({
		modelId: "m",
		messages: [{ role: "user", content: [{ image: { format: "png", source: { bytes } } }] }],
	});
	assert.ok(capture.text.length < 2_000, `display text ${capture.text.length} chars`);
	assert.match(capture.text, /binary data omitted · 2000000 bytes/);

	const shared = (fill: number) => {
		const buffer = new SharedArrayBuffer(1_000);
		new Uint8Array(buffer).fill(fill);
		return createProviderPayloadCaptureWithSerialization({ modelId: "m", bytes: buffer }).serializedPayload;
	};
	assert.match(shared(1), /binary data omitted · 1000 bytes/);
	assert.notEqual(shared(1), shared(2));
});

test("media-shaped JSON inside tool arguments and tool definitions is never elided", () => {
	const hex = "deadbeef".repeat(25_000);
	const shaped = (data: string) => ({
		inlineData: { data },
		block: { type: "image", source: { type: "base64", media_type: "image/png", data } },
		native: { type: "image", mimeType: "image/png", data },
		url: `data:image/png;base64,${data}`,
	});
	const payload = (data: string) => ({
		model: "m",
		messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "save", input: shaped(data) }] }],
		contents: [{ role: "model", parts: [{ functionCall: { name: "save", args: shaped(data) } }] }],
		bedrock: [{ toolUse: { toolUseId: "t", name: "save", input: shaped(data) } }],
		tools: [{ name: "save", input_schema: { type: "object", examples: [shaped(data)] } }],
	});
	const parsed = JSON.parse(createProviderPayloadCaptureWithSerialization(payload(hex)).serializedPayload);
	for (const args of [parsed.messages[0].content[0].input, parsed.contents[0].parts[0].functionCall.args, parsed.bedrock[0].toolUse.input, parsed.tools[0].input_schema.examples[0]]) {
		assert.deepEqual(args, shaped(hex));
	}
	const history = createContextDiffHistory();
	appendPayload(history, payload(hex), "2025-01-01T00:00:00.000Z");
	const diff = appendPayload(history, payload(`d${"f"}${hex.slice(2)}`), "2025-01-01T00:01:00.000Z");
	assert.ok(diff!.blocks.some((block) => block.status !== "same"), "an edit inside tool arguments must show up in the diff");
});

test("Pi native image content (pi-messages providers) is elided", () => {
	const png = fakeBase64(9, 60_000);
	const { serializedPayload } = createProviderPayloadCaptureWithSerialization({
		model: "m",
		context: {
			messages: [
				{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: png }] },
				{ role: "toolResult", toolCallId: "c", content: [{ type: "image", mimeType: "image/jpeg", data: png }] },
			],
		},
	});
	assert.ok(!serializedPayload.includes(png));
	assert.match(serializedPayload, /image\/png data omitted · 60000 chars/);
	assert.match(serializedPayload, /image\/jpeg data omitted · 60000 chars/);
});