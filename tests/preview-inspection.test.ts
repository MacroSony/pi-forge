import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { buildPreview } from "../src/preview.ts";
import {
	buildSectionInspection,
	createInspectionTracker,
	formatToolCallArguments,
	isTemporaryInspectionKey,
	resolveInspectionScope,
} from "../src/preview-inspection.ts";
import { diffTurns } from "../src/context-diff.ts";
import { previewToTurnSnapshot } from "../src/web-editor/client/preview-diff.ts";
import type { LoadedPromptStack, PromptCompileOptions } from "../src/types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const defaultOptions: PromptCompileOptions = { cwd: "/test" };

function makeStack(options?: {
	id?: string;
	allowDuplicateChatHistory?: boolean;
	slots?: Array<{ id: string; slot: string }>;
}): LoadedPromptStack {
	const id = options?.id ?? "test-stack";
	const items = options?.slots
		? [
				{ kind: "block" as const, id: "sys", role: "system" as const, content: "System base instruction." },
				...options.slots.map((s) => ({ kind: "slot" as const, id: s.id, slot: s.slot })),
			]
		: [
				{ kind: "block" as const, id: "sys", role: "system" as const, content: "System base instruction." },
				{ kind: "slot" as const, id: "hist", slot: "chat-history" },
			];

	return {
		stack: {
			schemaVersion: 2,
			type: "pi-forge.prompt-stack",
			id,
			context: options?.allowDuplicateChatHistory ? { allowDuplicateChatHistory: true } : undefined,
			items,
		},
		filePath: `/test/${id}.json`,
		scope: "project",
		key: { scope: "project", id },
		diagnostics: [],
	};
}

function ensureParentLinks<T extends Record<string, unknown>>(entries: T[]): T[] {
	let prevId: string | null = null;
	return entries.map((entry, index) => {
		const id = typeof entry.id === "string" && entry.id ? entry.id : `entry-${index + 1}`;
		const parentId = "parentId" in entry ? (entry.parentId as string | null) : prevId;
		prevId = id;
		return {
			...entry,
			id,
			parentId,
		};
	});
}

function makeContext(options: {
	entries?: unknown[];
	systemPrompt?: string;
	supportsMidConvoSystemMessages?: boolean;
	trusted?: boolean;
}) {
	const rawEntries = (options.entries ?? []) as Array<Record<string, unknown>>;
	const entries = ensureParentLinks(rawEntries);
	const leafId = entries.length ? (entries[entries.length - 1] as { id: string }).id : null;
	return {
		sessionManager: {
			getLeafId: () => leafId,
			getEntries: () => entries,
			getBranch: (_fromId?: string) => entries,
		},
		getSystemPrompt: () => options.systemPrompt ?? "Base Pi prompt",
		getSystemPromptOptions: () => defaultOptions,
		isProjectTrusted: () => options.trusted ?? true,
		model: {
			provider: "test-provider",
			id: "test-model",
			api: "test-api",
			compat: {
				supportsMidConvoSystemMessages: options.supportsMidConvoSystemMessages ?? true,
			},
		},
	} as unknown as ExtensionContext;
}

test("assistant text/thinking/multiple calls preserve original order and format structured arguments", () => {
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "I will check the repository structure first." },
			{ type: "thinking", thinking: "Need to list files and inspect package.json." },
			{ type: "toolCall", id: "call_ls_1", name: "ls", arguments: { path: "src" } },
			{ type: "toolCall", id: "call_read_2", name: "read", arguments: { path: "package.json", limit: 20 } },
		],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1000,
	};

	const entries = [{ type: "message", id: "entry-1", message: assistantMessage }];
	const ctx = makeContext({ entries });
	const result = buildPreview(ctx, makeStack(), defaultOptions);

	assert.equal(result.preview.messages.length, 1);
	const section = result.preview.messages[0]!;
	assert.ok(section.inspection, "Inspection sidecar must be attached");

	const inspection = section.inspection;
	assert.equal(inspection.scope, "chat-history:hist");
	assert.ok(!isTemporaryInspectionKey(inspection.key), "Single occurrence should not be marked temporary");
	assert.equal(inspection.toolResult, undefined, "Assistant message must not have toolResult");

	// Verify exact original order of parts
	assert.equal(inspection.parts.length, 4);

	// Part 0: text
	assert.equal(inspection.parts[0]?.kind, "text");
	assert.equal(inspection.parts[0]?.text, "I will check the repository structure first.");
	assert.equal(inspection.parts[0]?.key, `${inspection.key}:part:0`);

	// Part 1: thinking
	assert.equal(inspection.parts[1]?.kind, "thinking");
	assert.equal(inspection.parts[1]?.text, "Need to list files and inspect package.json.");
	assert.equal(inspection.parts[1]?.key, `${inspection.key}:part:1`);

	// Part 2: first toolCall
	assert.equal(inspection.parts[2]?.kind, "toolCall");
	assert.equal(inspection.parts[2]?.toolName, "ls");
	assert.equal(inspection.parts[2]?.callId, "call_ls_1");
	assert.equal(inspection.parts[2]?.text, formatToolCallArguments({ path: "src" }));
	assert.equal(inspection.parts[2]?.key, `${inspection.key}:part:2`);

	// Part 3: second toolCall
	assert.equal(inspection.parts[3]?.kind, "toolCall");
	assert.equal(inspection.parts[3]?.toolName, "read");
	assert.equal(inspection.parts[3]?.callId, "call_read_2");
	assert.equal(inspection.parts[3]?.text, formatToolCallArguments({ path: "package.json", limit: 20 }));
	assert.equal(inspection.parts[3]?.key, `${inspection.key}:part:3`);
});

test("tool results in reverse order with isError flags correctly populate toolResult inspection sidecar", () => {
	// Call 2 result arrives first (with isError: true), then Call 1 result (with isError: false)
	const toolResult2: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_read_2",
		toolName: "read",
		isError: true,
		content: [{ type: "text", text: "Error: file not found: package.json" }],
		timestamp: 1100,
	};
	const toolResult1: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_ls_1",
		toolName: "ls",
		isError: false,
		content: [{ type: "text", text: "preview.ts\ncompiler.ts" }],
		timestamp: 1200,
	};

	const entries = [
		{ type: "message", id: "entry-r2", message: toolResult2 },
		{ type: "message", id: "entry-r1", message: toolResult1 },
	];
	const ctx = makeContext({ entries });
	const result = buildPreview(ctx, makeStack(), defaultOptions);

	assert.equal(result.preview.messages.length, 2);

	const section1 = result.preview.messages[0]!;
	const insp1 = section1.inspection!;
	assert.ok(insp1.toolResult);
	assert.equal(insp1.toolResult.callId, "call_read_2");
	assert.equal(insp1.toolResult.toolName, "read");
	assert.equal(insp1.toolResult.isError, true);
	assert.equal(insp1.parts.length, 1);
	assert.equal(insp1.parts[0]?.kind, "text");
	assert.equal(insp1.parts[0]?.text, "Error: file not found: package.json");

	const section2 = result.preview.messages[1]!;
	const insp2 = section2.inspection!;
	assert.ok(insp2.toolResult);
	assert.equal(insp2.toolResult.callId, "call_ls_1");
	assert.equal(insp2.toolResult.toolName, "ls");
	assert.equal(insp2.toolResult.isError, false);
	assert.equal(insp2.parts.length, 1);
	assert.equal(insp2.parts[0]?.kind, "text");
	assert.equal(insp2.parts[0]?.text, "preview.ts\ncompiler.ts");
});

test("image parts provide explicit placeholder and mimeType without leaking base64 data", () => {
	const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
	const userMessage: UserMessage = {
		role: "user",
		content: [
			{ type: "text", text: "Here is an issue screenshot:" },
			{ type: "image", data: base64Data, mimeType: "image/png" },
		],
		timestamp: 1000,
	};

	const entries = [{ type: "message", id: "entry-img", message: userMessage }];
	const ctx = makeContext({ entries });
	const result = buildPreview(ctx, makeStack(), defaultOptions);

	const section = result.preview.messages[0]!;
	const inspection = section.inspection!;
	assert.equal(inspection.parts.length, 2);

	const imagePart = inspection.parts[1]!;
	assert.equal(imagePart.kind, "image");
	assert.equal(imagePart.text, "[image: image/png]");

	// Critical leak test: base64 payload must never appear in preview output
	const previewJson = JSON.stringify(result.preview);
	assert.ok(!previewJson.includes(base64Data), "Base64 data must never leak into preview structure");
	assert.ok(!result.text.includes(base64Data), "Base64 data must never leak into preview text");
});

test("unknown role and unknown part type are neutrally preserved", () => {
	const customMessage = {
		role: "evaluator-audit",
		content: [
			{ type: "metricRecord", score: 0.95, metric: "accuracy" },
		],
		timestamp: 1000,
	} as unknown as AgentMessage;

	const entries = [{ type: "message", id: "entry-custom", message: customMessage }];
	const ctx = makeContext({ entries });
	const result = buildPreview(ctx, makeStack(), defaultOptions);

	const section = result.preview.messages[0]!;
	assert.equal(section.role, "evaluator-audit");
	const inspection = section.inspection!;
	assert.ok(inspection.key.includes(":evaluator-audit:"), "Key should contain custom role");

	assert.equal(inspection.parts.length, 1);
	assert.equal(inspection.parts[0]?.kind, "unknown");
	assert.equal(inspection.parts[0]?.text, "[unknown: metricRecord]");
});

test("tool call parameter change affects inspection key while leaving legacy text and diffKey unchanged", () => {
	const assistantA: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_search", name: "search", arguments: { query: "apple", limit: 5 } },
		],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1000,
	};

	const assistantB: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_search", name: "search", arguments: { query: "orange", limit: 10 } },
		],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1000,
	};

	const previewA = buildPreview(makeContext({ entries: [{ type: "message", id: "e1", message: assistantA }] }), makeStack(), defaultOptions);
	const previewB = buildPreview(makeContext({ entries: [{ type: "message", id: "e1", message: assistantB }] }), makeStack(), defaultOptions);

	const sectionA = previewA.preview.messages[0]!;
	const sectionB = previewB.preview.messages[0]!;

	// Legacy behavior must remain strictly identical
	assert.equal(sectionA.content, sectionB.content, "Legacy section content must remain identical");
	assert.equal(sectionA.diffKey, sectionB.diffKey, "Legacy diffKey must remain identical");
	assert.equal(sectionA.chars, sectionB.chars);
	assert.equal(sectionA.approxTokens, sectionB.approxTokens);
	assert.equal(previewA.preview.totalChars, previewB.preview.totalChars);
	assert.equal(previewA.preview.approxTokens, previewB.preview.approxTokens);

	// Inspection key and part text must differ due to argument changes
	assert.notEqual(sectionA.inspection!.key, sectionB.inspection!.key, "Inspection key must reflect parameter change");
	assert.notEqual(sectionA.inspection!.parts[0]!.text, sectionB.inspection!.parts[0]!.text, "Inspection part text must reflect parameter change");
});

test("preview inspection does not mutate input session messages or stack target", () => {
	const originalMessage: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "Pure calculation." },
			{ type: "toolCall", id: "call_1", name: "calc", arguments: { expr: "1 + 1" } },
		],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1000,
	};

	const clonedMessage = structuredClone(originalMessage);
	const stack = makeStack();
	const clonedStack = structuredClone(stack);

	const entries = [{ type: "message", id: "e1", message: originalMessage }];
	const ctx = makeContext({ entries });

	buildPreview(ctx, stack, defaultOptions);

	assert.deepEqual(originalMessage, clonedMessage, "Input message must not be mutated");
	assert.deepEqual(stack, clonedStack, "Input stack must not be mutated");
});

test("preview inspection sidecar does not change total tokens or diff turn summary", () => {
	const user1: UserMessage = { role: "user", content: "Hello world", timestamp: 1000 };
	const assistant1: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Hello! How can I help you today?" }],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1010,
	};

	const ctx = makeContext({ entries: [{ type: "message", id: "e1", message: user1 }, { type: "message", id: "e2", message: assistant1 }] });
	const result = buildPreview(ctx, makeStack(), defaultOptions);

	// Verify diff summary matches expected pure text semantics
	const snapshotA = previewToTurnSnapshot(result.preview, "draft");
	const snapshotB = previewToTurnSnapshot(result.preview, "saved");
	const diff = diffTurns(snapshotA, snapshotB);

	assert.equal(diff.summary.addedBlocks, 0);
	assert.equal(diff.summary.modifiedBlocks, 0);
	assert.equal(diff.summary.sameBlocks, 3); // 1 system + 2 messages
});

test("arbitrary message extension fields do not affect identity, unified scope and display hash used", () => {
	const userWithoutFields: UserMessage = {
		role: "user",
		content: "Standard user question",
		timestamp: 1000,
	};
	const userWithFields = {
		role: "user",
		content: "Standard user question",
		entryId: "sdk-entry-abc-123",
		sourceEntryId: "source-entry-456",
		id: "message-789",
		timestamp: 1000,
	} as unknown as AgentMessage;

	const previewA = buildPreview(
		makeContext({ entries: [{ type: "message", id: "e1", message: userWithoutFields }] }),
		makeStack(),
		defaultOptions,
	);
	const previewB = buildPreview(
		makeContext({ entries: [{ type: "message", id: "e2", message: userWithFields }] }),
		makeStack(),
		defaultOptions,
	);

	const inspectionA = previewA.preview.messages[0]!.inspection!;
	const inspectionB = previewB.preview.messages[0]!.inspection!;

	// Key must be strictly identical: unified scope + role + display structure hash
	assert.equal(inspectionA.key, inspectionB.key);
	assert.ok(!inspectionB.key.includes("sdk-entry-abc-123"), "Key must not incorporate unverified entryId");
	assert.ok(!inspectionB.key.includes("source-entry-456"), "Key must not incorporate sourceEntryId");
	assert.ok(!inspectionB.key.includes("message-789"), "Key must not incorporate arbitrary id");
	assert.ok(inspectionB.key.startsWith("chat-history:hist:user:"), "Key must follow scope:role:hash format");
	assert.ok(!isTemporaryInspectionKey(inspectionA.key));
});

test("duplicate identical fingerprints mark first occurrence and subsequent occurrences as temporary", () => {
	// Three identical messages in the same slot
	const user1: UserMessage = { role: "user", content: "Repeat question", timestamp: 1000 };
	const user2: UserMessage = { role: "user", content: "Repeat question", timestamp: 2000 };
	const user3: UserMessage = { role: "user", content: "Repeat question", timestamp: 3000 };

	// Case 1: Only 1 occurrence - remains stable
	const singleCtx = makeContext({ entries: [{ type: "message", id: "e1", message: user1 }] });
	const singleResult = buildPreview(singleCtx, makeStack(), defaultOptions);
	const singleInsp = singleResult.preview.messages[0]!.inspection!;
	assert.ok(singleInsp.key.endsWith(":1"), "Single occurrence should end with :1");
	assert.ok(!isTemporaryInspectionKey(singleInsp.key), "Single occurrence must not be temporary");
	assert.ok(!isTemporaryInspectionKey(singleInsp.parts[0]!.key), "Single occurrence part must not be temporary");

	// Case 2: Duplicates present - first and subsequent occurrences become temporary
	const dupCtx = makeContext({
		entries: [
			{ type: "message", id: "e1", message: user1 },
			{ type: "message", id: "e2", message: user2 },
			{ type: "message", id: "e3", message: user3 },
		],
	});
	const dupResult = buildPreview(dupCtx, makeStack(), defaultOptions);
	assert.equal(dupResult.preview.messages.length, 3);

	const insp1 = dupResult.preview.messages[0]!.inspection!;
	const insp2 = dupResult.preview.messages[1]!.inspection!;
	const insp3 = dupResult.preview.messages[2]!.inspection!;

	// First occurrence retroactively marked temporary
	assert.ok(insp1.key.endsWith(":temp:1"), `First occurrence should be marked :temp:1, got ${insp1.key}`);
	assert.ok(isTemporaryInspectionKey(insp1.key), "First occurrence must be marked temporary");
	assert.ok(isTemporaryInspectionKey(insp1.parts[0]!.key), "First occurrence part key must be temporary");
	assert.ok(insp1.parts[0]!.key.endsWith(":temp:1:part:0"));

	// Second occurrence marked temporary
	assert.ok(insp2.key.endsWith(":temp:2"), `Second occurrence should be marked :temp:2, got ${insp2.key}`);
	assert.ok(isTemporaryInspectionKey(insp2.key), "Second occurrence must be marked temporary");
	assert.ok(isTemporaryInspectionKey(insp2.parts[0]!.key), "Second occurrence part key must be temporary");
	assert.ok(insp2.parts[0]!.key.endsWith(":temp:2:part:0"));

	// Third occurrence marked temporary
	assert.ok(insp3.key.endsWith(":temp:3"), `Third occurrence should be marked :temp:3, got ${insp3.key}`);
	assert.ok(isTemporaryInspectionKey(insp3.key), "Third occurrence must be marked temporary");
	assert.ok(isTemporaryInspectionKey(insp3.parts[0]!.key), "Third occurrence part key must be temporary");
	assert.ok(insp3.parts[0]!.key.endsWith(":temp:3:part:0"));
});

test("repeating history slots have distinct scopes and do not cross-pair", () => {
	const userMsg: UserMessage = { role: "user", content: "Message in history", timestamp: 1000 };
	const stack = makeStack({
		allowDuplicateChatHistory: true,
		slots: [
			{ id: "slot_first_history", slot: "chat-history" },
			{ id: "slot_second_history", slot: "chat-history" },
		],
	});

	const entries = [{ type: "message", id: "e1", message: userMsg }];
	const ctx = makeContext({ entries });
	const result = buildPreview(ctx, stack, defaultOptions);

	assert.equal(result.preview.messages.length, 2);
	const insp1 = result.preview.messages[0]!.inspection!;
	const insp2 = result.preview.messages[1]!.inspection!;

	assert.equal(insp1.scope, "chat-history:slot_first_history");
	assert.equal(insp2.scope, "chat-history:slot_second_history");
	assert.notEqual(insp1.key, insp2.key, "Keys across different slot instances must differ by scope");
});

test("leading system prompt inspection sidecar preserves existing sections and toolChanges", () => {
	const stack = makeStack();
	const ctx = makeContext({
		systemPrompt: "Live custom Pi system prompt",
	});
	const result = buildPreview(ctx, stack, defaultOptions);

	const system = result.preview.system;
	assert.ok(system.inspection);
	assert.equal(system.inspection.scope, "system");
	assert.ok(system.inspection.key.startsWith("system:system:"));
	assert.ok(system.inspection.parts.length >= 1);
	assert.equal(system.inspection.parts[0]?.kind, "text");
});

test("extractToolResult enforces msg.role === 'toolResult' and toolCallId, unknown roles remain neutral", () => {
	// Unknown role with tool result-like fields must NOT be treated as toolResult
	const impostorMessage = {
		role: "custom-status",
		toolCallId: "call_fake_1",
		toolName: "read",
		isError: true,
		content: [{ type: "text", text: "Fake tool output" }],
		timestamp: 1000,
	} as unknown as AgentMessage;

	const validToolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_valid_1",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "Actual output" }],
		timestamp: 1100,
	};

	// Tool result with wrong id property (callId instead of toolCallId)
	const malformedToolResult = {
		role: "toolResult",
		callId: "call_wrong_id",
		toolName: "ls",
		isError: false,
		content: [{ type: "text", text: "ls output" }],
		timestamp: 1200,
	} as unknown as AgentMessage;

	const entries = [
		{ type: "message", id: "e1", message: impostorMessage },
		{ type: "message", id: "e2", message: validToolResult },
		{ type: "message", id: "e3", message: malformedToolResult },
	];
	const ctx = makeContext({ entries });
	const result = buildPreview(ctx, makeStack(), defaultOptions);

	const inspImpostor = result.preview.messages[0]!.inspection!;
	assert.equal(inspImpostor.toolResult, undefined, "Non-toolResult role must never populate toolResult metadata");
	assert.equal(inspImpostor.parts[0]?.text, "Fake tool output", "Body remains neutrally preserved");

	const inspValid = result.preview.messages[1]!.inspection!;
	assert.ok(inspValid.toolResult);
	assert.equal(inspValid.toolResult.callId, "call_valid_1");
	assert.equal(inspValid.toolResult.toolName, "read");
	assert.equal(inspValid.toolResult.isError, false);

	const inspMalformed = result.preview.messages[2]!.inspection!;
	assert.ok(inspMalformed.toolResult);
	assert.equal(inspMalformed.toolResult.callId, undefined, "Must not read callId fallback; only toolCallId is authoritative");
	assert.equal(inspMalformed.toolResult.toolName, "ls");
});

test("formatToolCallArguments handles null, undefined, strings, and structured values accurately", () => {
	// Direct helper unit checks
	assert.equal(formatToolCallArguments(undefined), "[arguments unavailable]");
	assert.equal(formatToolCallArguments(null), "null");
	assert.equal(formatToolCallArguments("plain string"), "\"plain string\"");
	assert.equal(formatToolCallArguments("{}"), "\"{}\"");
	assert.equal(formatToolCallArguments({}), "{}");
	assert.equal(formatToolCallArguments({ limit: 10 }), "{\n  \"limit\": 10\n}");

	// Integration via assistant message tool calls
	const assistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "c1", name: "t_undef", arguments: undefined },
			{ type: "toolCall", id: "c2", name: "t_null", arguments: null },
			{ type: "toolCall", id: "c3", name: "t_str", arguments: "raw string arg" },
			{ type: "toolCall", id: "c4", name: "t_obj", arguments: { file: "test.ts" } },
		],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1000,
	} as unknown as AssistantMessage;

	const ctx = makeContext({ entries: [{ type: "message", id: "e1", message: assistantMessage }] });
	const result = buildPreview(ctx, makeStack(), defaultOptions);
	const parts = result.preview.messages[0]!.inspection!.parts;

	assert.equal(parts[0]?.text, "[arguments unavailable]");
	assert.equal(parts[1]?.text, "null");
	assert.equal(parts[2]?.text, "\"raw string arg\"");
	assert.equal(parts[3]?.text, "{\n  \"file\": \"test.ts\"\n}");
});

test("fingerprint distinguishes missing isError from isError: false and isError: true", () => {
	const resultMissingError = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "exec",
		// isError omitted
		content: [{ type: "text", text: "Process exited with code 0" }],
		timestamp: 1000,
	} as unknown as ToolResultMessage;

	const resultFalseError: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "exec",
		isError: false,
		content: [{ type: "text", text: "Process exited with code 0" }],
		timestamp: 1000,
	};

	const resultTrueError: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "exec",
		isError: true,
		content: [{ type: "text", text: "Process exited with code 0" }],
		timestamp: 1000,
	};

	const previewMissing = buildPreview(makeContext({ entries: [{ type: "message", id: "e1", message: resultMissingError }] }), makeStack(), defaultOptions);
	const previewFalse = buildPreview(makeContext({ entries: [{ type: "message", id: "e1", message: resultFalseError }] }), makeStack(), defaultOptions);
	const previewTrue = buildPreview(makeContext({ entries: [{ type: "message", id: "e1", message: resultTrueError }] }), makeStack(), defaultOptions);

	const keyMissing = previewMissing.preview.messages[0]!.inspection!.key;
	const keyFalse = previewFalse.preview.messages[0]!.inspection!.key;
	const keyTrue = previewTrue.preview.messages[0]!.inspection!.key;

	assert.notEqual(keyMissing, keyFalse, "Missing isError must produce a different fingerprint from isError: false");
	assert.notEqual(keyMissing, keyTrue, "Missing isError must produce a different fingerprint from isError: true");
	assert.notEqual(keyFalse, keyTrue, "isError: false must produce a different fingerprint from isError: true");
});


test("inspection identity includes System section operations and historical tool metadata, not just empty body", () => {
 const tracker = createInspectionTracker();
 const inputs = [
  { role: "system", content: "", sections: { note: "one" } },
  { role: "system", content: "", sections: { note: "two" } },
  { role: "system", content: "", sections: { note: "" } },
  { role: "system", content: "", sections: { note: null } },
  { role: "system", content: "", toolsRemoved: ["read"] },
  { role: "system", content: "", toolsRemoved: ["write"] },
  { role: "system", content: "", toolsAdded: [{ name: "read", description: "one", parameters: {} }] },
  { role: "system", content: "", toolsAdded: [{ name: "read", description: "two", parameters: {} }] },
 ];
 const sections = inputs.map(message => buildSectionInspection(message as AgentMessage, "same-system-scope", tracker));
 assert.equal(new Set(sections.map(section => section.key)).size, inputs.length);
 assert.ok(sections.every(section => !isTemporaryInspectionKey(section.key)));
 assert.ok(sections.every(section => section.parts.length === 0), "Metadata remains separate from message prose");
});
