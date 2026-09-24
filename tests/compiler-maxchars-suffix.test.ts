import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compileMessages } from "../src/compiler.ts";
import { INSTRUCTION_DELIVERY_TYPE } from "../src/instruction-protocol.ts";
import type { PromptRuntime, PromptStack } from "../src/types.ts";

function runtime(): PromptRuntime {
	return {
		options: {
			cwd: "/work/project",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files from disk." },
			promptGuidelines: ["Use read before editing files."],
			contextFiles: [],
			skills: [],
		},
		latestUserMessage: "latest request",
		now: new Date("2026-06-13T12:00:00Z"),
	};
}

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() } as AgentMessage;
}

function system(content: string): AgentMessage {
	return { role: "system", content, timestamp: Date.now() } as AgentMessage;
}

function deliveryAnchor(throughEventId: string): AgentMessage {
	return {
		role: "custom",
		customType: INSTRUCTION_DELIVERY_TYPE,
		content: "instruction-delivery-marker",
		data: { schemaVersion: 1, throughEventId },
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const obj = part as { type?: unknown; text?: unknown };
			return obj.type === "text" && typeof obj.text === "string" ? obj.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function makeHistoryStack(maxChars: number): PromptStack {
	return {
		schemaVersion: 1,
		id: "test-history-maxchars",
		items: [
			{
				kind: "slot",
				id: "history",
				enabled: true,
				slot: "chat-history",
				options: {
					maxChars,
				},
			},
		],
	};
}

test("maxChars backward scan preserves recent contiguous suffix and does not pick up older small messages (reproduce old/100char/new max10 => new)", () => {
	const stack = makeHistoryStack(10);
	const messages = [
		user("old"),
		user("x".repeat(100)),
		user("new"),
	];

	const result = compileMessages(stack, runtime(), messages);
	const texts = result.messages.map(textOf);

	// Must be ["new"], and must not pick up "old" around the 100-character gap
	assert.deepEqual(texts, ["new"]);
	assert.notDeepEqual(texts, ["old", "new"]);
});

test("maxChars backward scan preserves instruction control messages even when ordinary history boundary is exceeded", () => {
	const stack = makeHistoryStack(10);
	const sysMsg = system("system instruction");
	const anchorMsg = deliveryAnchor("event-123");

	const messages = [
		sysMsg,
		user("old"),
		anchorMsg,
		user("x".repeat(100)),
		user("new"),
	];

	const result = compileMessages(stack, runtime(), messages);

	// Both control messages (sysMsg and anchorMsg) must be preserved.
	// Ordinary messages must only contain the contiguous suffix ["new"], dropping "old" and "x".repeat(100).
	assert.equal(result.messages.length, 3);
	assert.equal(result.messages[0], sysMsg);
	assert.equal(result.messages[1], anchorMsg);
	assert.equal(textOf(result.messages[2]), "new");
});

test("maxChars backward scan boundary cases: exact limit, boundary + 1 char, and single oversize message", () => {
	// Case 1: Exact limit (5 chars + 5 chars = 10 chars)
	{
		const stack = makeHistoryStack(10);
		const messages = [
			user("old"),
			user("12345"),
			user("67890"),
		];
		const result = compileMessages(stack, runtime(), messages);
		assert.deepEqual(result.messages.map(textOf), ["12345", "67890"]);
	}

	// Case 2: Boundary exceeded by 1 char on older message (6 + 5 = 11 > 10)
	{
		const stack = makeHistoryStack(10);
		const messages = [
			user("old"),
			user("123456"),
			user("78901"),
		];
		const result = compileMessages(stack, runtime(), messages);
		assert.deepEqual(result.messages.map(textOf), ["78901"]);
	}

	// Case 3: Newest message alone exceeds maxChars (preserves newest, drops earlier)
	{
		const stack = makeHistoryStack(10);
		const messages = [
			user("old"),
			user("x".repeat(50)),
		];
		const result = compileMessages(stack, runtime(), messages);
		assert.deepEqual(result.messages.map(textOf), ["x".repeat(50)]);
	}

	// Case 4: Control message preceding an exact limit
	{
		const stack = makeHistoryStack(10);
		const sysMsg = system("sys");
		const messages = [
			sysMsg,
			user("old"),
			user("12345"),
			user("67890"),
		];
		const result = compileMessages(stack, runtime(), messages);
		assert.equal(result.messages[0], sysMsg);
		assert.deepEqual(result.messages.slice(1).map(textOf), ["12345", "67890"]);
	}
});
