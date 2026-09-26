import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	projectCapabilityMessages,
	projectPresetSystemPrompt,
} from "../src/capability-projection.ts";
import {
	CAPABILITY_DELIVERY_TYPE,
	type CapabilityHistory,
} from "../src/capability-protocol.ts";
import {
	createCapabilitySnapshot,
	type CapabilityActivateEvent,
	type CapabilityDeactivateEvent,
} from "../src/capability-events.ts";

function makeActivate(
	eventId: string,
	activationId: string,
	content: string,
	createdAt = 1000,
): CapabilityActivateEvent {
	return {
		schemaVersion: 1,
		eventId,
		op: "activate",
		actor: "user",
		createdAt,
		snapshot: createCapabilitySnapshot({
			activationId,
			source: { kind: "manual" },
			content,
			tools: { add: [], remove: [] },
		}),
	};
}

function makeDeactivate(
	eventId: string,
	activationId: string,
	createdAt = 2000,
): CapabilityDeactivateEvent {
	return {
		schemaVersion: 1,
		eventId,
		op: "deactivate",
		actor: "user",
		createdAt,
		activationId,
	};
}

function makeMarker(throughEventId: string, timestamp = 1500): AgentMessage {
	return {
		role: "custom",
		customType: CAPABILITY_DELIVERY_TYPE,
		content: "delivery marker",
		details: {
			schemaVersion: 1,
			throughEventId,
		},
		timestamp,
	} as AgentMessage;
}

test("1. nativeoff: active instruction deactivation emits null section and empty content", () => {
	const ev1 = makeActivate("ev-1", "act-1", "Rule content 1", 1000);
	const ev2 = makeDeactivate("ev-2", "act-1", 2000);
	const history: CapabilityHistory = { events: [ev1, ev2] };

	const messages: AgentMessage[] = [
		{ role: "system", content: "Base system", timestamp: 100 } as AgentMessage,
		{ role: "user", content: "first question", timestamp: 200 } as AgentMessage,
		makeMarker("ev-1", 1100),
		{ role: "assistant", content: [{ type: "text", text: "ans 1" }], timestamp: 1200 } as AgentMessage,
		makeMarker("ev-2", 2100),
		{ role: "user", content: "second question", timestamp: 2200 } as AgentMessage,
	];

	const res = projectCapabilityMessages(messages, history, true);
	assert.equal(res.throughEventId, "ev-2");
	assert.equal(res.messages.length, 6);

	const msg1 = res.messages[2] as SystemMessage;
	assert.equal(msg1.role, "system");
	assert.equal(msg1.content, "");
	assert.deepEqual(msg1.sections, { "forge-capability-act-1": "Rule content 1" });
	assert.equal(msg1.timestamp, 1100);

	const msg2 = res.messages[4] as SystemMessage;
	assert.equal(msg2.role, "system");
	assert.equal(msg2.content, "");
	assert.deepEqual(msg2.sections, { "forge-capability-act-1": null });
	assert.equal(msg2.timestamp, 2100);
});

test("2. nonoverlap foreign preserving: foreign sections, custom messages and tools are preserved", () => {
	const ev1 = makeActivate("ev-1", "act-1", "Special rule", 1000);
	const history: CapabilityHistory = { events: [ev1] };

	const foreignTool = { name: "custom_tool", description: "foreign tool", parameters: {} };
	const leadingSystem: AgentMessage = {
		role: "system",
		content: "Pi base prompt",
		sections: {
			preamble: "pi preamble",
			tools: "tool docs",
			rules: "pi rules",
			docs: "pi docs",
			addendum: "pi addendum",
			project_context: "context",
			skills: "skills",
			cwd: "/workspace",
			foreign_addon: "keep this foreign section",
		},
		toolsAdded: [foreignTool],
		timestamp: 100,
	} as unknown as AgentMessage;

	const foreignCustom: AgentMessage = {
		role: "custom",
		customType: "foreign-telemetry",
		content: "foreign payload",
		details: { any: 123 },
		timestamp: 200,
	} as unknown as AgentMessage;

	const messages: AgentMessage[] = [
		leadingSystem,
		foreignCustom,
		makeMarker("ev-1", 1050),
	];

	const projectedCapabilities = projectCapabilityMessages(messages, history, true);
	assert.equal(projectedCapabilities.messages[1], foreignCustom); // foreign custom intact

	const projectedPreset = projectPresetSystemPrompt(
		projectedCapabilities.messages,
		"EXACT COMPILED PROMPT",
	);

	const headSystem = projectedPreset[0] as SystemMessage;
	assert.equal(headSystem.role, "system");
	assert.equal(headSystem.content, "EXACT COMPILED PROMPT");
	assert.deepEqual(headSystem.sections, { foreign_addon: "keep this foreign section" });
	assert.deepEqual(headSystem.toolsAdded, [foreignTool]);
	assert.equal(projectedPreset[1], foreignCustom);
});

test("3. modelswitch同markers: same markers yield SystemMessage in native and UserMessage in fallback", () => {
	const ev1 = makeActivate("ev-1", "act-switch", "Strict capability only", 1000);
	const history: CapabilityHistory = { events: [ev1] };

	const marker = makeMarker("ev-1", 1100);
	const transcript: AgentMessage[] = [
		{ role: "system", content: "Base", timestamp: 100 } as AgentMessage,
		{ role: "user", content: "hi", timestamp: 200 } as AgentMessage,
		marker,
	];

	// Native projection
	const nativeRes = projectCapabilityMessages(transcript, history, true);
	assert.equal(nativeRes.messages.length, 3);
	const nativeMsg = nativeRes.messages[2] as SystemMessage;
	assert.equal(nativeMsg.role, "system");
	assert.equal(nativeMsg.content, "");
	assert.deepEqual(nativeMsg.sections, { "forge-capability-act-switch": "Strict capability only" });

	// Fallback projection with identical input transcript
	const fallbackRes = projectCapabilityMessages(transcript, history, false);
	assert.equal(fallbackRes.messages.length, 3);
	const fallbackMsg = fallbackRes.messages[2] as UserMessage;
	assert.equal(fallbackMsg.role, "user");
	assert.ok(typeof fallbackMsg.content === "string");
	assert.ok(fallbackMsg.content.startsWith("[pi-forge capability update]\n"));
	assert.ok(fallbackMsg.content.includes('Updated system prompt section "forge-capability-act-switch"'));
	assert.ok(fallbackMsg.content.includes("Strict capability only"));

	// Switching back to native
	const nativeRes2 = projectCapabilityMessages(transcript, history, true);
	assert.equal((nativeRes2.messages[2] as SystemMessage).role, "system");
	assert.equal(marker.role, "custom"); // source marker unmodified
});

test("4. compaction kepttail: pre-checkpoint markers removed, checkpoint inserted after leadingSystem, post-checkpoint delta replayed", () => {
	const ev1 = makeActivate("ev-1", "act-1", "Rule 1", 1000);
	const ev2 = makeActivate("ev-2", "act-2", "Rule 2", 2000);
	const ev3 = makeActivate("ev-3", "act-3", "Rule 3", 3000);
	const history: CapabilityHistory = {
		events: [ev1, ev2, ev3],
		checkpointThrough: "ev-2",
	};

	const leadingSystem: AgentMessage = { role: "system", content: "Leading Prompt", timestamp: 100 } as AgentMessage;
	const compactionSummary: AgentMessage = {
		role: "compactionSummary",
		summary: "summarized history",
		timestamp: 2100,
	} as unknown as AgentMessage;
	const retainedTailUser: AgentMessage = { role: "user", content: "kept question", timestamp: 2200 } as AgentMessage;
	const keptTailMarkerOld: AgentMessage = makeMarker("ev-1", 2250); // <= checkpoint, should be stripped
	const keptTailMarkerCheckpoint: AgentMessage = makeMarker("ev-2", 2260); // <= checkpoint, should be stripped
	const markerPostCheckpoint: AgentMessage = makeMarker("ev-3", 3100); // > checkpoint, replays delta

	const messages: AgentMessage[] = [
		leadingSystem,
		compactionSummary,
		retainedTailUser,
		keptTailMarkerOld,
		keptTailMarkerCheckpoint,
		markerPostCheckpoint,
	];

	const res = projectCapabilityMessages(messages, history, true);
	assert.equal(res.throughEventId, "ev-3");

	// Messages should be:
	// 0: leadingSystem
	// 1: checkpoint message (active: act-1 and act-2)
	// 2: compactionSummary
	// 3: retainedTailUser
	// 4: projected message for ev-3 (delta: act-3)
	assert.equal(res.messages.length, 5);
	assert.equal(res.messages[0], leadingSystem);

	const cpMsg = res.messages[1] as SystemMessage;
	assert.equal(cpMsg.role, "system");
	assert.equal(cpMsg.content, "");
	assert.deepEqual(cpMsg.sections, {
		"forge-capability-act-1": "Rule 1",
		"forge-capability-act-2": "Rule 2",
	});
	assert.equal(cpMsg.timestamp, 2000); // createdAt of ev-2

	assert.equal(res.messages[2], compactionSummary);
	assert.equal(res.messages[3], retainedTailUser);

	const deltaMsg = res.messages[4] as SystemMessage;
	assert.equal(deltaMsg.role, "system");
	assert.deepEqual(deltaMsg.sections, {
		"forge-capability-act-3": "Rule 3",
	});
});

test("5. missingmarker: missing event marker is delivered as safety net delta at request tail", () => {
	const ev1 = makeActivate("ev-1", "act-1", "Rule 1", 1000);
	const ev2 = makeActivate("ev-2", "act-2", "Rule 2", 2000);
	const history: CapabilityHistory = { events: [ev1, ev2] };

	const messages: AgentMessage[] = [
		{ role: "system", content: "Prompt", timestamp: 100 } as AgentMessage,
		{ role: "user", content: "query", timestamp: 200 } as AgentMessage,
		makeMarker("ev-1", 1100),
		{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1200 } as AgentMessage,
	];

	const res = projectCapabilityMessages(messages, history, true);
	assert.equal(res.throughEventId, "ev-2");
	assert.equal(res.messages.length, 5);

	const tailMsg = res.messages[4] as SystemMessage;
	assert.equal(tailMsg.role, "system");
	assert.deepEqual(tailMsg.sections, { "forge-capability-act-2": "Rule 2" });
	assert.equal(tailMsg.timestamp, 2000);
});

test("6. corruptcursor: cursor not in branch or moving backwards throws Error", () => {
	const ev1 = makeActivate("ev-1", "act-1", "Rule 1", 1000);
	const ev2 = makeActivate("ev-2", "act-2", "Rule 2", 2000);
	const history: CapabilityHistory = { events: [ev1, ev2] };

	// Not in branch
	const badCursorMessages: AgentMessage[] = [makeMarker("ev-non-existent", 1100)];
	assert.throws(
		() => projectCapabilityMessages(badCursorMessages, history, true),
		/not found in branch events/,
	);

	// Backwards cursor
	const backwardsMessages: AgentMessage[] = [
		makeMarker("ev-2", 1100),
		makeMarker("ev-1", 1200),
	];
	assert.throws(
		() => projectCapabilityMessages(backwardsMessages, history, true),
		/earlier than current cursor position/,
	);
});

test("7. bad owned marker: malformed details throws Error", () => {
	const ev1 = makeActivate("ev-1", "act-1", "Rule 1", 1000);
	const history: CapabilityHistory = { events: [ev1] };

	const missingDetails = {
		role: "custom",
		customType: CAPABILITY_DELIVERY_TYPE,
		content: "bad",
		timestamp: 100,
	} as unknown as AgentMessage;
	assert.throws(
		() => projectCapabilityMessages([missingDetails], history, true),
		/details object is required/,
	);

	const wrongSchema = {
		role: "custom",
		customType: CAPABILITY_DELIVERY_TYPE,
		content: "bad",
		details: { schemaVersion: 2, throughEventId: "ev-1" },
		timestamp: 100,
	} as unknown as AgentMessage;
	assert.throws(
		() => projectCapabilityMessages([wrongSchema], history, true),
		/schemaVersion must be 1/,
	);

	const badThroughType = {
		role: "custom",
		customType: CAPABILITY_DELIVERY_TYPE,
		content: "bad",
		details: { schemaVersion: 1, throughEventId: 123 },
		timestamp: 100,
	} as unknown as AgentMessage;
	assert.throws(
		() => projectCapabilityMessages([badThroughType], history, true),
		/throughEventId must be a non-empty string/,
	);
});

test("8. invalid event in history: fails reduction defensively", () => {
	const badHistory = {
		events: [{ schemaVersion: 1, eventId: "bad", op: "unknown_op" } as unknown as CapabilityActivateEvent],
	};
	assert.throws(
		() => projectCapabilityMessages([], badHistory, true),
		/Invalid capability events/,
	);

	const missingCheckpointHistory = {
		events: [makeActivate("ev-1", "act-1", "Rule")],
		checkpointThrough: "ev-ghost",
	};
	assert.throws(
		() => projectCapabilityMessages([], missingCheckpointHistory, true),
		/checkpointThrough "ev-ghost" not found in branch events/,
	);
});

test("9. immutable: input messages and history are never modified", () => {
	const ev1 = makeActivate("ev-1", "act-1", "Rule 1", 1000);
	const history: CapabilityHistory = Object.freeze({
		events: Object.freeze([ev1]),
	});

	const marker = Object.freeze(makeMarker("ev-1", 1100));
	const userMsg = Object.freeze({ role: "user", content: "hi", timestamp: 100 } as UserMessage);
	const sysMsg = Object.freeze({ role: "system", content: "Pi prompt", timestamp: 50 } as SystemMessage);
	const messages: AgentMessage[] = Object.freeze([sysMsg, userMsg, marker]) as unknown as AgentMessage[];

	const res = projectCapabilityMessages(messages, history, true);

	assert.equal(messages.length, 3);
	assert.equal(res.messages[0], sysMsg);
	assert.equal(res.messages[1], userMsg);
	assert.equal(marker.role, "custom");

	const resPreset = projectPresetSystemPrompt(messages, "NEW COMPILED");
	assert.equal(messages.length, 3);
	assert.equal(sysMsg.content, "Pi prompt");
	assert.equal(resPreset[1], userMsg);
});

test("10. missing carriers replay explicit stop notices; a completed cursor may coalesce", () => {
	const ev1 = makeActivate("ev-1", "act-temp", "Temp rule", 1000);
	const ev2 = makeDeactivate("ev-2", "act-temp", 2000);
	const history: CapabilityHistory = { events: [ev1, ev2] };

	// No markers: activation may already have been delivered on an earlier request.
	const messages: AgentMessage[] = [
		{ role: "system", content: "Base", timestamp: 100 } as AgentMessage,
		{ role: "user", content: "hello", timestamp: 2100 } as AgentMessage,
	];

	const res = projectCapabilityMessages(messages, history, true);
	assert.equal(res.throughEventId, "ev-2");
	// Do not silently lose the stop notice just because the final net state is empty.
	assert.equal(res.messages.length, 4);
	assert.deepEqual((res.messages[3] as SystemMessage).sections, { "forge-capability-act-temp": null });
	assert.equal(res.messages[0], messages[0]);
	assert.equal(res.messages[1], messages[1]);

	// Marker pointing to ev-2 in transcript also produces no message (coalesced)
	const withMarker: AgentMessage[] = [
		messages[0],
		makeMarker("ev-2", 2050),
		messages[1],
	];
	const resWithMarker = projectCapabilityMessages(withMarker, history, true);
	assert.equal(resWithMarker.messages.length, 2);
});

test("11. 多同cursor marker只投一次: duplicate markers with same cursor produce only one projection", () => {
	const ev1 = makeActivate("ev-1", "act-1", "Rule once", 1000);
	const history: CapabilityHistory = { events: [ev1] };

	const marker1 = makeMarker("ev-1", 1100);
	const marker2 = makeMarker("ev-1", 1150);
	const marker3 = makeMarker("ev-1", 1200);

	const messages: AgentMessage[] = [
		{ role: "system", content: "Base", timestamp: 100 } as AgentMessage,
		marker1,
		marker2,
		marker3,
		{ role: "user", content: "query", timestamp: 1300 } as AgentMessage,
	];

	const res = projectCapabilityMessages(messages, history, true);
	// Only marker1 should be projected; marker2 and marker3 dropped
	assert.equal(res.messages.length, 3);
	assert.equal(res.messages[0].role, "system");
	assert.equal(res.messages[1].role, "system");
	assert.deepEqual((res.messages[1] as SystemMessage).sections, { "forge-capability-act-1": "Rule once" });
	assert.equal(res.messages[2].role, "user");
});

test("12. checkpoint without active state: suppresses pre-checkpoint markers and does not emit empty checkpoint message", () => {
	const ev1 = makeActivate("ev-1", "act-old", "Old rule", 1000);
	const ev2 = makeDeactivate("ev-2", "act-old", 2000);
	// At ev-2, active state is empty
	const history: CapabilityHistory = {
		events: [ev1, ev2],
		checkpointThrough: "ev-2",
	};

	const messages: AgentMessage[] = [
		{ role: "system", content: "Base", timestamp: 100 } as AgentMessage,
		makeMarker("ev-1", 1100),
		{ role: "user", content: "query", timestamp: 2100 } as AgentMessage,
	];

	const res = projectCapabilityMessages(messages, history, true);
	assert.equal(res.throughEventId, "ev-2");
	// Old marker suppressed, no empty checkpoint message emitted
	assert.equal(res.messages.length, 2);
	assert.equal(res.messages[0].role, "system");
	assert.equal(res.messages[1].role, "user");
});

test("13. 精确base字符串: projectPresetSystemPrompt preserves whitespace and exact string", () => {
	const BASE_EXACT = "  EXACT FORGE BASE\n\nPreserve spacing.\n";

	const messages: AgentMessage[] = [
		{
			role: "system",
			content: "Old Pi Base Prompt",
			sections: { rules: "old rules", cwd: "/tmp" },
			timestamp: 10,
		} as AgentMessage,
		{ role: "user", content: "test", timestamp: 20 } as AgentMessage,
		{
			role: "system",
			content: "Mid-convo secondary system message",
			timestamp: 30,
		} as AgentMessage,
	];

	const res = projectPresetSystemPrompt(messages, BASE_EXACT);
	assert.equal(res.length, 3);
	assert.equal((res[0] as SystemMessage).content, BASE_EXACT);
	assert.equal((res[0] as SystemMessage).sections, undefined); // builtin keys removed
	assert.equal(res[1], messages[1]);
	// Subsequent SystemMessage keeps original content
	assert.equal((res[2] as SystemMessage).content, "Mid-convo secondary system message");
});

test("14. foreignsystem保留: foreign SystemMessages content, foreign sections and tools are preserved", () => {
	const foreignToolRemoved = [{ name: "legacy_tool" }];
	const messages: AgentMessage[] = [
		{
			role: "system",
			content: "First system prompt",
			sections: { preamble: "remove", plugin_meta: "keep_plugin_meta" },
			timestamp: 10,
		} as AgentMessage,
		{
			role: "system",
			content: "Second system prompt with tools update",
			sections: { plugin_note: "keep_note" },
			toolsRemoved: foreignToolRemoved,
			timestamp: 50,
		} as AgentMessage,
	];

	const res = projectPresetSystemPrompt(messages, "NEW COMPILED PROMPT");
	assert.equal(res.length, 2);

	const first = res[0] as SystemMessage;
	assert.equal(first.content, "NEW COMPILED PROMPT");
	assert.deepEqual(first.sections, { plugin_meta: "keep_plugin_meta" });

	const second = res[1] as SystemMessage;
	assert.equal(second.content, "Second system prompt with tools update");
	assert.deepEqual(second.sections, { plugin_note: "keep_note" });
	assert.deepEqual(second.toolsRemoved, foreignToolRemoved);
});

test("15. no leading system prompt unshift: projectPresetSystemPrompt unshifts SystemMessage when none exists", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "hello", timestamp: 100 } as AgentMessage,
		{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 200 } as AgentMessage,
	];

	const res = projectPresetSystemPrompt(messages, "COMPILED SYSTEM PROMPT");
	assert.equal(res.length, 3);
	const head = res[0] as SystemMessage;
	assert.equal(head.role, "system");
	assert.equal(head.content, "COMPILED SYSTEM PROMPT");
	assert.equal(head.timestamp, 0);
	assert.equal(res[1], messages[0]);
	assert.equal(res[2], messages[1]);
});

test("16. fallback message format: renders [pi-forge capability update] user message on activate and deactivate", () => {
	const ev1 = makeActivate("ev-1", "act-fb", "Do not run rm -rf", 1000);
	const ev2 = makeDeactivate("ev-2", "act-fb", 2000);
	const history: CapabilityHistory = { events: [ev1, ev2] };

	const messages: AgentMessage[] = [
		makeMarker("ev-1", 1050),
		makeMarker("ev-2", 2050),
	];

	const res = projectCapabilityMessages(messages, history, false);
	assert.equal(res.messages.length, 2);

	const u1 = res.messages[0] as UserMessage;
	assert.equal(u1.role, "user");
	assert.equal(
		u1.content,
		'[pi-forge capability update]\nUpdated system prompt section "forge-capability-act-fb":\n\nDo not run rm -rf',
	);
	assert.equal(u1.timestamp, 1050);

	const u2 = res.messages[1] as UserMessage;
	assert.equal(u2.role, "user");
	assert.equal(
		u2.content,
		'[pi-forge capability update]\nRemoved system prompt section "forge-capability-act-fb".',
	);
	assert.equal(u2.timestamp, 2050);
});


test("identical event replay cannot move an earlier delivery cursor past later events", () => {
	const a = makeActivate("a", "one", "one");
	const b = makeActivate("b", "two", "two");
	const projected = projectCapabilityMessages([makeMarker("a"), makeMarker("b")], { events: [a, b, a] }, true);
	assert.equal(projected.throughEventId, "b");
	assert.equal(projected.messages.length, 2);
	assert.deepEqual((projected.messages[0] as SystemMessage).sections, { "forge-capability-one": "one" });
});

function makeToolOnlyActivate(
	eventId: string,
	activationId: string,
	content = "",
	createdAt = 1000,
): CapabilityActivateEvent {
	return {
		schemaVersion: 1,
		eventId,
		op: "activate",
		actor: "user",
		createdAt,
		snapshot: createCapabilitySnapshot({
			activationId,
			source: { kind: "manual" },
			content,
			tools: { add: ["ls"], remove: [] },
		}),
	};
}

for (const native of [true, false]) {
	const label = native ? "native" : "fallback";

	test(`tool-only (${label}): empty or whitespace-only text projects no update on activate or deactivate`, () => {
		for (const content of ["", "  \n\t"]) {
			const history: CapabilityHistory = {
				events: [makeToolOnlyActivate("ev-1", "tools", content, 1000), makeDeactivate("ev-2", "tools", 2000)],
			};
			const user1 = { role: "user", content: "first", timestamp: 200 } as AgentMessage;
			const user2 = { role: "user", content: "second", timestamp: 2200 } as AgentMessage;
			const res = projectCapabilityMessages([user1, makeMarker("ev-1", 1100), user2, makeMarker("ev-2", 2100)], history, native);
			assert.deepEqual(res.messages, [user1, user2]);
			assert.equal(res.throughEventId, "ev-2");
		}
	});

	test(`tool-only (${label}): mixed with a text capability, only the text capability is projected`, () => {
		const history: CapabilityHistory = {
			events: [
				makeActivate("ev-1", "text", "Rule", 1000),
				makeToolOnlyActivate("ev-2", "tools", "", 2000),
				makeDeactivate("ev-3", "tools", 3000),
				makeDeactivate("ev-4", "text", 4000),
			],
		};
		const res = projectCapabilityMessages(
			[makeMarker("ev-1", 1100), makeMarker("ev-2", 2100), makeMarker("ev-3", 3100), makeMarker("ev-4", 4100)],
			history,
			native,
		);
		assert.equal(res.messages.length, 2);
		assert.ok(!JSON.stringify(res.messages).includes("forge-capability-tools"));
		if (native) {
			assert.deepEqual((res.messages[0] as SystemMessage).sections, { "forge-capability-text": "Rule" });
			assert.deepEqual((res.messages[1] as SystemMessage).sections, { "forge-capability-text": null });
		} else {
			assert.match((res.messages[0] as UserMessage).content as string, /Updated system prompt section "forge-capability-text"/);
			assert.match((res.messages[1] as UserMessage).content as string, /Removed system prompt section "forge-capability-text"/);
		}
	});

	test(`tool-only (${label}): no checkpoint or missing-carrier replay for text-free state`, () => {
		const leading = { role: "system", content: "Leading", timestamp: 100 } as AgentMessage;
		const user = { role: "user", content: "kept", timestamp: 2200 } as AgentMessage;
		const checkpoint = projectCapabilityMessages(
			[leading, user],
			{ events: [makeToolOnlyActivate("ev-1", "tools", "", 1000)], checkpointThrough: "ev-1" },
			native,
		);
		assert.deepEqual(checkpoint.messages, [leading, user]);

		const pending = projectCapabilityMessages(
			[leading, user],
			{ events: [makeToolOnlyActivate("ev-1", "tools", "", 1000), makeDeactivate("ev-2", "tools", 2000)] },
			native,
		);
		assert.deepEqual(pending.messages, [leading, user]);
	});
}
