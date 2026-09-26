import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { buildPreview, renderPreview } from "../src/preview.ts";
import {
	INSTRUCTION_DELIVERY_TYPE,
	INSTRUCTION_EVENT_ENTRY,
} from "../src/instruction-protocol.ts";
import {
	createInstructionSnapshot,
	type InstructionActivateEvent,
	type InstructionDeactivateEvent,
} from "../src/instruction-events.ts";
import type { LoadedPromptStack, PromptCompileOptions } from "../src/types.ts";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const defaultOptions: PromptCompileOptions = { cwd: "/test" };

function makeStack(id = "test-stack"): LoadedPromptStack {
	return {
		stack: {
			schemaVersion: 2,
			type: "pi-forge.prompt-stack",
			id,
			items: [
				{ kind: "block", id: "sys", role: "system", content: "Base system prompt from stack." },
				{ kind: "slot", id: "hist", slot: "chat-history" },
			],
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
	leafId?: string | null;
	systemPrompt?: string;
	supportsMidConvoSystemMessages?: boolean;
	trusted?: boolean;
	appendCalls?: unknown[];
}) {
	const rawEntries = (options.entries ?? []) as Array<Record<string, unknown>>;
	const entries = ensureParentLinks(rawEntries);
	const leafId = options.leafId !== undefined
		? options.leafId
		: (entries.length ? (entries[entries.length - 1] as { id: string }).id : null);
	const appendCalls = options.appendCalls ?? [];
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
		appendEntry: (type: string, data: unknown) => {
			appendCalls.push({ type, data });
		},
		sendMessage: () => {
			throw new Error("sendMessage should not be called in pure preview");
		},
	} as unknown as ExtensionContext;
}

function makeRealContext(
	sm: SessionManager,
	options?: {
		systemPrompt?: string;
		supportsMidConvoSystemMessages?: boolean;
		trusted?: boolean;
		appendCalls?: unknown[];
	},
) {
	const appendCalls = options?.appendCalls ?? [];
	return {
		sessionManager: sm,
		getSystemPrompt: () => options?.systemPrompt ?? "Base Pi prompt",
		getSystemPromptOptions: () => defaultOptions,
		isProjectTrusted: () => options?.trusted ?? true,
		model: {
			provider: "test-provider",
			id: "test-model",
			api: "test-api",
			compat: {
				supportsMidConvoSystemMessages: options?.supportsMidConvoSystemMessages ?? true,
			},
		},
		appendEntry: (type: string, data: unknown) => {
			appendCalls.push({ type, data });
		},
		sendMessage: () => {
			throw new Error("sendMessage should not be called in pure preview");
		},
	} as unknown as ExtensionContext;
}

function makeActivateEvent(
	eventId: string,
	activationId: string,
	content: string,
	createdAt = 1000,
	tools = { add: [] as string[], remove: [] as string[] },
): InstructionActivateEvent {
	return {
		schemaVersion: 1,
		eventId,
		op: "activate",
		actor: "user",
		createdAt,
		snapshot: createInstructionSnapshot({
			activationId,
			source: { kind: "manual" },
			content,
			tools,
		}),
	};
}

function makeDeactivateEvent(eventId: string, activationId: string, createdAt = 2000): InstructionDeactivateEvent {
	return {
		schemaVersion: 1,
		eventId,
		op: "deactivate",
		actor: "user",
		createdAt,
		activationId,
	};
}

function makeCarrierEntry(id: string, throughEventId: string, timestamp = 1500) {
	return {
		type: "custom_message",
		id,
		customType: INSTRUCTION_DELIVERY_TYPE,
		content: "Forge instruction state changed. Use /instruction status to inspect it.",
		display: false,
		details: {
			schemaVersion: 1,
			throughEventId,
		},
		timestamp,
	};
}

function makeEventEntry(id: string, event: unknown) {
	return {
		type: "custom",
		id,
		customType: INSTRUCTION_EVENT_ENTRY,
		data: event,
	};
}

test("1. native on/off: instruction delta renders structured section, no carrier prose leak, provenance preserved", () => {
	const ev1 = makeActivateEvent("ev-1", "act-1", "Rule alpha active");
	const ev2 = makeDeactivateEvent("ev-2", "act-1", 2000);

	const entries = [
		makeEventEntry("entry-ev-1", ev1),
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Hello", timestamp: 1100 },
		},
		makeCarrierEntry("carrier-1", "ev-1", 1200),
		{
			type: "message",
			id: "msg-2",
			message: { role: "assistant", content: [{ type: "text", text: "Hi there" }], timestamp: 1300 },
		},
		makeEventEntry("entry-ev-2", ev2),
		makeCarrierEntry("carrier-2", "ev-2", 2100),
		{
			type: "message",
			id: "msg-3",
			message: { role: "user", content: "Next question", timestamp: 2200 },
		},
	];

	const ctx = makeContext({ entries, supportsMidConvoSystemMessages: true });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	// Check that carrier text is NOT leaked
	const allContent = [
		result.preview.system.content,
		...result.preview.messages.map((m) => m.content),
		result.text,
	].join("\n");
	assert.ok(
		!allContent.includes("Forge instruction state changed"),
		"Carrier prose must not leak into preview content or text",
	);

	assert.equal(result.preview.messages.length, 5);

	const userMsg1 = result.preview.messages[0];
	assert.equal(userMsg1.role, "user");
	assert.equal(userMsg1.title, "Chat history #1");
	assert.equal(userMsg1.content, "Hello");

	const actUpdate = result.preview.messages[1];
	assert.equal(actUpdate.role, "system");
	assert.equal(actUpdate.title, "Forge instruction update");
	assert.equal(actUpdate.content, "");
	assert.equal(actUpdate.sections?.["forge-instruction-act-1"], "Rule alpha active");

	const asstMsg = result.preview.messages[2];
	assert.equal(asstMsg.role, "assistant");
	assert.equal(asstMsg.title, "Chat history #3");

	const deactUpdate = result.preview.messages[3];
	assert.equal(deactUpdate.role, "system");
	assert.equal(deactUpdate.title, "Forge instruction update");
	assert.equal(deactUpdate.content, "");
	assert.equal(deactUpdate.sections?.["forge-instruction-act-1"], null, "Native removal is structural, not prose");

	const userMsg2 = result.preview.messages[4];
	assert.equal(userMsg2.role, "user");
	assert.equal(userMsg2.title, "Chat history #5");
	assert.equal(userMsg2.content, "Next question");
});

test("2. fallback on/off: renders attributed user update, no carrier prose leak", () => {
	const ev1 = makeActivateEvent("ev-1", "act-1", "Rule beta fallback");
	const entries = [
		makeEventEntry("entry-ev-1", ev1),
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Query", timestamp: 1100 },
		},
		makeCarrierEntry("carrier-1", "ev-1", 1200),
	];

	const ctx = makeContext({ entries, supportsMidConvoSystemMessages: false });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	assert.ok(!result.text.includes("Forge instruction state changed"));
	assert.equal(result.preview.messages.length, 2);

	const fallbackUpdate = result.preview.messages[1];
	assert.equal(fallbackUpdate.role, "user");
	assert.equal(fallbackUpdate.title, "Forge instruction update");
	assert.ok(fallbackUpdate.content.includes("[pi-forge instruction update]"));
	assert.ok(fallbackUpdate.content.includes("Rule beta fallback"));
});

test("3. leading compiled base is not duplicated between preview.system and preview.messages", () => {
	const entries = [
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Test message", timestamp: 1000 },
		},
	];

	const ctx = makeContext({ entries, systemPrompt: "Live Pi base prompt" });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	// preview.system has the compiled prompt
	assert.ok(result.preview.system.content.includes("Base system prompt from stack"));

	// preview.messages must NOT have a duplicate leading system message
	assert.equal(result.preview.messages.length, 1);
	assert.equal(result.preview.messages[0].role, "user");
	assert.equal(result.preview.messages[0].content, "Test message");

	// In text output, system prompt appears under ## System prompt, not duplicated under ## Message layout
	const parts = result.text.split("## Message layout");
	assert.equal(parts.length, 2);
	assert.ok(parts[0].includes("Base system prompt from stack"));
	assert.ok(!parts[1].includes("Base system prompt from stack"), "Message layout must not duplicate compiled base");
});

test("4. structured system sections and tool additions/removals are inspectable", () => {
	const entries = [
		{ type: "message", id: "initial-system", message: { role: "system", content: "Original Pi base", timestamp: 1000 } },
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Initial user query", timestamp: 1400 },
		},
		{
			type: "message",
			id: "sys-mid",
			message: {
				role: "system",
				content: "Mid conversation system directive",
				sections: {
					"custom-audit": "Audit policy body",
					"deprecated-policy": null,
				},
				toolsAdded: [
					{ name: "audit_tool", description: "Audit inspection tool" },
				],
				toolsRemoved: [
					{ name: "dangerous_exec" },
				],
				timestamp: 1500,
			} as unknown as AgentMessage,
		},
		{
			type: "message",
			id: "msg-2",
			message: { role: "user", content: "Execute command", timestamp: 1600 },
		},
	];

	const ctx = makeContext({ entries });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	const sysSection = result.preview.messages.find((m) => m.role === "system");
	assert.ok(sysSection, "Mid-convo system message must be in preview.messages");
	assert.ok(sysSection.content.includes("Mid conversation system directive"));
	assert.equal(sysSection.sections?.["custom-audit"], "Audit policy body");
	assert.equal(sysSection.sections?.["deprecated-policy"], null);
	assert.equal(sysSection.toolChanges?.added[0].name, "audit_tool");
	assert.deepEqual(sysSection.toolChanges?.removed, ["dangerous_exec"]);
	assert.doesNotMatch(sysSection.content, /audit_tool|dangerous_exec|Updated system|Removed system/);
});

test("5. foreign custom messages and foreign system content are preserved", () => {
	const entries = [
		{
			type: "custom_message",
			id: "custom-foreign",
			customType: "foreign-telemetry-extension",
			content: "Telemetry payload data",
			display: true,
			timestamp: 1100,
		},
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Hello", timestamp: 1200 },
		},
	];

	const ctx = makeContext({ entries });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	assert.equal(result.preview.messages.length, 2);
	const foreignCustom = result.preview.messages[0];
	assert.equal(foreignCustom.role, "custom");
	assert.equal(foreignCustom.content, "Telemetry payload data");
	assert.equal(foreignCustom.title, "Chat history #1");
});

test("6. compaction checkpoint with retained carriers and base SystemMessage restored", () => {
	const ev1 = makeActivateEvent("ev-1", "act-1", "Pre-compact rule");
	const ev2 = makeActivateEvent("ev-2", "act-2", "Post-compact rule", 2500);

	const entries = [
		makeEventEntry("entry-ev-1", ev1),
		{
			type: "message",
			id: "old-user-msg",
			message: { role: "user", content: "Old message", timestamp: 100 },
		},
		makeCarrierEntry("carrier-1", "ev-1", 150),
		{
			type: "compaction",
			id: "cmp-1",
			summary: "Compacted conversation summary",
			firstKeptEntryId: "carrier-1",
			tokensBefore: 12000,
			systemMessage: {
				role: "system",
				content: "Recorded compaction Pi base prompt",
				timestamp: 200,
			},
		},
		makeEventEntry("entry-ev-2", ev2),
		makeCarrierEntry("carrier-2", "ev-2", 2600),
		{
			type: "message",
			id: "msg-post",
			message: { role: "user", content: "Post compact prompt", timestamp: 2700 },
		},
	];

	const ctx = makeContext({ entries, supportsMidConvoSystemMessages: true });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	// 1. preview.system should have compiled using the compaction base prompt
	assert.ok(result.preview.system.content.includes("Base system prompt from stack"));

	// 2. Carrier prose must not leak
	assert.ok(!result.text.includes("Forge instruction state changed"));

	// 3. Compaction checkpoint message (for ev-1 / act-1) should appear after leading system,
	// and compactionSummary should appear, then post-compact delta (for ev-2 / act-2), then user message
	const msgTitles = result.preview.messages.map((m) => m.title);
	assert.ok(msgTitles.includes("Forge instruction update"));

	// Find the checkpoint update
	const checkpointUpdate = result.preview.messages.find(
		(m) => m.role === "system" && m.sections?.["forge-instruction-act-1"] !== undefined,
	);
	assert.ok(checkpointUpdate, "Checkpoint message for act-1 must be present in messages");
	assert.equal(checkpointUpdate.sections?.["forge-instruction-act-1"], "Pre-compact rule");

	// Compaction summary must be present
	const summaryMsg = result.preview.messages.find((m) => m.role === "compactionSummary");
	assert.ok(summaryMsg, "Compaction summary message must be present");
	assert.equal(summaryMsg.content, "Compacted conversation summary");

	// Post-compaction delta must be present
	const postDelta = result.preview.messages.find(
		(m) => m.role === "system" && m.sections?.["forge-instruction-act-2"] !== undefined,
	);
	assert.ok(postDelta, "Post-compaction delta for act-2 must be present in messages");
	assert.equal(postDelta.sections?.["forge-instruction-act-2"], "Post-compact rule");
});

test("7. missing carrier still projects pending instruction updates", () => {
	const ev1 = makeActivateEvent("ev-1", "act-1", "Rule from event with missing carrier");
	const entries = [
		makeEventEntry("entry-ev-1", ev1),
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Hello", timestamp: 1000 },
		},
	];

	const ctx = makeContext({ entries, supportsMidConvoSystemMessages: true });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	// Pending event delta must be projected at tail
	assert.equal(result.preview.messages.length, 2);
	const pendingUpdate = result.preview.messages[1];
	assert.equal(pendingUpdate.role, "system");
	assert.equal(pendingUpdate.title, "Forge instruction update");
	assert.equal(pendingUpdate.sections?.["forge-instruction-act-1"], "Rule from event with missing carrier");
});

test("8. malformed owned history or corrupt cursor visibly fails rather than leaking carrier", () => {
	// Carrier cursor points to nonexistent event
	const entries = [
		makeCarrierEntry("carrier-corrupt", "ev-nonexistent", 1000),
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Hello", timestamp: 1100 },
		},
	];

	const ctx = makeContext({ entries });
	const target = makeStack();

	assert.throws(
		() => buildPreview(ctx, target, defaultOptions),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.ok(
				err.message.includes("not found in branch events") ||
				err.message.includes("Invalid instruction") ||
				err.message.includes("Forge instruction"),
			);
			return true;
		},
	);
});

test("9. untrusted project fails closed for active modes, but succeeds when no active modes", () => {
	const ev1 = makeActivateEvent("ev-1", "act-1", "Untrusted active rule");
	const activeEntries = [
		makeEventEntry("entry-ev-1", ev1),
		makeCarrierEntry("carrier-1", "ev-1", 1200),
	];

	const ctxUntrustedActive = makeContext({ entries: activeEntries, trusted: false });
	const target = makeStack();

	// Active modes in untrusted project must fail closed
	assert.throws(
		() => buildPreview(ctxUntrustedActive, target, defaultOptions),
		/trusted project/i,
	);

	// Deactivated mode (0 active modes) in untrusted project should succeed
	const ev2 = makeDeactivateEvent("ev-2", "act-1", 2000);
	const inactiveEntries = [
		makeEventEntry("entry-ev-1", ev1),
		makeEventEntry("entry-ev-2", ev2),
		makeCarrierEntry("carrier-1", "ev-1", 1200),
		makeCarrierEntry("carrier-2", "ev-2", 2100),
	];

	const ctxUntrustedInactive = makeContext({ entries: inactiveEntries, trusted: false });
	const result = buildPreview(ctxUntrustedInactive, target, defaultOptions);
	assert.ok(result.preview);
});

test("10. evaluates literal content from session snapshot", () => {
	const ev1 = makeActivateEvent("ev-1", "act-1", "literal snapshot at turn 1");
	const entries = [
		makeEventEntry("entry-ev-1", ev1),
		makeCarrierEntry("carrier-1", "ev-1", 1200),
	];

	const ctx = makeContext({ entries, supportsMidConvoSystemMessages: true });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	assert.ok(result.text.includes("literal snapshot at turn 1"));
});

test("11. zero side effects: no persistence, no tool sync, no runtime mutation", () => {
	const appendCalls: unknown[] = [];
	const ev1 = makeActivateEvent("ev-1", "act-1", "Rule purity test");
	const entries = [
		makeEventEntry("entry-ev-1", ev1),
		makeCarrierEntry("carrier-1", "ev-1", 1200),
	];

	const ctx = makeContext({ entries, appendCalls });
	const target = makeStack();

	buildPreview(ctx, target, defaultOptions);
	renderPreview(ctx as any, target);

	assert.equal(appendCalls.length, 0, "Preview must never append session entries or mutate state");
});

test("12. existing callers without instruction events remain valid", () => {
	const entries = [
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Hello without events", timestamp: 1000 },
		},
		{
			type: "message",
			id: "msg-2",
			message: { role: "assistant", content: [{ type: "text", text: "Reply without events" }], timestamp: 1100 },
		},
	];

	const ctx = makeContext({ entries, systemPrompt: "Vanilla system prompt" });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	assert.equal(result.preview.stackId, "test-stack");
	assert.ok(result.preview.system.content.includes("Base system prompt from stack"));
	assert.equal(result.preview.messages.length, 2);
	assert.equal(result.preview.messages[0].title, "Chat history #1");
	assert.equal(result.preview.messages[0].content, "Hello without events");
	assert.equal(result.preview.messages[1].title, "Chat history #2");
	assert.equal(result.preview.messages[1].content, "Reply without events");
});

test("13. foreign system sections and toolsAdded on leading system message are inspectable in preview.system", () => {
	const entries = [
		{
			type: "message",
			id: "leading-sys",
			message: {
				role: "system",
				content: "Base system content",
				sections: {
					"foreign-section": "Foreign section body",
				},
				toolsAdded: [
					{ name: "custom_tool", description: "A custom tool" },
				],
				timestamp: 500,
			} as unknown as AgentMessage,
		},
		{
			type: "message",
			id: "msg-1",
			message: { role: "user", content: "Query", timestamp: 1000 },
		},
	];

	const ctx = makeContext({ entries });
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	// Foreign section and tool must be inspectable in preview.system
	assert.ok(result.preview.system.content.includes("Base system prompt from stack"));
	assert.equal(result.preview.system.sections?.["foreign-section"], "Foreign section body");
	assert.equal(result.preview.system.toolChanges?.added[0].name, "custom_tool");
	assert.doesNotMatch(result.preview.system.content, /custom_tool|Foreign section body/);

	// preview.messages must only contain the conversation turn, not duplicating the leading system prompt
	assert.equal(result.preview.messages.length, 1);
	assert.equal(result.preview.messages[0].role, "user");
	assert.equal(result.preview.messages[0].content, "Query");
});

test("parent: foreign mid-history System updates keep their provenance", () => {
 const entries = [
  {type: "message", id: "s0", message: {role: "system", content: "Pi base", timestamp: 0}},
  {type: "message", id: "u", message: {role: "user", content: "question", timestamp: 1}},
  {type: "message", id: "s1", message: {role: "system", content: "", sections: {foreign: "FOREIGN_BODY"}, timestamp: 2}},
 ];
 const result = buildPreview(makeContext({entries}), makeStack(), defaultOptions);
 const foreign = result.preview.messages.find(m => m.sections?.foreign === "FOREIGN_BODY")!;
 assert.ok(foreign);
 assert.notEqual(foreign.title, "Forge instruction update");
 assert.ok(!foreign.diffKey?.startsWith("forge-instruction-update:"));
});

test("parent: fallback carrier preceding first Pi System preserves projected message order", () => {
 const event = makeActivateEvent("ev-early", "act-early", "EARLY_RULE");
 const entries = [makeEventEntry("e", event), makeCarrierEntry("c", event.eventId),
  {type: "message", id: "s0", message: {role: "system", content: "STALE_PI_BASE", timestamp: 1600}},
  {type: "message", id: "u", message: {role: "user", content: "question", timestamp: 1700}},
 ];
 const result = buildPreview(makeContext({entries, supportsMidConvoSystemMessages: false}), makeStack(), defaultOptions);
 assert.equal(result.preview.messages[0].role, "user");
 assert.match(result.preview.messages[0].content, /EARLY_RULE/);
 assert.equal(result.preview.messages[1].role, "system");
 assert.match(result.preview.messages[1].content, /Base system prompt from stack/);
 assert.doesNotMatch(result.text, /STALE_PI_BASE/);
});

test("parent: preview copy text includes pending updates after long history", () => {
 const event = makeActivateEvent("ev-long", "act-long", "RULE_AFTER_LONG_HISTORY");
 const entries = [
  {type: "message", id: "u", message: {role: "user", content: "x".repeat(9000), timestamp: 1}},
  makeEventEntry("e", event),
 ];
 const result = buildPreview(makeContext({entries}), makeStack(), defaultOptions);
 assert.match(result.text, /RULE_AFTER_LONG_HISTORY/);
});

test("parent: minimal System prose excludes historical tool declarations; current preview tools are separate", () => {
 const entries = [{type:'message',id:'s',message:{role:'system',content:'Original',timestamp:1,toolsAdded:[{name:'write',description:'Historical writer',parameters:{type:'object'}}]}}];
 const target = makeStack();
 target.stack.items = [{kind:'block', id:'role', role:'system', content:'You are a helpful software engineer assistant.'}];
 const result = buildPreview(makeContext({entries}), target, {...defaultOptions, selectedTools:['read','grep']});
 assert.equal(result.preview.system.content, 'You are a helpful software engineer assistant.');
 assert.equal(result.preview.system.toolChanges?.added[0].name, 'write');
 assert.deepEqual(result.preview.selectedTools, ['read','grep']);
 assert.equal(result.preview.system.chars, result.preview.system.content.length);
 assert.doesNotMatch(result.text.split('## Message layout')[0], /Historical writer|Added tool/);
});

test("parent: native rule body and removal are structural, not synthesized prose; empty base refresh disappears", () => {
 const on = makeActivateEvent('on', 'active', 'NATIVE_LITERAL_BODY');
 const off = makeDeactivateEvent('off', 'active');
 const entries = [
  {type:'message',id:'s',message:{role:'system',content:'Original',timestamp:1}},
  {type:'message',id:'empty-refresh',message:{role:'system',content:'',sections:{tools:'old tool description',rules:'old base rules'},timestamp:2}},
  makeEventEntry('e1',on), makeCarrierEntry('m1',on.eventId),
  makeEventEntry('e2',off), makeCarrierEntry('m2',off.eventId),
  {type:'message',id:'user',message:{role:'user',content:'Added tool "read" is literal user text.',timestamp:9}},
 ];
 const result=buildPreview(makeContext({entries}),makeStack(),defaultOptions);
 assert.equal(result.preview.messages.length,3,'empty refresh only is omitted');
 assert.equal(result.preview.messages[0].content,'');
 assert.deepEqual(result.preview.messages[0].sections,{'forge-instruction-active':'NATIVE_LITERAL_BODY'});
 assert.deepEqual(result.preview.messages[1].sections,{'forge-instruction-active':null});
 assert.equal(result.preview.messages[1].chars,0);
 assert.equal(result.preview.messages[1].approxTokens,0);
 assert.equal(result.preview.messages[2].content,'Added tool "read" is literal user text.');
 assert.match(result.text,/NATIVE_LITERAL_BODY/);
 assert.match(result.text,/Removed system prompt section/,'removal remains in explicitly structural report, not body');
});

function userMsg(text: string, timestamp = 1000): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistantTextMsg(text: string, timestamp = 2000): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test-provider",
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
	};
}

test("Pi0.87 SessionManager context_edit: replacement reflects in preview while raw session history remains intact", () => {
	const sm = SessionManager.inMemory("/test");
	const m1 = sm.appendMessage(userMsg("Original user prompt before context edit", 1000));
	sm.appendMessage(assistantTextMsg("Assistant response", 1100));
	sm.appendContextEdit(m1, { content: "Canonically edited user prompt" });

	const ctx = makeRealContext(sm);
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	// Displayed preview messages reflect the canonical replacement
	assert.ok(
		result.preview.messages.some((m) => m.content === "Canonically edited user prompt"),
		"Preview messages must contain the context_edit replacement content",
	);
	assert.ok(
		!result.preview.messages.some((m) => m.content === "Original user prompt before context edit"),
		"Preview messages must not contain the original replaced content",
	);
	assert.ok(result.text.includes("Canonically edited user prompt"));
	assert.ok(!result.text.includes("Original user prompt before context edit"));

	// Context edit entry itself does not appear as an additional message
	assert.equal(result.preview.messages.length, 2);

	// Raw session history in SessionManager remains intact
	const rawEntries = sm.getEntries();
	const rawUserEntry = rawEntries.find((e) => e.id === m1);
	assert.ok(rawUserEntry && rawUserEntry.type === "message");
	assert.equal((rawUserEntry.message as { content: string }).content, "Original user prompt before context edit");
});

test("Pi0.87 SessionManager context_edit: omission removes message from preview while raw history is preserved", () => {
	const sm = SessionManager.inMemory("/test");
	const m1 = sm.appendMessage(userMsg("Omitted user message", 1000));
	sm.appendMessage(assistantTextMsg("Assistant response retained", 1100));
	sm.appendContextEdit(m1, null);

	const ctx = makeRealContext(sm);
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	assert.equal(result.preview.messages.length, 1);
	assert.equal(result.preview.messages[0].role, "assistant");
	assert.ok(!result.text.includes("Omitted user message"));

	// Raw history still has m1
	assert.ok(sm.getEntries().some((e) => e.id === m1));
});

test("Pi0.87 SessionManager compaction branch: latest compaction with retained range and plain metadata anchor", () => {
	const sm = SessionManager.inMemory("/test");
	const ev1 = makeActivateEvent("ev-1", "act-1", "Pre-compact rule alpha", 1000);
	sm.appendCustomEntry(INSTRUCTION_EVENT_ENTRY, ev1);
	sm.appendMessage(userMsg("Summarized old query", 1100));
	const anchor1 = sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, { schemaVersion: 1, throughEventId: "ev-1" });
	sm.appendMessage(assistantTextMsg("Old response", 1200));

	sm.appendCompaction("Compacted conversation summary", anchor1, 5000);

	const ev2 = makeActivateEvent("ev-2", "act-2", "Post-compact rule beta", 3000);
	sm.appendCustomEntry(INSTRUCTION_EVENT_ENTRY, ev2);
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, { schemaVersion: 1, throughEventId: "ev-2" });
	sm.appendMessage(userMsg("Post-compact active query", 3100));

	const ctx = makeRealContext(sm);
	const target = makeStack();
	const result = buildPreview(ctx, target, defaultOptions);

	// Pre-compact anchor is projected as checkpoint update
	const checkpoint = result.preview.messages.find(
		(m) => m.role === "system" && m.sections?.["forge-instruction-act-1"] === "Pre-compact rule alpha",
	);
	assert.ok(checkpoint, "Pre-compact checkpoint update must be present");

	// Compaction summary message is present
	const summaryMsg = result.preview.messages.find((m) => m.role === "compactionSummary");
	assert.ok(summaryMsg, "Compaction summary message must be present");

	// Summarized old query is not present in preview messages
	assert.ok(!result.text.includes("Summarized old query"));

	// Post-compact delta is present
	const postDelta = result.preview.messages.find(
		(m) => m.role === "system" && m.sections?.["forge-instruction-act-2"] === "Post-compact rule beta",
	);
	assert.ok(postDelta, "Post-compact delta update must be present");

	// Raw history still has the summarized query
	assert.ok(sm.getEntries().some((e) => e.type === "message" && (e.message as { content?: unknown }).content === "Summarized old query"));
});

test("Pi0.87 SessionManager branch isolation: preview projects only the active leaf branch", () => {
	const sm = SessionManager.inMemory("/test");
	sm.appendMessage(userMsg("Root user query", 1000));
	const rootId = sm.getLeafId()!;

	// Build Branch A
	const evA = makeActivateEvent("ev-a", "act-a", "Branch A exclusive rule", 1100);
	sm.appendCustomEntry(INSTRUCTION_EVENT_ENTRY, evA);
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, { schemaVersion: 1, throughEventId: "ev-a" });
	sm.appendMessage(userMsg("Branch A prompt text", 1200));
	const leafA = sm.getLeafId()!;

	// Fork Branch B from root
	sm.branch(rootId);
	const evB = makeActivateEvent("ev-b", "act-b", "Branch B exclusive rule", 1300);
	sm.appendCustomEntry(INSTRUCTION_EVENT_ENTRY, evB);
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, { schemaVersion: 1, throughEventId: "ev-b" });
	sm.appendMessage(userMsg("Branch B prompt text", 1400));
	const leafB = sm.getLeafId()!;

	const target = makeStack();

	// Preview on Branch A
	sm.branch(leafA);
	const ctxA = makeRealContext(sm);
	const resultA = buildPreview(ctxA, target, defaultOptions);
	assert.ok(resultA.text.includes("Branch A exclusive rule"));
	assert.ok(resultA.text.includes("Branch A prompt text"));
	assert.ok(!resultA.text.includes("Branch B exclusive rule"));
	assert.ok(!resultA.text.includes("Branch B prompt text"));

	// Preview on Branch B
	sm.branch(leafB);
	const ctxB = makeRealContext(sm);
	const resultB = buildPreview(ctxB, target, defaultOptions);
	assert.ok(resultB.text.includes("Branch B exclusive rule"));
	assert.ok(resultB.text.includes("Branch B prompt text"));
	assert.ok(!resultB.text.includes("Branch A exclusive rule"));
	assert.ok(!resultB.text.includes("Branch A prompt text"));
});

test("Pi0.87 SessionManager read-only purity: preview does not mutate SessionManager entries or leaf", () => {
	const sm = SessionManager.inMemory("/test");
	sm.appendMessage(userMsg("Purity query", 1000));
	const ev = makeActivateEvent("ev-p", "act-p", "Purity rule", 1100);
	sm.appendCustomEntry(INSTRUCTION_EVENT_ENTRY, ev);
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, { schemaVersion: 1, throughEventId: "ev-p" });
	sm.appendMessage(assistantTextMsg("Purity answer", 1200));

	const beforeEntries = JSON.stringify(sm.getEntries());
	const beforeLeaf = sm.getLeafId();
	const appendCalls: unknown[] = [];

	const ctx = makeRealContext(sm, { appendCalls });
	const target = makeStack();

	buildPreview(ctx, target, defaultOptions);
	renderPreview(ctx as any, target);

	assert.equal(JSON.stringify(sm.getEntries()), beforeEntries);
	assert.equal(sm.getLeafId(), beforeLeaf);
	assert.equal(appendCalls.length, 0);
});
