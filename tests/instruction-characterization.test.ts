import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compileMessages } from "../src/compiler.ts";
import { createToolPolicyRuntime } from "../src/runtime/tool-policy-runtime.ts";
import type { PromptRuntime, PromptStack } from "../src/types.ts";
import { createContext, createHarness, startSession, writeStack } from "./helpers/index-command-harness.ts";

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

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(content: string): AgentMessage {
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
// 1. before_agent_start returns full systemPrompt replacement
// ---------------------------------------------------------------------------

test("characterization: before_agent_start returns full systemPrompt replacement rather than partial delta", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-char-start-"));
	writeStack(cwd, "preset.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "preset",
		autoActivate: true,
		items: [
			{ kind: "block", id: "sys1", role: "system", content: "Compiled preset system block 1" },
			{ kind: "block", id: "sys2", role: "system", content: "Compiled preset system block 2" },
		],
	});
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	const baseSystemPrompt = "Pi base system prompt instructions";
	const result = await harness.events.before_agent_start({
		type: "before_agent_start",
		systemPromptOptions: context.ctx.getSystemPromptOptions(),
		systemPrompt: baseSystemPrompt,
		prompt: "run something",
	}, context.ctx);

	// Characterization:
	// 1. before_agent_start returns undefined; it does not force overwrite the systemPrompt.
	// 2. The full compiled system prompt replacement is projected into context messages[0].
	// 3. In default 'replace' mode, the Pi base system prompt is completely discarded.
	assert.equal(result, undefined);

	const contextResult = await harness.events.context_with_system({
		type: "context_with_system",
		messages: [{ role: "user", content: "run something" }],
	}, context.ctx);

	assert.ok(contextResult?.messages);
	const leadingSystem = contextResult.messages[0];
	assert.equal(leadingSystem.role, "system");
	assert.equal(typeof leadingSystem.content, "string");
	assert.equal(leadingSystem.content, "Compiled preset system block 1\n\nCompiled preset system block 2");
	assert.equal(leadingSystem.content.includes(baseSystemPrompt), false);
});

// ---------------------------------------------------------------------------
// 2. compiled messages/history role/max-count filters handling native/unknown system messages
// ---------------------------------------------------------------------------

test("characterization: compileMessages protects native/structural system message from history roles filter (0.5.5 replaced 0.5.4 dropping behavior)", () => {
	// Original 0.5.4 behavior:
	// In 0.5.4, because messageRole(nativeSystemMessage) returns "system" and "system" was not in ["user", "assistant"],
	// the native system message was dropped from chat-history by role filtering.
	//
	// Replaced in 0.5.5:
	// Structural control messages (role "system" or pi-forge-instruction-delivery) are protected
	// and cannot be dropped by chat-history roles filtering.
	const nativeSystemMessage = {
		role: "system",
		content: "Native system instructions present in conversation history",
		timestamp: Date.now(),
	} as unknown as AgentMessage;

	const user = userMessage("User request");
	const assistant = assistantMessage("Assistant reply");

	const stack: PromptStack = {
		schemaVersion: 1,
		id: "filter-roles",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: {
					roles: ["user", "assistant"],
				},
			},
		],
	};

	const result = compileMessages(stack, createRuntime(), [nativeSystemMessage, user, assistant]);

	// In 0.5.5, nativeSystemMessage is protected as a structural control message,
	// so all 3 messages are preserved.
	assert.equal(result.messages.length, 3);
	assert.deepEqual(result.messages, [nativeSystemMessage, user, assistant]);
	assert.equal(
		result.diagnostics.some((d) => d.level === "info" && d.message.includes("Filtered")),
		false,
	);
});

test("characterization: compileMessages retains native system message when unfiltered and treats it identically in maxMessages slicing", () => {
	// Pi dependency is 0.86. Cast to AgentMessage to test compiler behavior on native/structural system messages.
	const nativeSystemMessage = {
		role: "system",
		content: "Native system instructions in history",
		timestamp: 1000,
	} as unknown as AgentMessage;
	const user = userMessage("User request");

	const stackUnfiltered: PromptStack = {
		schemaVersion: 1,
		id: "unfiltered",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
			},
		],
	};

	// 1. Without role filter, emits the native system message into compiled chat messages
	const unfilteredResult = compileMessages(stackUnfiltered, createRuntime(), [nativeSystemMessage, user]);
	assert.equal(unfilteredResult.messages.length, 2);
	assert.equal((unfilteredResult.messages[0] as any).role, "system");
	assert.equal(messageText(unfilteredResult.messages[0]!), "Native system instructions in history");

	// 2. With maxMessages: 1:
	// Original 0.5.4 behavior:
	// In 0.5.4, history limits treated native system messages like ordinary conversation turns,
	// slicing away leading system messages when ordinary turns exceeded the budget.
	//
	// Replaced in 0.5.5:
	// Structural control messages bypass maxMessages budget counting and are preserved
	// in their original relative positions regardless of whether they lead or trail.
	const stackLimited: PromptStack = {
		schemaVersion: 1,
		id: "limited",
		items: [
			{
				kind: "slot",
				id: "history",
				role: "user",
				slot: "chat-history",
				options: { maxMessages: 1 },
			},
		],
	};

	// When native system message is first, ordinary user message (budget 1) is kept and system message is preserved
	const slicedAwayResult = compileMessages(stackLimited, createRuntime(), [nativeSystemMessage, user]);
	assert.equal(slicedAwayResult.messages.length, 2);
	assert.deepEqual(slicedAwayResult.messages, [nativeSystemMessage, user]);

	// When native system message is trailing, ordinary user message (budget 1) is kept and system message is preserved
	const trailingSystemResult = compileMessages(stackLimited, createRuntime(), [user, nativeSystemMessage]);
	assert.equal(trailingSystemResult.messages.length, 2);
	assert.deepEqual(trailingSystemResult.messages, [user, nativeSystemMessage]);
});

// ---------------------------------------------------------------------------
// 3. request-frequency followup doesn't repeat overall layout
// ---------------------------------------------------------------------------

test("characterization: followup turns apply request-frequency regex without repeating prompt stack message layout", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-char-followup-"));
	writeStack(cwd, "followup-stack.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "followup-stack",
		autoActivate: true,
		items: [
			{ kind: "slot", id: "history", role: "user", slot: "chat-history" },
			{ kind: "block", id: "post-history-cot", role: "user", content: "PLANNING_REMINDER: think step by step" },
		],
		regex: {
			rules: [
				{
					id: "mask-secret",
					stage: "compiled",
					frequency: "request",
					pattern: "SECRET_TOKEN",
					replace: "REDACTED_TOKEN",
				},
			],
		},
	});
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	// Initial user prompt triggers before_agent_start
	await harness.events.before_agent_start({
		type: "before_agent_start",
		systemPromptOptions: context.ctx.getSystemPromptOptions(),
		systemPrompt: "base system prompt",
		prompt: "Initial prompt containing SECRET_TOKEN",
	}, context.ctx);

	// First provider request: contextRewritePending is true
	const initialMessages = [
		{ role: "user", content: "Initial prompt containing SECRET_TOKEN" },
	];
	const firstContextResult = await harness.events.context_with_system({
		type: "context_with_system",
		messages: initialMessages,
	}, context.ctx);

	// First request rewrites layout: includes history (with regex applied) AND appends post-history block
	assert.ok(firstContextResult?.messages);
	assert.equal(firstContextResult.messages.length, 3);
	assert.equal(firstContextResult.messages[0].role, "system");
	assert.equal(messageText(firstContextResult.messages[1]!), "Initial prompt containing REDACTED_TOKEN");
	assert.equal(messageText(firstContextResult.messages[2]!), "PLANNING_REMINDER: think step by step");

	// Tool execution happens; Pi triggers follow-up context event in the same agent start
	// At this point contextRewritePending is false.
	const followupMessages = [
		{ role: "user", content: "Initial prompt containing SECRET_TOKEN" },
		{ role: "assistant", content: "Calling tool..." },
		{ role: "toolResult", toolCallId: "call_1", content: "Tool output with SECRET_TOKEN" },
	];
	const followupContextResult = await harness.events.context_with_system({
		type: "context_with_system",
		messages: followupMessages,
	}, context.ctx);

	// Characterization:
	// Follow-up context does NOT re-append the post-history layout block.
	// It projects the leading system prompt and applies only the request-frequency regex rule over Pi's natural transcript.
	assert.ok(followupContextResult?.messages);
	assert.equal(followupContextResult.messages.length, 4);
	assert.equal(followupContextResult.messages[0].role, "system");
	assert.equal(messageText(followupContextResult.messages[1]!), "Initial prompt containing REDACTED_TOKEN");
	assert.equal(messageText(followupContextResult.messages[2]!), "Calling tool...");
	assert.equal(messageText(followupContextResult.messages[3]!), "Tool output with REDACTED_TOKEN");

	const containsLayoutBlock = followupContextResult.messages.some((m: any) =>
		messageText(m).includes("PLANNING_REMINDER"),
	);
	assert.equal(containsLayoutBlock, false);
});

test("characterization: followup turns without request-frequency rules return undefined to preserve natural context", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-char-followup-plain-"));
	writeStack(cwd, "plain-stack.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "plain-stack",
		autoActivate: true,
		items: [
			{ kind: "slot", id: "history", role: "user", slot: "chat-history" },
			{ kind: "block", id: "user-guidance", role: "user", content: "Extra guidance" },
		],
		// No request-frequency regex rules
	});
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	await harness.events.before_agent_start({
		type: "before_agent_start",
		systemPromptOptions: context.ctx.getSystemPromptOptions(),
		systemPrompt: "base system prompt",
		prompt: "Initial prompt",
	}, context.ctx);

	// First request rewrites messages layout
	const firstResult = await harness.events.context_with_system({
		type: "context_with_system",
		messages: [{ role: "user", content: "Initial prompt" }],
	}, context.ctx);
	assert.ok(firstResult?.messages);
	assert.equal(firstResult.messages.length, 3);
	assert.equal(firstResult.messages[0].role, "system");
	assert.equal(messageText(firstResult.messages[1]!), "Initial prompt");
	assert.equal(messageText(firstResult.messages[2]!), "Extra guidance");

	// Followup turn without request-frequency rules preserves natural context with projected leading system
	const followupResult = await harness.events.context_with_system({
		type: "context_with_system",
		messages: [
			{ role: "user", content: "Initial prompt" },
			{ role: "assistant", content: "calling tool" },
			{ role: "toolResult", toolCallId: "call_1", content: "done" },
		],
	}, context.ctx);
	assert.ok(followupResult?.messages);
	assert.equal(followupResult.messages.length, 4);
	assert.equal(followupResult.messages[0].role, "system");
	assert.equal(messageText(followupResult.messages[1]!), "Initial prompt");
	assert.equal(messageText(followupResult.messages[2]!), "calling tool");
	assert.equal(messageText(followupResult.messages[3]!), "done");
	const containsGuidance = followupResult.messages.some((m: any) =>
		messageText(m).includes("Extra guidance"),
	);
	assert.equal(containsGuidance, false);
});

// ---------------------------------------------------------------------------
// 4. tool-policy resume input already-filtered tools & external add/remove
// ---------------------------------------------------------------------------

test("characterization: tool-policy runtime cannot recover baseline tools lost before session resume", () => {
	// Pi has full set of tools available in the environment:
	const allTools = [
		{ name: "read" },
		{ name: "bash" },
		{ name: "edit" },
		{ name: "write" },
	];
	// But at session resume / new runtime startup, active tools was already filtered
	// (e.g. "bash" was previously blocked or deactivated before this runtime started):
	let activeTools = ["read", "edit", "write"];

	const pi = {
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools,
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	} as any;

	const state: { active?: any } = {
		active: {
			stack: {
				schemaVersion: 1,
				id: "deny-edit",
				tools: { deny: ["edit"] },
				items: [],
			},
		},
	};

	const runtime = createToolPolicyRuntime(pi, () => state.active);

	// First sync establishes baseline from current pi.getActiveTools()
	runtime.sync();
	assert.deepEqual(activeTools, ["read", "write"]);

	// Deactivate stack and restore
	state.active = undefined;
	runtime.restore();

	// Characterization (0.5.4 limitation):
	// baseline was initialized as ["read", "edit", "write"].
	// When restored, "bash" is NOT recovered even though "bash" is registered in allTools.
	// 0.5.5 will review baseline persistence across session boundaries.
	assert.deepEqual(activeTools, ["read", "edit", "write"]);
	assert.equal(activeTools.includes("bash"), false);
});

test("characterization: tool-policy runtime reconciles external tool additions and removals while policy is active", () => {
	const allTools = [
		{ name: "read" },
		{ name: "bash" },
		{ name: "edit" },
		{ name: "write" },
	];
	let activeTools = ["read", "bash", "edit", "write"];

	const pi = {
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools,
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	} as any;

	const state: { active?: any } = {
		active: {
			stack: {
				schemaVersion: 1,
				id: "deny-bash",
				tools: { deny: ["bash"] },
				items: [],
			},
		},
	};

	const runtime = createToolPolicyRuntime(pi, () => state.active);

	// Initial sync: bash is denied
	runtime.sync();
	assert.deepEqual(activeTools, ["read", "edit", "write"]);

	// 1. External addition: a new tool is registered and activated externally
	allTools.push({ name: "git-diff" });
	activeTools.push("git-diff");

	// sync reconciles git-diff into baseline because it is in activeTools but not lastApplied
	runtime.sync();
	assert.deepEqual(activeTools, ["read", "edit", "write", "git-diff"]);

	// On restore, git-diff and unblocked bash are both present in restored baseline
	runtime.restore();
	assert.deepEqual(activeTools, ["read", "bash", "edit", "write", "git-diff"]);

	// 2. External removal: re-apply deny policy, then externally remove "edit"
	runtime.sync();
	assert.deepEqual(activeTools, ["read", "edit", "write", "git-diff"]);

	// User/external deactivates "edit"
	activeTools = activeTools.filter((name) => name !== "edit");

	// sync reconciles removal of "edit" out of baseline because it was in lastApplied but absent from activeTools
	runtime.sync();
	assert.deepEqual(activeTools, ["read", "write", "git-diff"]);

	// On restore, "edit" remains removed while bash is restored
	runtime.restore();
	assert.deepEqual(activeTools, ["read", "bash", "write", "git-diff"]);
	assert.equal(activeTools.includes("edit"), false);
});
