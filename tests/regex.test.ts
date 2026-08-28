import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { applyFinalizeRegexRulesToMessage, applyRegexRulesToMessages, applyRequestFrequencyRulesToMessages, hasRequestFrequencyRules, validateRegexConfig } from "../src/regex.ts";
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

test("Regex Hack redacts its documented token shapes without claiming exhaustive secret detection", () => {
	const stack = JSON.parse(readFileSync("examples/hack-prompt-stack.json", "utf8")) as PromptStack;
	const source = "sk-abcdefghijkl ghp_abcdefghijklmnopqrst github_pat_abcdefghijklmnopqrst AKIAABCDEFGHIJKLMNOP";
	const [outgoing] = applyRequestFrequencyRulesToMessages(stack, [user(source)], []);

	assert.equal(
		textOf(outgoing!),
		"[REDACTED] [REDACTED] github_pat_abcdefghijklmnopqrst AKIAABCDEFGHIJKLMNOP",
	);
	assert.equal(
		applyRegexRulesToMessages(stack, [user(source)], "history", []).map(textOf)[0],
		"[REDACTED] [REDACTED] github_pat_abcdefghijklmnopqrst AKIAABCDEFGHIJKLMNOP",
	);
});

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

test("regex trimStrings remove literals from expanded match and capture replacements", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "regex-trim",
		regex: {
			rules: [{
				id: "trim-brackets",
				stage: "compiled",
				pattern: "\\[([^\\]]+)\\]",
				flags: "g",
				replace: "**$&**/$1",
				trimStrings: ["[", "]"],
			}],
		},
		items: [],
	};
	const diagnostics: PromptStackDiagnostic[] = [];

	const messages = applyRegexRulesToMessages(stack, [user("Status: [OK]")], "compiled", diagnostics);

	assert.equal(textOf(messages[0]!), "Status: **OK**/OK");
	assert.match(diagnostics.at(-1)?.message ?? "", /matched 1 time/);
});

test("regex $0 expands to the full match on both native and trimStrings paths", () => {
	const stack = (replace: string, trimStrings?: string[]): PromptStack => ({
		schemaVersion: 1,
		id: "dollar-zero",
		items: [],
		regex: {
			rules: [{
				id: "r",
				stage: "compiled",
				pattern: "X",
				replace,
				...(trimStrings ? { trimStrings } : {}),
			}],
		},
	});

	// Native path (no trimStrings): $0 is the full match, $$0 stays a literal $0.
	assert.equal(textOf(applyRegexRulesToMessages(stack("[$0]"), [user("aXb")], "compiled", [])[0]!), "a[X]b");
	assert.equal(textOf(applyRegexRulesToMessages(stack("[$$0]"), [user("aXb")], "compiled", [])[0]!), "a[$0]b");

	// Custom expander path (trimStrings): $0 is also the full match.
	assert.equal(textOf(applyRegexRulesToMessages(stack("[$0]", ["zzz"]), [user("aXb")], "compiled", [])[0]!), "a[X]b");
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

test("regex validation warns about legacy replacement tokens and validates new limit fields", () => {
	const diagnostics = validateRegexConfig({
		rules: [
			{ id: "st-token", stage: "compiled", pattern: "x", replace: "{{match}} $0" },
			{ id: "bad-trim", stage: "compiled", pattern: "x", trimStrings: "x" },
			{ id: "bad-depth", stage: "compiled", pattern: "x", minDepth: 3, maxDepth: 1 },
		],
	});

	assert.ok(diagnostics.some((diagnostic) => diagnostic.level === "warning" && /\{\{match\}\}/.test(diagnostic.message)));
	assert.ok(!diagnostics.some((diagnostic) => /\$0.*literal/.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => diagnostic.level === "error" && /trimStrings/.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => diagnostic.level === "error" && /maxDepth/.test(diagnostic.message)));
});

test("regex validation rejects display and both effects", () => {
	const diagnostics = validateRegexConfig({
		rules: [
			{ id: "display", stage: "compiled", effect: "display", pattern: "secret", replace: "redacted" },
			{ id: "both", stage: "compiled", effect: "both", pattern: "secret", replace: "redacted" },
		],
	});

	assert.ok(diagnostics.some((diagnostic) => diagnostic.level === "error" && /effect must be/.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => /effect "display"/.test(diagnostic.message) || /effect must be/.test(diagnostic.message)));
	assert.ok(!diagnostics.some((diagnostic) => /ignored/.test(diagnostic.message)));
});

test("finalize regex rewrites finalized assistant text and preserves non-text parts", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "finalize",
		regex: {
			rules: [{
				id: "final-ooc",
				stage: "compiled",
				effect: "finalize",
				targets: ["messages"],
				roles: ["assistant"],
				pattern: "\\s*\\(OOC:[^)]+\\)",
				flags: "g",
				replace: "",
			}],
		},
		items: [],
	};
	const message = assistant("Visible (OOC: hide)");
	const nonTextPart = { type: "toolCall", name: "keep" };
	(message as unknown as { content: Array<Record<string, unknown>> }).content.push(nonTextPart);
	const diagnostics: PromptStackDiagnostic[] = [];

	const replacement = applyFinalizeRegexRulesToMessage(stack, message, diagnostics);
	const content = (replacement as unknown as { content: Array<Record<string, unknown>> }).content;

	assert.ok(replacement);
	assert.notEqual(replacement, message);
	assert.equal(content[0]?.text, "Visible");
	assert.equal(content[1], nonTextPart);
	assert.equal(replacement.role, "assistant");
	assert.equal((replacement as { model?: string }).model, "test-model");
	assert.equal((replacement as { usage?: unknown }).usage, (message as { usage?: unknown }).usage);
	assert.ok(diagnostics.some((diagnostic) => /matched 1 time/.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => /original content is not preserved/.test(diagnostic.message)));
});

test("finalize regex ignores non-finalize effects", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "ignored-effects",
		regex: {
			rules: [
				{ id: "outgoing", stage: "compiled", effect: "outgoing", pattern: "secret", replace: "redacted" },
			],
		},
		items: [],
	};
	const diagnostics: PromptStackDiagnostic[] = [];
	const message = assistant("secret");

	const replacement = applyFinalizeRegexRulesToMessage(stack, message, diagnostics);

	assert.equal(replacement, undefined);
	assert.equal(textOf(message), "secret");
	assert.deepEqual(diagnostics, []);
});

test("finalize regex validation rejects unsupported stage and targets", () => {
	const diagnostics = validateRegexConfig({
		rules: [
			{ id: "bad-stage", stage: "history", effect: "finalize", pattern: "x" },
			{ id: "bad-target", stage: "compiled", effect: "finalize", targets: ["system"], pattern: "x" },
			{ id: "no-assistant-role", stage: "compiled", effect: "finalize", roles: ["user"], pattern: "x" },
		],
	});

	assert.ok(diagnostics.some((diagnostic) => diagnostic.level === "error" && /requires stage "compiled"/.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => diagnostic.level === "error" && /only supports target "messages"/.test(diagnostic.message)));
	assert.ok(diagnostics.some((diagnostic) => diagnostic.level === "warning" && /roles includes neither/.test(diagnostic.message)));
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

test("regex minDepth and maxDepth limit eligible history messages", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "depth",
		regex: {
			rules: [{
				id: "middle-depth",
				stage: "compiled",
				pattern: "secret",
				replace: "redacted",
				roles: ["user"],
				minDepth: 1,
				maxDepth: 2,
			}],
		},
		items: [],
	};
	const diagnostics: PromptStackDiagnostic[] = [];

	const messages = applyRegexRulesToMessages(stack, [
		user("old secret"),
		assistant("assistant secret"),
		user("latest secret"),
	], "compiled", diagnostics);

	assert.equal(textOf(messages[0]!), "old redacted");
	assert.equal(textOf(messages[1]!), "assistant secret");
	assert.equal(textOf(messages[2]!), "latest secret");
});

function toolResult(content: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

test("regex frequency validation: invalid values and meaningless combinations", () => {
	const diagnostics = validateRegexConfig({
		rules: [
			{ id: "bad-frequency", stage: "compiled", pattern: "x", frequency: "always" },
			{ id: "finalize-frequency", stage: "compiled", effect: "finalize", frequency: "request", pattern: "x" },
			{ id: "system-only-request", stage: "compiled", targets: ["system"], frequency: "request", pattern: "x" },
			{ id: "ok-turn", stage: "history", frequency: "turn", pattern: "x" },
			{ id: "ok-request", stage: "history", frequency: "request", pattern: "x" },
		],
	});

	assert.ok(diagnostics.some((d) => d.level === "error" && /bad-frequency.*frequency must be "turn" or "request"/.test(d.message)));
	assert.ok(diagnostics.some((d) => d.level === "warning" && /finalize-frequency.*frequency has no effect for "finalize"/.test(d.message)));
	assert.ok(diagnostics.some((d) => d.level === "warning" && /system-only-request.*frequency "request" has no effect: the rule does not target messages/.test(d.message)));
	assert.ok(!diagnostics.some((d) => /ok-turn|ok-request/.test(d.message)));
});

test("request-frequency rules apply to the full natural context on follow-ups", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "request-rules",
		regex: {
			rules: [
				{ id: "turn-only", stage: "history", pattern: "turn-secret", replace: "X" },
				{ id: "system-only", stage: "compiled", targets: ["system"], frequency: "request", pattern: "sys-secret", replace: "X" },
				{ id: "history-request", stage: "history", frequency: "request", pattern: "sk-[a-z]+", flags: "g", replace: "[REDACTED]" },
				{ id: "compiled-request", stage: "compiled", targets: ["messages"], frequency: "request", pattern: "token-[a-z]+", flags: "g", replace: "[TOKEN]" },
			],
		},
		items: [],
	};
	const messages = [
		user("user keeps sk-abc and token-one"),
		assistant("assistant mentions sk-def"),
		toolResult("tool result leaks sk-ghi and token-two"),
	];
	const diagnostics: PromptStackDiagnostic[] = [];

	const result = applyRequestFrequencyRulesToMessages(stack, messages, diagnostics);

	// Both request rules apply across all transcript messages; the turn-scoped
	// and system-only rules stay out of follow-up requests.
	assert.deepEqual(result.map(textOf), [
		"user keeps [REDACTED] and [TOKEN]",
		"assistant mentions [REDACTED]",
		"tool result leaks [REDACTED] and [TOKEN]",
	]);
	assert.ok(diagnostics.some((d) => /history-request/.test(d.message)));
	assert.ok(diagnostics.some((d) => /compiled-request/.test(d.message)));
	assert.ok(!diagnostics.some((d) => /turn-only|system-only/.test(d.message)));
});

test("request-frequency application is a no-op without matching rules or changes", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "request-noop",
		regex: { rules: [{ id: "never", stage: "history", frequency: "request", pattern: "zzz", replace: "X" }] },
		items: [],
	};
	const messages = [user("nothing to change")];
	const result = applyRequestFrequencyRulesToMessages(stack, messages, []);
	assert.equal(result, messages);

	const noRules: PromptStack = { schemaVersion: 1, id: "empty", items: [] };
	assert.equal(hasRequestFrequencyRules(noRules), false);
	assert.equal(hasRequestFrequencyRules(stack), true);
	const turnedOnly: PromptStack = {
		schemaVersion: 1,
		id: "turn-only",
		items: [],
		regex: { rules: [{ id: "t", stage: "history", pattern: "x", replace: "y" }] },
	};
	assert.equal(hasRequestFrequencyRules(turnedOnly), false);
});

test("finalize rewrites stored tool results only when roles opt in", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "finalize-tool-result",
		regex: {
			rules: [
				{
					id: "scrub-tool",
					stage: "compiled",
					effect: "finalize",
					targets: ["messages"],
					roles: ["assistant", "toolResult"],
					pattern: "sk-[a-z]+",
					flags: "g",
					replace: "[REDACTED]",
				},
			],
		},
		items: [],
	};
	const diagnostics: PromptStackDiagnostic[] = [];

	const scrubbedResult = applyFinalizeRegexRulesToMessage(stack, toolResult("read returned sk-secret"), diagnostics);
	assert.ok(scrubbedResult);
	assert.equal(textOf(scrubbedResult), "read returned [REDACTED]");
	assert.ok(diagnostics.some((d) => /original content is not preserved/.test(d.message)));

	const scrubbedAssistant = applyFinalizeRegexRulesToMessage(stack, assistant("I used sk-secret"), []);
	assert.ok(scrubbedAssistant);
	assert.equal(textOf(scrubbedAssistant), "I used [REDACTED]");

	// Rules without roles keep their assistant-only behavior.
	const legacyStack: PromptStack = {
		schemaVersion: 1,
		id: "finalize-legacy",
		regex: {
			rules: [{
				id: "legacy-final",
				stage: "compiled",
				effect: "finalize",
				targets: ["messages"],
				pattern: "sk-[a-z]+",
				flags: "g",
				replace: "[REDACTED]",
			}],
		},
		items: [],
	};
	assert.equal(applyFinalizeRegexRulesToMessage(legacyStack, toolResult("keeps sk-secret"), []), undefined);
	assert.ok(applyFinalizeRegexRulesToMessage(legacyStack, assistant("drops sk-secret"), []));
});

test("finalize validation accepts toolResult and warns on unsupported roles", () => {
	const diagnostics = validateRegexConfig({
		rules: [
			{ id: "ok", stage: "compiled", effect: "finalize", roles: ["assistant", "toolResult"], pattern: "x" },
			{ id: "mixed", stage: "compiled", effect: "finalize", roles: ["assistant", "user"], pattern: "x" },
			{ id: "empty", stage: "compiled", effect: "finalize", roles: [], pattern: "x" },
		],
	});
	assert.ok(!diagnostics.some((d) => /\bok\b/.test(d.message) && /roles/.test(d.message)));
	assert.ok(diagnostics.some((d) => d.level === "warning" && /mixed.*ignores unsupported roles: user/.test(d.message)));
	assert.ok(diagnostics.some((d) => d.level === "warning" && /empty.*roles includes neither/.test(d.message)));
});
