import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compileMessages, compileSystemPrompt } from "../src/compiler.ts";
import { CAPABILITY_DELIVERY_TYPE } from "../src/capability-protocol.ts";
import { applyRegexRulesToMessages, applyRequestFrequencyRulesToMessages } from "../src/regex.ts";
import type { PromptRuntime, PromptStack } from "../src/types.ts";

function createRuntime(overrides: Partial<PromptRuntime> = {}): PromptRuntime {
	return {
		options: {
			cwd: "/work/project",
			selectedTools: ["read", "bash", "edit", "write"],
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		},
		latestUserMessage: "latest user input",
		now: new Date("2026-06-13T12:00:00Z"),
		...overrides,
	};
}

function userMessage(content: string, timestamp = 1000): AgentMessage {
	return { role: "user", content, timestamp } as AgentMessage;
}

function assistantMessage(content: string, toolCalls?: { id: string; name: string; args?: Record<string, unknown> }[], timestamp = 2000): AgentMessage {
	const contentArray: unknown[] = [{ type: "text", text: content }];
	if (toolCalls) {
		for (const tc of toolCalls) {
			contentArray.push({ type: "toolCall", id: tc.id, name: tc.name, args: tc.args ?? {} });
		}
	}
	return {
		role: "assistant",
		content: contentArray,
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as AgentMessage;
}

function toolResultMessage(toolCallId: string, content: string, timestamp = 3000): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		content: [{ type: "text", text: content }],
		timestamp,
	} as AgentMessage;
}

function controlSystemMessage(content: string, timestamp = 500): AgentMessage {
	return {
		role: "system",
		content,
		timestamp,
	} as unknown as AgentMessage;
}

function controlDeliveryMessage(cursor: string, timestamp = 600): AgentMessage {
	return {
		role: "custom",
		customType: CAPABILITY_DELIVERY_TYPE,
		content: `cursor:${cursor}`,
		display: false,
		timestamp,
	} as AgentMessage;
}

function unknownCustomMessage(content: string, customType = "external-subagent", timestamp = 700): AgentMessage {
	return {
		role: "custom",
		customType,
		content,
		display: true,
		timestamp,
	} as AgentMessage;
}

function messageText(message: AgentMessage | { role: string; content: unknown }): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
			.join("");
	}
	return "";
}

// ---------------------------------------------------------------------------
// 1. mixedtoolpairs: tool pair repair and drop do not lose or tamper with structural messages
// ---------------------------------------------------------------------------

test("instruction-history: mixedtoolpairs - tool pair repair preserves interleaved control messages", () => {
	const ctl1 = controlSystemMessage("ctl_sys_1");
	const ctl2 = controlDeliveryMessage("deliv_1");
	const ctl3 = controlSystemMessage("ctl_sys_2");

	const asstWithCall = assistantMessage("Let me check", [{ id: "call_1", name: "read" }]);
	const toolRes = toolResultMessage("call_1", "file contents");
	const user1 = userMessage("first question");
	const user2 = userMessage("second question");

	// History: ctl1, user1, asstWithCall, ctl2, toolRes, ctl3, user2
	// When maxMessages is 2 for ordinary messages, only toolRes and user2 would be kept ordinary.
	// But toolRes has a call_1 that is now dangling because asstWithCall was sliced away.
	// Tool repair drops the dangling toolRes.
	// All three control messages MUST remain in their original relative positions!
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "tool-repair-stack",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: {
					maxMessages: 2,
				},
			},
		],
	};

	const originalMessages = [ctl1, user1, asstWithCall, ctl2, toolRes, ctl3, user2];
	const result = compileMessages(stack, createRuntime(), originalMessages);

	// ctl1, ctl2, ctl3 and user2 must be present!
	assert.ok(result.messages.includes(ctl1));
	assert.ok(result.messages.includes(ctl2));
	assert.ok(result.messages.includes(ctl3));
	assert.ok(result.messages.includes(user2));

	// Relative order of kept messages must be preserved: ctl1, ctl2, ctl3, user2
	const indices = [ctl1, ctl2, ctl3, user2].map((m) => result.messages.indexOf(m));
	assert.ok(indices[0]! < indices[1]!);
	assert.ok(indices[1]! < indices[2]!);
	assert.ok(indices[2]! < indices[3]!);
});

test("instruction-history: mixedtoolpairs - toolMode drop preserves interleaved control messages", () => {
	const ctl1 = controlSystemMessage("system policy init");
	const asstWithCall = assistantMessage("call tool", [{ id: "c1", name: "bash" }]);
	const ctl2 = controlDeliveryMessage("delivery checkpoint 42");
	const toolRes = toolResultMessage("c1", "command output");
	const user = userMessage("next step");

	const stack: PromptStack = {
		schemaVersion: 1,
		id: "tool-drop-stack",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: {
					toolMode: "drop",
				},
			},
		],
	};

	const result = compileMessages(stack, createRuntime(), [ctl1, asstWithCall, ctl2, toolRes, user]);

	// ctl1 and ctl2 must be intact
	assert.ok(result.messages.some((m) => messageText(m) === "system policy init"));
	assert.ok(result.messages.some((m) => messageText(m) === "cursor:delivery checkpoint 42"));
	// Tool result must be dropped
	assert.equal(result.messages.some((m) => m.role === "toolResult"), false);
});

// ---------------------------------------------------------------------------
// 2. all ordinary filtered but control messages still present
// ---------------------------------------------------------------------------

test("instruction-history: all ordinary filtered still preserves all control messages", () => {
	const ctl1 = controlSystemMessage("sys_ctl_1");
	const ctl2 = controlDeliveryMessage("deliv_cursor_a");
	const ctl3 = controlSystemMessage("sys_ctl_2");
	const user = userMessage("hello world");
	const asst = assistantMessage("hi there");

	// Stack filters history to roles: ["toolResult"] - no ordinary message has this role
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "filter-all-ordinary",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: {
					roles: ["toolResult"],
				},
			},
		],
	};

	const result = compileMessages(stack, createRuntime(), [ctl1, user, ctl2, asst, ctl3]);

	// All ordinary messages filtered out, but all 3 control messages remain in order
	assert.equal(result.messages.length, 3);
	assert.deepEqual(result.messages, [ctl1, ctl2, ctl3]);
});

// ---------------------------------------------------------------------------
// 3. followupregex: request-frequency regex skips structural control messages
// ---------------------------------------------------------------------------

test("instruction-history: followupregex - request-frequency regex skips structural messages", () => {
	const ctlSys = controlSystemMessage("Control directive with SENSITIVE_TOKEN");
	const ctlDeliv = controlDeliveryMessage("SENSITIVE_TOKEN_CURSOR");
	const user = userMessage("User text with SENSITIVE_TOKEN");
	const asst = assistantMessage("Assistant reply with SENSITIVE_TOKEN");
	const toolRes = toolResultMessage("call_x", "Output with SENSITIVE_TOKEN");

	const stack: PromptStack = {
		schemaVersion: 1,
		id: "regex-stack",
		items: [
			{ kind: "slot", id: "history", role: "user", slot: "chat-history" },
		],
		regex: {
			rules: [
				{
					id: "mask-sensitive",
					stage: "compiled",
					frequency: "request",
					pattern: "SENSITIVE_TOKEN",
					replace: "[MASKED]",
				},
			],
		},
	};

	const diagnostics: any[] = [];
	const messages = [ctlSys, user, ctlDeliv, asst, toolRes];
	const result = applyRequestFrequencyRulesToMessages(stack, messages, diagnostics);

	// Control messages must NOT be modified
	assert.equal(messageText(result[0]!), "Control directive with SENSITIVE_TOKEN");
	assert.equal(messageText(result[2]!), "cursor:SENSITIVE_TOKEN_CURSOR");

	// Ordinary messages MUST be modified
	assert.equal(messageText(result[1]!), "User text with [MASKED]");
	assert.equal(messageText(result[3]!), "Assistant reply with [MASKED]");
	assert.equal(messageText(result[4]!), "Output with [MASKED]");
});

// ---------------------------------------------------------------------------
// 4. unknown custom can still be filtered and transformed
// ---------------------------------------------------------------------------

test("instruction-history: unknown custom message is treated as ordinary dialogue and can be filtered", () => {
	const unknownCustom = unknownCustomMessage("some third-party custom payload", "third-party-ext");
	const ctlDeliv = controlDeliveryMessage("pi-forge-capability-delivery-target");
	const user = userMessage("ordinary user text");

	const stack: PromptStack = {
		schemaVersion: 1,
		id: "filter-unknown-custom",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: {
					roles: ["user"],
				},
			},
		],
	};

	const result = compileMessages(stack, createRuntime(), [unknownCustom, ctlDeliv, user]);

	// unknownCustom is NOT a control message, so it is filtered out by roles: ["user"]
	assert.equal(result.messages.includes(unknownCustom), false);
	// ctlDeliv is a protected control message, so it is kept
	assert.ok(result.messages.includes(ctlDeliv));
	// user is allowed by role
	assert.ok(result.messages.includes(user));
	assert.equal(result.messages.length, 2);
});

// ---------------------------------------------------------------------------
// 5. original input is not mutated
// ---------------------------------------------------------------------------

test("instruction-history: compileMessages does not mutate original input messages array or objects", () => {
	const ctl1 = controlSystemMessage("initial control");
	const user = userMessage("original user message");
	const asst = assistantMessage("original assistant message");
	const ctl2 = controlDeliveryMessage("delivery 123");

	const originalArray = [ctl1, user, asst, ctl2];
	const snapshotBefore = JSON.stringify(originalArray);

	// Deep freeze elements to guarantee no in-place mutation
	for (const m of originalArray) {
		Object.freeze(m);
		if (Array.isArray((m as any).content)) {
			Object.freeze((m as any).content);
		}
	}
	Object.freeze(originalArray);

	const stack: PromptStack = {
		schemaVersion: 1,
		id: "immutability-test",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: {
					maxMessages: 1,
					maxChars: 100,
					stripAssistantThinking: true,
				},
			},
		],
	};

	const result = compileMessages(stack, createRuntime(), originalArray as any);
	assert.ok(result.messages);
	assert.equal(JSON.stringify(originalArray), snapshotBefore);
});

// ---------------------------------------------------------------------------
// 6. maxChars preserves earlier structural message when ordinary message is truncated
// ---------------------------------------------------------------------------

test("instruction-history: maxChars preserves earlier structural message when ordinary messages are truncated", () => {
	const ctlEarly = controlSystemMessage("EARLY_SYSTEM_CONTROL");
	// A long message that exceeds budget when combined with recent message
	const oldUser = userMessage("A".repeat(200));
	const recentUser = userMessage("short query"); // ~11 chars
	const ctlLate = controlDeliveryMessage("LATE_DELIVERY");

	const stack: PromptStack = {
		schemaVersion: 1,
		id: "max-chars-early-control",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: {
					maxChars: 50,
				},
			},
		],
	};

	const result = compileMessages(stack, createRuntime(), [ctlEarly, oldUser, recentUser, ctlLate]);

	// oldUser is truncated because 200 + 11 > 50.
	// But traversal continues to preserve earlier structural messages!
	// Both ctlEarly and ctlLate must be preserved, along with recentUser.
	assert.equal(result.messages.length, 3);
	assert.deepEqual(result.messages, [ctlEarly, recentUser, ctlLate]);
});

// ---------------------------------------------------------------------------
// 7. maxChars best effort preserves at least one ordinary message without structural miscalculation
// ---------------------------------------------------------------------------

test("instruction-history: maxChars best-effort preserves at least one ordinary message without structural miscalculation", () => {
	const ctl1 = controlSystemMessage("X".repeat(300));
	const hugeUser = userMessage("Y".repeat(200));
	const ctl2 = controlDeliveryMessage("Z".repeat(300));

	const stack: PromptStack = {
		schemaVersion: 1,
		id: "max-chars-best-effort",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: {
					maxChars: 50,
				},
			},
		],
	};

	const result = compileMessages(stack, createRuntime(), [ctl1, hugeUser, ctl2]);

	// Structural messages ctl1 and ctl2 do NOT consume the 50 char budget.
	// hugeUser is the most recent ordinary message; even though 200 > 50, existing best-effort
	// semantics guarantees at least one ordinary message is preserved.
	assert.equal(result.messages.length, 3);
	assert.deepEqual(result.messages, [ctl1, hugeUser, ctl2]);
});

// ---------------------------------------------------------------------------
// 8. history and compiled regex skip structural messages while compiled system prompt string works
// ---------------------------------------------------------------------------

test("instruction-history: history and compiled regex skip structural messages while string regex works", () => {
	const ctlSys = controlSystemMessage("ALPHA in structural system");
	const user = userMessage("ALPHA in user message");
	const ctlDeliv = controlDeliveryMessage("ALPHA in structural delivery");

	const stack: PromptStack = {
		schemaVersion: 1,
		id: "regex-skip-structural",
		items: [
			{ kind: "slot", id: "history", role: "user", slot: "chat-history" },
		],
		regex: {
			rules: [
				{
					id: "replace-alpha-history",
					stage: "history",
					pattern: "ALPHA",
					replace: "BETA",
				},
				{
					id: "replace-alpha-compiled",
					stage: "compiled",
					targets: ["messages"],
					pattern: "ALPHA",
					replace: "GAMMA",
				},
				{
					id: "replace-system-string",
					stage: "compiled",
					targets: ["system"],
					pattern: "BASE_PROMPT",
					replace: "MODIFIED_PROMPT",
				},
			],
		},
	};

	const result = compileMessages(stack, createRuntime(), [ctlSys, user, ctlDeliv]);

	// Structural messages must NOT have ALPHA replaced!
	assert.equal(messageText(result.messages[0]!), "ALPHA in structural system");
	assert.equal(messageText(result.messages[2]!), "cursor:ALPHA in structural delivery");

	// Ordinary message has ALPHA replaced by history regex (BETA)
	assert.equal(messageText(result.messages[1]!), "BETA in user message");

	// Compiled system prompt string regex STILL works!
	const sysResult = compileSystemPrompt(stack, createRuntime(), "BASE_PROMPT");
	assert.equal(sysResult.systemPrompt, "MODIFIED_PROMPT");
});
