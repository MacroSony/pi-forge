import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	compileMessages,
	compileSystemPrompt,
	createPromptVariableStore,
} from "../src/compiler.ts";
import type { PromptRuntime, PromptStack } from "../src/types.ts";

function runtime(overrides: Partial<PromptRuntime> = {}): PromptRuntime {
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
		variables: createPromptVariableStore({ topic: "session topic" }),
		...overrides,
	};
}

function user(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() } as AgentMessage;
}

function assistant(content: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
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
		timestamp: Date.now(),
	} as AgentMessage;
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

test("compileSystemPrompt preserves enabled system item order", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "ordered",
		mode: "replace",
		items: [
			{ kind: "block", id: "a", enabled: true, role: "system", content: "A" },
			{ kind: "block", id: "ignored-user", enabled: true, role: "user", content: "ignored" },
			{ kind: "slot", id: "date", enabled: true, role: "system", slot: "date" },
			{ kind: "block", id: "b", enabled: true, role: "system", content: "B" },
		],
	};

	const result = compileSystemPrompt(stack, runtime(), "base");

	assert.equal(result.systemPrompt, "A\n\nCurrent date: 2026-06-13\n\nB");
	assert.deepEqual(result.diagnostics, []);
});

test("empty replacement system prompt preserves the base prompt", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "empty",
		mode: "replace",
		items: [{ kind: "block", id: "user-only", enabled: true, role: "user", content: "not system" }],
	};

	const result = compileSystemPrompt(stack, runtime(), "base prompt");

	assert.equal(result.systemPrompt, "base prompt");
	assert.match(result.diagnostics[0]?.message ?? "", /preserving base system prompt/);
});

test("compileMessages expands chat history at the configured slot", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "messages",
		items: [
			{ kind: "block", id: "pre", enabled: true, role: "user", content: "before" },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history", options: { includeLastUserMessage: false } },
			{ kind: "block", id: "post", enabled: true, role: "user", content: "latest: {{lastUserMessage}}" },
		],
	};
	const messages = [user("first"), assistant("reply"), user("latest request")];

	const result = compileMessages(stack, runtime({ latestUserMessage: "latest request" }), messages);

	assert.equal(result.messages.length, 4);
	assert.equal(textOf(result.messages[0]), "before");
	assert.equal(textOf(result.messages[1]), "first");
	assert.equal(textOf(result.messages[2]), "reply");
	assert.equal(textOf(result.messages[3]), "latest: latest request");
	assert.deepEqual(result.diagnostics, []);
});

test("variables resolve in turn, session, then static order", () => {
	const store = createPromptVariableStore({ name: "session", topic: "session topic" });
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "variables",
		variables: { name: "static", char: "Konata" },
		items: [
			{
				kind: "block",
				id: "vars",
				enabled: true,
				role: "system",
				content: "{{setvar::name::turn}}{{name}}/{{getsessionvar::name}}/{{char}}/{{setvar::session::mood::bright}}{{getsessionvar::mood}}",
			},
		],
	};

	const result = compileSystemPrompt(stack, runtime({ variables: store }), "base");

	assert.equal(result.systemPrompt, "turn/session/Konata/bright");
	assert.equal(store.session.mood, "bright");
	assert.equal(store.sessionDirty, true);
});

test("unknown macros are kept and diagnosed", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "unknown",
		items: [{ kind: "block", id: "block", enabled: true, role: "system", content: "A {{missing}}" }],
	};

	const result = compileSystemPrompt(stack, runtime(), "base");

	assert.equal(result.systemPrompt, "A {{missing}}");
	assert.equal(result.diagnostics[0]?.level, "warning");
	assert.equal(result.diagnostics[0]?.itemId, "block");
	assert.match(result.diagnostics[0]?.message ?? "", /Unresolved macro/);
});

test("duplicate chat-history slots warn and only expand once by default", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "duplicate-history",
		items: [
			{ kind: "slot", id: "history-1", enabled: true, slot: "chat-history" },
			{ kind: "slot", id: "history-2", enabled: true, slot: "chat-history" },
		],
	};
	const messages = [user("one")];

	const result = compileMessages(stack, runtime(), messages);

	assert.equal(result.messages.length, 1);
	assert.equal(textOf(result.messages[0]), "one");
	assert.equal(result.diagnostics[0]?.level, "warning");
	assert.equal(result.diagnostics[0]?.itemId, "history-2");
	assert.match(result.diagnostics[0]?.message ?? "", /duplicate chat-history/);
});

test("unsupported slots produce diagnostics", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "unsupported",
		items: [{ kind: "slot", id: "bad-slot", enabled: true, role: "user", slot: "not-real" }],
	};

	const result = compileMessages(stack, runtime(), [user("original")]);

	assert.equal(result.messages.length, 1);
	assert.equal(textOf(result.messages[0]), "original");
	assert.equal(result.diagnostics[0]?.level, "warning");
	assert.equal(result.diagnostics[0]?.itemId, "bad-slot");
	assert.match(result.diagnostics[0]?.message ?? "", /Unsupported slot/);
});
