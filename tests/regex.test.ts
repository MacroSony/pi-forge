import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { applyRegexRulesToMessages, validateRegexConfig } from "../src/regex.ts";
import type { PromptStack, PromptStackDiagnostic } from "../src/types.ts";

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

test("regex rules apply JavaScript string replacement syntax", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "regex",
		regex: {
			rules: [{
				id: "capture",
				stage: "compiled",
				pattern: "Name: (\\w+)",
				flags: "g",
				replace: "Name=$1",
			}],
		},
		items: [],
	};
	const diagnostics: PromptStackDiagnostic[] = [];

	const messages = applyRegexRulesToMessages(stack, [user("Name: Ada")], "compiled", diagnostics);

	assert.equal(textOf(messages[0]!), "Name=Ada");
	assert.match(diagnostics.at(-1)?.message ?? "", /matched 1 time/);
});

test("regex validation rejects invalid patterns, flags, targets, and duplicate ids", () => {
	const diagnostics = validateRegexConfig({
		rules: [
			{ id: "bad", stage: "compiled", pattern: "(" },
			{ id: "flags", stage: "compiled", pattern: "x", flags: "gg" },
			{ id: "bad", stage: "other", pattern: "x", targets: ["payload"] },
		],
	});

	assert.ok(diagnostics.some((diagnostic) => /duplicate regex rule id/i.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => /duplicate regex flag/i.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => /failed to compile/i.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => /stage must/.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => /target must/.test(diagnostic.message)));
});

test("display regex effects validate with a warning and are ignored by outgoing runtime", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "display-only",
		regex: {
			rules: [{
				id: "display",
				stage: "compiled",
				effect: "display",
				pattern: "secret",
				replace: "redacted",
			}],
		},
		items: [],
	};

	const validation = validateRegexConfig(stack.regex);
	const diagnostics: PromptStackDiagnostic[] = [];
	const messages = applyRegexRulesToMessages(stack, [user("secret")], "compiled", diagnostics);

	assert.ok(validation.some((diagnostic) => diagnostic.level === "warning" && /ignored/.test(diagnostic.message)));
	assert.equal(textOf(messages[0]!), "secret");
	assert.deepEqual(diagnostics, []);
});

test("regex roles, maxMessages, and maxChars limit eligible text", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "limited",
		regex: {
			rules: [{
				id: "recent-user-tail",
				stage: "compiled",
				pattern: "secret",
				flags: "g",
				replace: "redacted",
				roles: ["user"],
				maxMessages: 1,
				maxChars: 6,
			}],
		},
		items: [],
	};
	const diagnostics: PromptStackDiagnostic[] = [];

	const messages = applyRegexRulesToMessages(stack, [
		user("secret old"),
		assistant("secret assistant"),
		user("prefix secret"),
	], "compiled", diagnostics);

	assert.equal(textOf(messages[0]!), "secret old");
	assert.equal(textOf(messages[1]!), "secret assistant");
	assert.equal(textOf(messages[2]!), "prefix redacted");
	assert.match(diagnostics.at(-1)?.message ?? "", /changed 1 text segment/);
});
