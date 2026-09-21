import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
	SessionManager,
	buildSessionContext,
	buildSessionProjection,
} from "@earendil-works/pi-coding-agent";
import {
	hasPendingInstructionToolCalls,
	instructionAnchorMessage,
	instructionContextMatches,
	isInstructionAnchorEntry,
	materializeInstructionAnchors,
	validateInstructionAnchorData,
} from "../src/instruction-anchors.ts";
import {
	createInstructionSnapshot,
	type InstructionEvent,
} from "../src/instruction-events.ts";
import { projectInstructionMessages } from "../src/instruction-projection.ts";
import {
	INSTRUCTION_DELIVERY_TYPE,
	isInstructionDelivery,
	type InstructionHistory,
} from "../src/instruction-protocol.ts";

function textOf(msg: AgentMessage): string {
	const content = (msg as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: "text"; text: string } => Boolean(b && typeof b === "object" && (b as { type?: unknown }).type === "text"))
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

function dummyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMsg(text: string, timestamp = 1000): AgentMessage {
	return { role: "user", content: text, timestamp } as AgentMessage;
}

function assistantTextMsg(text: string, timestamp = 2000): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test" as const,
		provider: "test",
		model: "test-model",
		usage: dummyUsage(),
		stopReason: "stop",
		timestamp,
	};
}

function assistantToolCallMsg(calls: { id: string; name: string }[], timestamp = 2000): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({
			type: "toolCall" as const,
			id: c.id,
			name: c.name,
			arguments: {},
		})),
		api: "test" as const,
		provider: "test",
		model: "test-model",
		usage: dummyUsage(),
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResultMsg(toolCallId: string, text = "result", isError = false, timestamp = 3000): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "test_tool",
		content: [{ type: "text", text }],
		isError,
		timestamp,
	} as ToolResultMessage;
}

function customPeerMsg(customType: string, text: string, timestamp = 2500): AgentMessage {
	return {
		role: "custom",
		customType,
		content: text,
		display: false,
		timestamp,
	} as AgentMessage;
}

test("validateInstructionAnchorData accepts valid schema 1 metadata and rejects bad data", () => {
	// Valid metadata
	const valid = validateInstructionAnchorData({
		schemaVersion: 1,
		throughEventId: "ev-valid-uuid-1234",
	});
	assert.deepEqual(valid, {
		schemaVersion: 1,
		throughEventId: "ev-valid-uuid-1234",
	});

	// Boundary: max length 128
	const maxCursor = "a".repeat(128);
	const validMax = validateInstructionAnchorData({
		schemaVersion: 1,
		throughEventId: maxCursor,
	});
	assert.equal(validMax.throughEventId.length, 128);

	// Reject extra fields
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "ev-1", extraField: "forbidden" }),
		/unexpected extra field "extraField"/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "ev-1", extra: 123 }),
		/unexpected extra field "extra"/,
	);

	// Reject wrong schemaVersion
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 2, throughEventId: "ev-1" }),
		/unsupported schemaVersion 2, expected 1/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: "1", throughEventId: "ev-1" }),
		/unsupported schemaVersion 1, expected 1/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ throughEventId: "ev-1" }),
		/missing required field schemaVersion/,
	);

	// Reject bad cursor
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1 }),
		/missing required field throughEventId/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "" }),
		/throughEventId must be a non-empty string/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: 123 }),
		/throughEventId must be a non-empty string/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "b".repeat(129) }),
		/throughEventId length exceeds 128 characters \(129\)/,
	);

	// Reject control characters in cursor
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "ev-1\n" }),
		/throughEventId contains control characters/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "ev-1\tbar" }),
		/throughEventId contains control characters/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "ev-1\0null" }),
		/throughEventId contains control characters/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "ev-1\x7fdel" }),
		/throughEventId contains control characters/,
	);
	assert.throws(
		() => validateInstructionAnchorData({ schemaVersion: 1, throughEventId: "ev-1\x1desc" }),
		/throughEventId contains control characters/,
	);

	// Reject non-objects
	assert.throws(() => validateInstructionAnchorData(null), /data must be a non-null object/);
	assert.throws(() => validateInstructionAnchorData(undefined), /data must be a non-null object/);
	assert.throws(() => validateInstructionAnchorData("string"), /data must be a non-null object/);
	assert.throws(() => validateInstructionAnchorData([1]), /data must be a non-null object/);
});

test("isInstructionAnchorEntry accurately identifies plain custom anchor entries", () => {
	assert.equal(
		isInstructionAnchorEntry({
			type: "custom",
			customType: INSTRUCTION_DELIVERY_TYPE,
			data: { schemaVersion: 1, throughEventId: "ev-1" },
		}),
		true,
	);
	// Different customType
	assert.equal(
		isInstructionAnchorEntry({
			type: "custom",
			customType: "some-other-plugin",
			data: { schemaVersion: 1 },
		}),
		false,
	);
	// Legacy custom_message is not a plain custom anchor entry
	assert.equal(
		isInstructionAnchorEntry({
			type: "custom_message",
			customType: INSTRUCTION_DELIVERY_TYPE,
			content: "carrier prose",
		}),
		false,
	);
	// Message entry
	assert.equal(
		isInstructionAnchorEntry({
			type: "message",
			message: { role: "user", content: "hi" },
		}),
		false,
	);
	assert.equal(isInstructionAnchorEntry(null), false);
	assert.equal(isInstructionAnchorEntry(undefined), false);
});

test("instructionAnchorMessage creates ephemeral custom control message and validates metadata", () => {
	const validEntry = {
		type: "custom",
		customType: INSTRUCTION_DELIVERY_TYPE,
		data: { schemaVersion: 1, throughEventId: "ev-42" },
		timestamp: "2026-09-21T00:00:00.000Z",
	};

	const message = instructionAnchorMessage(validEntry);
	assert.ok(message);
	assert.equal(message.role, "custom");
	assert.equal((message as { customType?: unknown }).customType, INSTRUCTION_DELIVERY_TYPE);
	assert.deepEqual((message as { content?: unknown }).content, []);
	assert.equal((message as { display?: boolean }).display, false);
	assert.deepEqual((message as { details?: unknown }).details, {
		schemaVersion: 1,
		throughEventId: "ev-42",
	});
	assert.equal(message.timestamp, Date.parse("2026-09-21T00:00:00.000Z"));

	// Non-anchor entries return undefined
	assert.equal(
		instructionAnchorMessage({ type: "message", message: { role: "user", content: "hi" } }),
		undefined,
	);
	assert.equal(
		instructionAnchorMessage({ type: "custom", customType: "other" }),
		undefined,
	);
	assert.equal(
		instructionAnchorMessage({ type: "custom_message", customType: INSTRUCTION_DELIVERY_TYPE }),
		undefined,
	);
	assert.equal(instructionAnchorMessage(null), undefined);

	// Malformed anchor metadata throws
	assert.throws(
		() => instructionAnchorMessage({
			type: "custom",
			customType: INSTRUCTION_DELIVERY_TYPE,
			data: { schemaVersion: 2, throughEventId: "ev-42" },
		}),
		/unsupported schemaVersion 2/,
	);
	assert.throws(
		() => instructionAnchorMessage({
			type: "custom",
			customType: INSTRUCTION_DELIVERY_TYPE,
			data: { schemaVersion: 1, throughEventId: "ev-42", badExtra: true },
		}),
		/unexpected extra field "badExtra"/,
	);
});

test("materializeInstructionAnchors with real SessionManager.inMemory places control message by ordinal", () => {
	const sm = SessionManager.inMemory("/test/path");
	sm.appendMessage({ role: "user", content: "FIRST_PROMPT", timestamp: 1000 });
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-step-1",
	});
	sm.appendMessage(assistantTextMsg("FIRST_RESPONSE", 2000));

	const branch = sm.getBranch();
	const rawMessages = buildSessionContext(branch).messages;
	assert.equal(rawMessages.length, 2, "SessionManager excludes plain custom entry from context");

	const materialized = materializeInstructionAnchors(branch, rawMessages);
	assert.equal(materialized.length, 3);
	assert.equal(textOf(materialized[0]), "FIRST_PROMPT");
	assert.equal(materialized[1].role, "custom");
	assert.equal(isInstructionDelivery(materialized[1]), true);
	assert.deepEqual((materialized[1] as { details?: unknown }).details, {
		schemaVersion: 1,
		throughEventId: "ev-step-1",
	});
	assert.equal(textOf(materialized[2]), "FIRST_RESPONSE");
});

test("materializeInstructionAnchors preserves input message references from deep-cloned context", () => {
	const sm = SessionManager.inMemory("/test/refs");
	sm.appendMessage({ role: "user", content: "PROMPT_1", timestamp: 100 });
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-ref",
	});
	sm.appendMessage(assistantTextMsg("RESPONSE_1", 200));

	const branch = sm.getBranch();
	const rawMessages = buildSessionContext(branch).messages;
	// Deep clone the array so incoming objects are distinct references
	const inputCloned: AgentMessage[] = structuredClone(rawMessages);

	const materialized = materializeInstructionAnchors(branch, inputCloned);
	assert.equal(materialized.length, 3);

	// Original references from inputCloned MUST be strictly retained
	assert.strictEqual(materialized[0], inputCloned[0], "First message reference preserved");
	assert.strictEqual(materialized[2], inputCloned[1], "Second message reference preserved");
});

test("materializeInstructionAnchors preserves ordinal placement with identical text and timestamps", () => {
	const sm = SessionManager.inMemory("/test/duplicate");
	const duplicateUser = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "IDENTICAL_CONTENT" }],
		timestamp: 12345,
	};
	sm.appendMessage(duplicateUser);
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-middle",
	});
	sm.appendMessage(structuredClone(duplicateUser));

	const branch = sm.getBranch();
	const rawMessages = buildSessionContext(branch).messages;
	assert.deepEqual(rawMessages[0], rawMessages[1], "Context messages are identical in value");

	const materialized = materializeInstructionAnchors(branch, rawMessages);
	assert.equal(materialized.length, 3);
	assert.equal(textOf(materialized[0]), "IDENTICAL_CONTENT");
	assert.equal(materialized[1].role, "custom");
	assert.equal(isInstructionDelivery(materialized[1]), true);
	assert.equal(textOf(materialized[2]), "IDENTICAL_CONTENT");
});

test("materializeInstructionAnchors rejects foreign modifications: insertion, deletion, and same-length rewrite", () => {
	const sm = SessionManager.inMemory("/test/foreign");
	sm.appendMessage({ role: "user", content: "ORIGINAL_1", timestamp: 10 });
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-foreign-test",
	});
	sm.appendMessage(assistantTextMsg("ORIGINAL_2", 20));

	const branch = sm.getBranch();
	const rawMessages = buildSessionContext(branch).messages;

	// 1. Foreign message insertion
	const foreignInserted = [
		...rawMessages,
		{ role: "user", content: "UNAUTHORIZED_INJECTION", timestamp: 30 } as AgentMessage,
	];
	assert.throws(
		() => materializeInstructionAnchors(branch, foreignInserted),
		/no unique session alignment/,
	);

	// 2. Foreign deletion / trimming
	const foreignTrimmed = rawMessages.slice(1);
	assert.throws(
		() => materializeInstructionAnchors(branch, foreignTrimmed),
		/no unique session alignment/,
	);

	// 3. Same-length text rewrite (e.g. content modified with same character length)
	const sameLengthRewritten = structuredClone(rawMessages);
	(sameLengthRewritten[0] as { content: unknown }).content = "MODIFIED_1"; // same 10 chars as ORIGINAL_1
	assert.throws(
		() => materializeInstructionAnchors(branch, sameLengthRewritten),
		/no unique session alignment/,
	);

	// 4. Role rewrite
	const roleRewritten = structuredClone(rawMessages);
	(roleRewritten[0] as { role: string }).role = "system";
	assert.throws(
		() => materializeInstructionAnchors(branch, roleRewritten),
		/no unique session alignment/,
	);
});

test("no visible anchor returns original array reference and does not fail on foreign rewrites", () => {
	const sm = SessionManager.inMemory("/test/no-anchor");
	sm.appendMessage({ role: "user", content: "HELLO", timestamp: 1 });
	sm.appendMessage(assistantTextMsg("WORLD", 2));

	const branch = sm.getBranch();
	const rawMessages = buildSessionContext(branch).messages;

	// Without anchor, unmodified messages returned by reference
	const result = materializeInstructionAnchors(branch, rawMessages);
	assert.strictEqual(result, rawMessages);

	// Even if a foreign extension modified or rewrote messages, it does NOT throw when no anchor is present
	const modifiedMessages: AgentMessage[] = [
		...rawMessages,
		{ role: "user", content: "FOREIGN_PLUGIN_PROMPT", timestamp: 3 } as AgentMessage,
	];
	const modifiedResult = materializeInstructionAnchors(branch, modifiedMessages);
	assert.strictEqual(modifiedResult, modifiedMessages, "Returns modified array untouched without failing");

	// Empty entries returns messages directly
	const emptyResult = materializeInstructionAnchors([], rawMessages);
	assert.strictEqual(emptyResult, rawMessages);
});

test("compaction preserves retained tail anchors and prunes older anchors", () => {
	const sm = SessionManager.inMemory("/test/compaction");
	sm.appendMessage({ role: "user", content: "PRUNED_USER", timestamp: 1 });
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-pruned",
	});
	const keptMsgId = sm.appendMessage(assistantTextMsg("KEPT_ASSISTANT", 2));
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-retained",
	});
	sm.appendMessage({ role: "user", content: "RETAINED_USER", timestamp: 3 });

	// Compact keeping from keptMsgId onwards
	sm.appendCompaction("Compacted conversation facts", keptMsgId, 150);
	sm.appendMessage(assistantTextMsg("POST_COMPACT_REPLY", 4));

	const branch = sm.getBranch();
	const projection = buildSessionProjection(branch);
	const rawMessages = projection.messages;
	assert.equal(projection.entries[0]?.sourceEntry.type, "compaction");

	// In rawMessages:
	// 0: compaction summary
	// 1: KEPT_ASSISTANT
	// 2: RETAINED_USER
	// 3: POST_COMPACT_REPLY
	assert.equal(rawMessages.length, 4);
	assert.equal(rawMessages[0].role, "compactionSummary");

	const materialized = materializeInstructionAnchors(branch, rawMessages);
	// Materialized should contain:
	// 0: compactionSummary (from rawMessages[0])
	// 1: KEPT_ASSISTANT (from rawMessages[1])
	// 2: custom control marker for ev-retained
	// 3: RETAINED_USER (from rawMessages[2])
	// 4: POST_COMPACT_REPLY (from rawMessages[3])
	assert.equal(materialized.length, 5);
	assert.strictEqual(materialized[0], rawMessages[0]);
	assert.strictEqual(materialized[1], rawMessages[1]);
	assert.equal(materialized[2].role, "custom");
	assert.equal(isInstructionDelivery(materialized[2]), true);
	assert.deepEqual((materialized[2] as { details?: unknown }).details, {
		schemaVersion: 1,
		throughEventId: "ev-retained",
	});
	assert.strictEqual(materialized[3], rawMessages[2]);
	assert.strictEqual(materialized[4], rawMessages[3]);

	// Old anchor ev-pruned must NOT be in materialized messages
	assert.ok(
		!materialized.some(
			(m) => (m as { details?: { throughEventId?: string } }).details?.throughEventId === "ev-pruned",
		),
	);
});

test("compaction where all anchors were before cut point returns messages untouched and ignores foreign edits", () => {
	const sm = SessionManager.inMemory("/test/compaction-pruned");
	sm.appendMessage({ role: "user", content: "OLD_USER", timestamp: 1 });
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-old-pruned",
	});
	const keptId = sm.appendMessage(assistantTextMsg("START_KEPT", 2));
	sm.appendCompaction("Summary of old turn", keptId, 100);

	const branch = sm.getBranch();
	const projection = buildSessionProjection(branch);
	const rawMessages = projection.messages;

	// Since the only anchor was pruned before compaction, no visible anchor remains
	const foreignRewritten = [
		...rawMessages,
		{ role: "user", content: "EXTRA_FOREIGN", timestamp: 99 } as AgentMessage,
	];
	const result = materializeInstructionAnchors(branch, foreignRewritten);
	assert.strictEqual(result, foreignRewritten, "No visible anchor -> untouched return");
});

test("materialized anchors integrate seamlessly with existing projectInstructionMessages (native and fallback)", () => {
	const sm = SessionManager.inMemory("/test/projector");
	sm.appendMessage({ role: "user", content: "PROMPT_ONE", timestamp: 100 });
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-act",
	});
	sm.appendMessage(assistantTextMsg("RESPONSE_ONE", 200));
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-deact",
	});
	sm.appendMessage({ role: "user", content: "PROMPT_TWO", timestamp: 300 });

	const branch = sm.getBranch();
	const rawMessages = buildSessionContext(branch).messages;
	const materialized = materializeInstructionAnchors(branch, rawMessages);

	const ev1: InstructionEvent = {
		schemaVersion: 1,
		eventId: "ev-act",
		op: "activate",
		actor: "user",
		createdAt: 150,
		snapshot: createInstructionSnapshot({
			activationId: "act-test",
			source: { kind: "manual" },
			content: "RULE_FOR_PROJECTION",
			tools: { add: [], remove: [] },
		}),
	};

	const ev2: InstructionEvent = {
		schemaVersion: 1,
		eventId: "ev-deact",
		op: "deactivate",
		actor: "user",
		createdAt: 250,
		activationId: "act-test",
	};

	const history: InstructionHistory = {
		events: [ev1, ev2],
	};

	// Test native mode projection
	const nativeResult = projectInstructionMessages(materialized, history, true);
	// Must consume all temporary control markers
	assert.ok(
		!nativeResult.messages.some(isInstructionDelivery),
		"All delivery markers consumed in native projection",
	);
	// ev-act projected as SystemMessage with sections
	const sysUpdate = nativeResult.messages.find(
		(m) => m.role === "system" && (m as { sections?: Record<string, string | null> }).sections?.["forge-instruction-act-test"] === "RULE_FOR_PROJECTION",
	);
	assert.ok(sysUpdate, "Native section update present");

	// ev-deact projected as null section
	const sysDeact = nativeResult.messages.find(
		(m) => m.role === "system" && (m as { sections?: Record<string, string | null> }).sections?.["forge-instruction-act-test"] === null,
	);
	assert.ok(sysDeact, "Native null deactivation section present");

	// Test fallback mode projection
	const fallbackResult = projectInstructionMessages(materialized, history, false);
	assert.ok(
		!fallbackResult.messages.some(isInstructionDelivery),
		"All delivery markers consumed in fallback projection",
	);
	const fallbackUpdate = fallbackResult.messages.find(
		(m) => m.role === "user" && textOf(m).includes("[pi-forge instruction update]") && textOf(m).includes("RULE_FOR_PROJECTION"),
	);
	assert.ok(fallbackUpdate, "Fallback user update present");
});

test("projectInstructionMessages suppresses older precheckpoint anchors in retained compaction tail", () => {
	const sm = SessionManager.inMemory("/test/precheckpoint");
	sm.appendMessage({ role: "user", content: "OLD_USER", timestamp: 10 });
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-pre",
	});
	const keptId = sm.appendMessage(assistantTextMsg("RETAINED_REPLY", 20));
	// Compaction through ev-pre
	sm.appendCompaction("Compacted past facts", keptId, 100);
	sm.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-post",
	});
	sm.appendMessage({ role: "user", content: "NEW_USER", timestamp: 30 });

	const branch = sm.getBranch();
	const rawMessages = buildSessionContext(branch).messages;
	const materialized = materializeInstructionAnchors(branch, rawMessages);

	const evPre: InstructionEvent = {
		schemaVersion: 1,
		eventId: "ev-pre",
		op: "activate",
		actor: "user",
		createdAt: 15,
		snapshot: createInstructionSnapshot({
			activationId: "act-pre",
			source: { kind: "manual" },
			content: "PRE_CHECKPOINT_RULE",
			tools: { add: [], remove: [] },
		}),
	};

	const evPost: InstructionEvent = {
		schemaVersion: 1,
		eventId: "ev-post",
		op: "activate",
		actor: "user",
		createdAt: 25,
		snapshot: createInstructionSnapshot({
			activationId: "act-post",
			source: { kind: "manual" },
			content: "POST_CHECKPOINT_RULE",
			tools: { add: [], remove: [] },
		}),
	};

	const history: InstructionHistory = {
		events: [evPre, evPost],
		checkpointThrough: "ev-pre",
	};

	const projection = projectInstructionMessages(materialized, history, true);
	// Markers consumed
	assert.ok(!projection.messages.some(isInstructionDelivery));

	// The checkpoint establishes act-pre state at the head
	const checkpointMsg = projection.messages.find(
		(m) => m.role === "system" && (m as { sections?: Record<string, string | null> }).sections?.["forge-instruction-act-pre"] === "PRE_CHECKPOINT_RULE",
	);
	assert.ok(checkpointMsg, "Checkpoint system message reconstructed");

	// ev-post delta is rendered at its position
	const postMsg = projection.messages.find(
		(m) => m.role === "system" && (m as { sections?: Record<string, string | null> }).sections?.["forge-instruction-act-post"] === "POST_CHECKPOINT_RULE",
	);
	assert.ok(postMsg, "Post checkpoint delta rendered");
});

test("canonical projection applies user, assistant, tool, and custom context edits before anchor materialization", () => {
	const manager = SessionManager.inMemory("/test/canonical-projection");
	const omittedUserId = manager.appendMessage({ role: "user", content: "OMITTED_USER", timestamp: 1 });
	manager.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-before-edits",
	});
	const assistantId = manager.appendMessage(assistantToolCallMsg([{ id: "call-1", name: "tool" }], 2));
	const toolResultId = manager.appendMessage(toolResultMsg("call-1", "ORIGINAL_TOOL", false, 3));
	const customId = manager.appendCustomMessageEntry("peer", "ORIGINAL_CUSTOM", false);
	manager.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-after-edits",
	});
	const replacedUserId = manager.appendMessage({ role: "user", content: "ORIGINAL_USER", timestamp: 4 });

	manager.appendContextEdit(omittedUserId, null);
	manager.appendContextEdit(assistantId, { content: "REPLACED_ASSISTANT" });
	manager.appendContextEdit(toolResultId, { content: "REPLACED_TOOL" });
	manager.appendContextEdit(customId, { content: "REPLACED_CUSTOM" });
	manager.appendContextEdit(replacedUserId, { content: "REPLACED_USER" });

	const branch = manager.getBranch();
	const projection = buildSessionProjection(branch);
	assert.deepEqual(
		projection.entries.map((entry) => entry.sourceEntry.id),
		branch.map((entry) => entry.id),
		"Projection retains source-entry provenance, including context edits",
	);
	assert.deepEqual(
		projection.messages.map((message) => `${message.role}:${textOf(message)}`),
		[
			"assistant:REPLACED_ASSISTANT",
			"toolResult:REPLACED_TOOL",
			"custom:REPLACED_CUSTOM",
			"user:REPLACED_USER",
		],
	);

	const incoming = structuredClone(projection.messages);
	const materialized = materializeInstructionAnchors(branch, incoming);
	assert.equal(materialized.length, 6);
	assert.equal(isInstructionDelivery(materialized[0]), true);
	assert.equal((materialized[0] as { details?: { throughEventId?: string } }).details?.throughEventId, "ev-before-edits");
	assert.strictEqual(materialized[1], incoming[0]);
	assert.strictEqual(materialized[2], incoming[1]);
	assert.strictEqual(materialized[3], incoming[2]);
	assert.equal(isInstructionDelivery(materialized[4]), true);
	assert.equal((materialized[4] as { details?: { throughEventId?: string } }).details?.throughEventId, "ev-after-edits");
	assert.strictEqual(materialized[5], incoming[3]);
});

test("canonical context edits remain isolated to their active branch", () => {
	const manager = SessionManager.inMemory("/test/branch-edit-isolation");
	const userId = manager.appendMessage({ role: "user", content: "BASE_USER", timestamp: 1 });
	manager.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {
		schemaVersion: 1,
		throughEventId: "ev-branch",
	});
	const assistantId = manager.appendMessage(assistantTextMsg("BASE_ASSISTANT", 2));

	manager.branch(assistantId);
	const editId = manager.appendContextEdit(userId, null);
	const editedBranch = manager.getBranch();
	const editedProjection = buildSessionProjection(editedBranch);
	assert.ok(editedProjection.entries.some((entry) => entry.sourceEntry.id === editId));
	assert.equal(editedProjection.messages.some((message) => textOf(message) === "BASE_USER"), false);
	const editedMaterialized = materializeInstructionAnchors(editedBranch, structuredClone(editedProjection.messages));
	assert.equal(isInstructionDelivery(editedMaterialized[0]), true);
	assert.equal(textOf(editedMaterialized[1]), "BASE_ASSISTANT");

	manager.branch(assistantId);
	const siblingBranch = manager.getBranch();
	const siblingProjection = buildSessionProjection(siblingBranch);
	assert.equal(siblingProjection.entries.some((entry) => entry.sourceEntry.id === editId), false);
	assert.deepEqual(siblingProjection.messages.map(textOf), ["BASE_USER", "BASE_ASSISTANT"]);
	const siblingIncoming = structuredClone(siblingProjection.messages);
	const siblingMaterialized = materializeInstructionAnchors(siblingBranch, siblingIncoming);
	assert.equal(textOf(siblingMaterialized[0]), "BASE_USER");
	assert.equal(isInstructionDelivery(siblingMaterialized[1]), true);
	assert.strictEqual(siblingMaterialized[0], siblingIncoming[0]);
	assert.strictEqual(siblingMaterialized[2], siblingIncoming[1]);
});

test("hasPendingInstructionToolCalls tracks tool batches, multi-call partials, and turn boundaries", () => {
	// Empty or non-tool dialogue
	assert.equal(hasPendingInstructionToolCalls([]), false);
	assert.equal(
		hasPendingInstructionToolCalls([
			userMsg("hi"),
			assistantTextMsg("hello"),
		]),
		false,
	);

	// Single tool call in progress
	assert.equal(
		hasPendingInstructionToolCalls([
			userMsg("search something"),
			assistantToolCallMsg([{ id: "call-1", name: "search" }]),
		]),
		true,
	);

	// Tool call completed
	assert.equal(
		hasPendingInstructionToolCalls([
			userMsg("search something"),
			assistantToolCallMsg([{ id: "call-1", name: "search" }]),
			toolResultMsg("call-1", "search result"),
		]),
		false,
	);

	// Multi-tool batch: 2 calls, only 1 result returned
	assert.equal(
		hasPendingInstructionToolCalls([
			userMsg("run two tools"),
			assistantToolCallMsg([
				{ id: "call-a", name: "toolA" },
				{ id: "call-b", name: "toolB" },
			]),
			toolResultMsg("call-a", "result A"),
		]),
		true,
		"In-flight batch with partial result has pending tool calls",
	);

	// Multi-tool batch: both results returned
	assert.equal(
		hasPendingInstructionToolCalls([
			userMsg("run two tools"),
			assistantToolCallMsg([
				{ id: "call-a", name: "toolA" },
				{ id: "call-b", name: "toolB" },
			]),
			toolResultMsg("call-a", "result A"),
			toolResultMsg("call-b", "result B"),
		]),
		false,
		"Completed batch has no pending tool calls",
	);

	// Tool error result still resolves the tool call
	assert.equal(
		hasPendingInstructionToolCalls([
			userMsg("run tool"),
			assistantToolCallMsg([{ id: "call-err", name: "failing_tool" }]),
			toolResultMsg("call-err", "tool crashed", true),
		]),
		false,
		"Error result completes the tool call",
	);
});

test("hasPendingInstructionToolCalls clears historical orphans on genuine user message, but custom peer does not clear", () => {
	// Historical orphan from an interrupted turn, followed by a genuine user prompt
	const messagesWithHistoricalOrphan = [
		userMsg("OLD_INTERRUPTED_USER", 100),
		assistantToolCallMsg([{ id: "historical_orphan_call", name: "read_file" }], 200),
		// No toolResult arrived (interruption / crash)
		// Next genuine user turn starts
		userMsg("NEW_RECOVERY_USER", 300),
		assistantTextMsg("REPLY_TO_NEW_USER", 400),
	];

	assert.equal(
		hasPendingInstructionToolCalls(messagesWithHistoricalOrphan),
		false,
		"Genuine user message clears historical orphan from earlier interrupted turn",
	);

	// Historical orphan followed by a custom peer message (NOT a real user prompt)
	const messagesWithPeerInsteadOfUser = [
		userMsg("OLD_USER", 100),
		assistantToolCallMsg([{ id: "orphan_call_2", name: "edit_file" }], 200),
		// Custom peer notification
		customPeerMsg("some-peer-extension", "notification prose", 250),
	];

	assert.equal(
		hasPendingInstructionToolCalls(messagesWithPeerInsteadOfUser),
		true,
		"Custom peer message does NOT clear pending tool call; boundary remains guarded",
	);
});


test("queued custom omission requires a unique ordered alignment and preserves caller references", () => {
	const manager = SessionManager.inMemory("/test/queued-custom");
	manager.appendCustomMessageEntry("peer", "A", false);
	manager.appendCustomEntry(INSTRUCTION_DELIVERY_TYPE, {schemaVersion: 1, throughEventId: "event"});
	manager.appendCustomMessageEntry("peer", "B", false);
	manager.appendMessage({role: "user", content: "NEXT", timestamp: 3});
	const full = buildSessionContext(manager.getBranch()).messages;
	const live = structuredClone(full.slice(1));
	live[0].timestamp = 1; // SDK queue creation and persistence clocks differ.
	const projected = materializeInstructionAnchors(manager.getBranch(), live);
	assert.equal(projected.length, 3);
	assert.ok(isInstructionDelivery(projected[0]));
	assert.equal(projected[1], live[0]);
	assert.equal(projected[2], live[1]);
	const ambiguous = [full[0], structuredClone(full[0])];
	assert.equal(instructionContextMatches(ambiguous, [full[0]]), false);
	assert.equal(instructionContextMatches(ambiguous, structuredClone(ambiguous)), true);
	assert.equal(instructionContextMatches([full[2]], []), false, "non-custom omissions are not allowed");
});

test("custom-run alignment agrees with exhaustive uniqueness enumeration", () => {
	const sequences: string[][] = [[]];
	for (let size = 1; size <= 5; size++) for (let bits = 0; bits < (1 << size); bits++) {
		sequences.push(Array.from({length: size}, (_, index) => (bits >> index) & 1 ? "A" : "B"));
	}
	const messages = (sequence: string[]): AgentMessage[] => sequence.map(content => ({role: "custom", customType: "peer", content, display: false, timestamp: 0}));
	function count(expected: string[], incoming: string[], e = 0, i = 0): number {
		if (i === incoming.length) return 1;
		if (e === expected.length) return 0;
		return count(expected, incoming, e + 1, i) + (expected[e] === incoming[i] ? count(expected, incoming, e + 1, i + 1) : 0);
	}
	for (const expected of sequences) for (const incoming of sequences) {
		assert.equal(instructionContextMatches(messages(expected), messages(incoming)), count(expected, incoming) === 1,
			JSON.stringify({expected, incoming}));
	}
});
