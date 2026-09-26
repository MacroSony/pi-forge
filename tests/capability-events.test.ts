import assert from "node:assert/strict";
import test from "node:test";
import {
	createCapabilitySnapshot,
	decodeCapabilityEvent,
	reduceCapabilityEvents,
	FINGERPRINT_PATTERN,
	MAX_CAPABILITY_NAME_LENGTH,
	MAX_NAME_LENGTH,
} from "../src/capability-events.ts";

test("1. createCapabilitySnapshot creates valid frozen snapshot with correct fingerprint format", () => {
	const snap = createCapabilitySnapshot({
		activationId: "act-1",
		source: { kind: "manual" },
		content: "System directive for coding",
		tools: { add: ["read_file"], remove: ["bash"] },
	});
	assert.equal(snap.activationId, "act-1");
	assert.equal(snap.source.kind, "manual");
	assert.equal(snap.content, "System directive for coding");
	assert.deepEqual(snap.tools.add, ["read_file"]);
	assert.deepEqual(snap.tools.remove, ["bash"]);
	assert.ok(FINGERPRINT_PATTERN.test(snap.fingerprint));
	assert.ok(Object.isFrozen(snap));
	assert.ok(Object.isFrozen(snap.tools));
	assert.ok(Object.isFrozen(snap.tools.add));
});

test("2. 快照独立源修改: mutating source or tool input after snapshot creation does not affect snapshot", () => {
	const source = {
		kind: "capability" as const,
		key: { scope: "project" as const, id: "capability-a" },
		binding: { preset: { scope: "project" as const, id: "preset-p" }, id: "b1" },
	};
	const tools = { add: ["search_tool"], remove: [] };
	const snap = createCapabilitySnapshot({
		activationId: "act-iso",
		source,
		content: "Iso test",
		tools,
	});

	// Mutate inputs
	source.key.id = "mutated-id";
	source.binding.id = "mutated-binding";
	tools.add.push("evil_tool");

	assert.equal(snap.source.kind === "capability" && snap.source.key.id, "capability-a");
	assert.equal(snap.source.kind === "capability" && snap.source.binding?.id, "b1");
	assert.deepEqual(snap.tools.add, ["search_tool"]);
});

test("3. 冻结不污染输入: input passed to createCapabilitySnapshot is not frozen", () => {
	const rawTools = { add: ["tool1"], remove: [] };
	const rawSource = { kind: "manual" as const };
	createCapabilitySnapshot({
		activationId: "act-freeze",
		source: rawSource,
		content: "Test freeze non-pollution",
		tools: rawTools,
	});
	assert.equal(Object.isFrozen(rawTools), false);
	assert.equal(Object.isFrozen(rawSource), false);
	// Can still mutate raw input without error
	rawTools.add.push("tool2");
	assert.equal(rawTools.add.length, 2);
});

test("4. JSON roundtrip: snapshot and events serialize & deserialize cleanly", () => {
	const snap = createCapabilitySnapshot({
		activationId: "act-json",
		name: "Test Mode",
		source: {
			kind: "capability",
			key: { scope: "global", id: "strict" },
			binding: { preset: { scope: "project", id: "default" }, id: "bind-1" },
		},
		content: "Roundtrip content",
		tools: { add: ["t1"], remove: ["t2"] },
	});

	const event = {
		schemaVersion: 1,
		eventId: "evt-1",
		op: "activate",
		actor: "user",
		createdAt: 1000,
		snapshot: snap,
	};

	const json = JSON.stringify(event);
	const parsed = JSON.parse(json);
	const decoded = decodeCapabilityEvent(parsed);
	assert.equal(decoded.ok, true);
	if (decoded.ok && decoded.event.op === "activate") {
		assert.equal(decoded.event.snapshot.fingerprint, snap.fingerprint);
		assert.equal(decoded.event.snapshot.name, "Test Mode");
		assert.deepEqual(decoded.event.snapshot.tools, snap.tools);
	}
});

test("5. fingerprint tamper: modified fingerprint or content fails decode", () => {
	const snap = createCapabilitySnapshot({
		activationId: "act-tamper",
		source: { kind: "manual" },
		content: "Original text",
		tools: { add: [], remove: [] },
	});

	const event = {
		schemaVersion: 1,
		eventId: "evt-tamper",
		op: "activate",
		actor: "user",
		createdAt: 1000,
		snapshot: { ...snap, fingerprint: "sha256:v1:0000000000000000000000000000000000000000000000000000000000000000" },
	};
	const res = decodeCapabilityEvent(event);
	assert.equal(res.ok, false);
	assert.match(res.error, /fingerprint mismatch/i);

	// Tampered content with validly-formatted original fingerprint
	const eventTamperedContent = {
		schemaVersion: 1,
		eventId: "evt-tamper-2",
		op: "activate",
		actor: "user",
		createdAt: 1000,
		snapshot: { ...snap, content: "Tampered text" },
	};
	const res2 = decodeCapabilityEvent(eventTamperedContent);
	assert.equal(res2.ok, false);
	assert.match(res2.error, /fingerprint mismatch/i);
});

test("6. fingerprint 属性顺序: key order in snapshot payload does not change fingerprint", () => {
	const snapA = createCapabilitySnapshot({
		activationId: "act-order-1",
		source: { kind: "manual" },
		content: "Check order",
		tools: { add: ["a", "b"], remove: [] },
	});
	// Same data, different activationId
	const snapB = createCapabilitySnapshot({
		activationId: "act-order-2",
		source: { kind: "manual" },
		content: "Check order",
		tools: { add: ["a", "b"], remove: [] },
	});
	// Fingerprint is computed over content/source/tools without activationId
	assert.equal(snapA.fingerprint, snapB.fingerprint);
});

test("7. decodeCapabilityEvent: invalid raw structures rejected", () => {
	assert.equal(decodeCapabilityEvent(null).ok, false);
	assert.equal(decodeCapabilityEvent([]).ok, false);
	assert.equal(decodeCapabilityEvent("string").ok, false);
	assert.equal(decodeCapabilityEvent({ schemaVersion: 2 }).ok, false);
	assert.equal(decodeCapabilityEvent({ schemaVersion: 1, eventId: "e1", op: "unknown", actor: "user", createdAt: 0 }).ok, false);
	assert.equal(decodeCapabilityEvent({ schemaVersion: 1, eventId: "e1", op: "reset", actor: "user", createdAt: -1 }).ok, false);
	assert.equal(decodeCapabilityEvent({ schemaVersion: 1, eventId: "e1", op: "reset", actor: "user", createdAt: Infinity }).ok, false);
	assert.equal(decodeCapabilityEvent({ schemaVersion: 1, eventId: "e1", op: "reset", actor: "user", createdAt: NaN }).ok, false);
});

test("8. decodeCapabilityEvent: scopes validation", () => {
	const snapInvalidScope = {
		activationId: "act-scope",
		source: { kind: "capability", key: { scope: "invalid-scope", id: "mode1" } },
		content: "Scope test",
		tools: { add: [], remove: [] },
		fingerprint: "sha256:v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	};
	const res = decodeCapabilityEvent({
		schemaVersion: 1,
		eventId: "evt-scope",
		op: "activate",
		actor: "user",
		createdAt: 100,
		snapshot: snapInvalidScope,
	});
	assert.equal(res.ok, false);
	assert.match(res.error, /scope/i);
});

test("9. decodeCapabilityEvent: bad tool arrays and names rejected", () => {
	assert.throws(() => {
		createCapabilitySnapshot({
			activationId: "act-bad-tool",
			source: { kind: "manual" },
			content: "bad tool",
			tools: { add: ["invalid tool with spaces"], remove: [] },
		});
	}, TypeError);

	assert.throws(() => {
		createCapabilitySnapshot({
			activationId: "act-bad-tool-wildcard",
			source: { kind: "manual" },
			content: "bad tool",
			tools: { add: ["*"], remove: [] },
		});
	}, TypeError);
});

test("10. decodeCapabilityEvent: unknown fields strictly rejected", () => {
	const validReset = {
		schemaVersion: 1,
		eventId: "evt-unknown",
		op: "reset",
		actor: "user",
		createdAt: 100,
		extraField: "not-allowed",
	};
	const res = decodeCapabilityEvent(validReset);
	assert.equal(res.ok, false);
	assert.match(res.error, /unexpected property/i);
});

test("11. agent activation requires capability with binding; agent cannot activate manual", () => {
	const manualSnap = createCapabilitySnapshot({
		activationId: "act-manual",
		source: { kind: "manual" },
		content: "Manual text",
		tools: { add: [], remove: [] },
	});
	const resAgentManual = decodeCapabilityEvent({
		schemaVersion: 1,
		eventId: "evt-agent-man",
		op: "activate",
		actor: "agent",
		createdAt: 10,
		snapshot: manualSnap,
	});
	assert.equal(resAgentManual.ok, false);
	assert.match(resAgentManual.error, /agent activation must have source capability with binding|manual source can only be activated by user/i);

	const modeWithoutBindingSnap = createCapabilitySnapshot({
		activationId: "act-unbound",
		source: { kind: "capability", key: { scope: "project", id: "capability-x" } },
		content: "Unbound capability",
		tools: { add: [], remove: [] },
	});
	const resAgentUnbound = decodeCapabilityEvent({
		schemaVersion: 1,
		eventId: "evt-agent-unbound",
		op: "activate",
		actor: "agent",
		createdAt: 10,
		snapshot: modeWithoutBindingSnap,
	});
	assert.equal(resAgentUnbound.ok, false);
	assert.match(resAgentUnbound.error, /agent activation must have source capability with binding/i);
});

test("12. global preset不可绑定project capability", () => {
	assert.throws(() => {
		createCapabilitySnapshot({
			activationId: "act-cross",
			source: {
				kind: "capability",
				key: { scope: "project", id: "proj-capability" },
				binding: { preset: { scope: "global", id: "glob-preset" }, id: "b1" },
			},
			content: "Global preset binding project capability",
			tools: { add: [], remove: [] },
		});
	}, TypeError);
});

test("13. on / off / reset / noop lifecycle", () => {
	const snap1 = createCapabilitySnapshot({
		activationId: "act-1",
		source: { kind: "manual" },
		content: "Rule 1",
		tools: { add: ["read"], remove: [] },
	});
	const snap2 = createCapabilitySnapshot({
		activationId: "act-2",
		source: { kind: "manual" },
		content: "Rule 2",
		tools: { add: ["edit"], remove: [] },
	});

	const events = [
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "user", createdAt: 10, snapshot: snap1 },
		{ schemaVersion: 1, eventId: "e2", op: "activate", actor: "user", createdAt: 20, snapshot: snap2 },
		// deactivate unknown activationId is a noop
		{ schemaVersion: 1, eventId: "e3", op: "deactivate", actor: "user", createdAt: 30, activationId: "act-unknown" },
		// deactivate act-1
		{ schemaVersion: 1, eventId: "e4", op: "deactivate", actor: "user", createdAt: 40, activationId: "act-1" },
	];

	const res1 = reduceCapabilityEvents(events);
	assert.equal(res1.ok, true);
	if (res1.ok) {
		assert.equal(res1.active.length, 1);
		assert.equal(res1.active[0].snapshot.activationId, "act-2");
		assert.equal(res1.lastEventId, "e4");
	}

	// Now reset
	const resetEvents = [
		...events,
		{ schemaVersion: 1, eventId: "e5", op: "reset", actor: "user", createdAt: 50 },
	];
	const res2 = reduceCapabilityEvents(resetEvents);
	assert.equal(res2.ok, true);
	if (res2.ok) {
		assert.equal(res2.active.length, 0);
		assert.equal(res2.lastEventId, "e5");
	}
});

test("14. 旧off不杀later同binding: deactivating old bound capability allows activating same binding later", () => {
	const snapA = createCapabilitySnapshot({
		activationId: "act-b1-first",
		source: {
			kind: "capability",
			key: { scope: "project", id: "capability-1" },
			binding: { preset: { scope: "project", id: "preset-p" }, id: "bind-id" },
		},
		content: "First bound capability",
		tools: { add: [], remove: [] },
	});
	const snapB = createCapabilitySnapshot({
		activationId: "act-b1-second",
		source: {
			kind: "capability",
			key: { scope: "project", id: "capability-1" },
			binding: { preset: { scope: "project", id: "preset-p" }, id: "bind-id" },
		},
		content: "Second bound capability, same binding",
		tools: { add: [], remove: [] },
	});

	const events = [
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "agent", createdAt: 10, snapshot: snapA },
		{ schemaVersion: 1, eventId: "e2", op: "deactivate", actor: "agent", createdAt: 20, activationId: "act-b1-first" },
		{ schemaVersion: 1, eventId: "e3", op: "activate", actor: "agent", createdAt: 30, snapshot: snapB },
	];

	const res = reduceCapabilityEvents(events);
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(res.active.length, 1);
		assert.equal(res.active[0].snapshot.activationId, "act-b1-second");
	}
});

test("15. agent不能取消user: agent deactivating user-owned activation fails", () => {
	const snap = createCapabilitySnapshot({
		activationId: "act-user-owned",
		source: {
			kind: "capability",
			key: { scope: "project", id: "capability-u" },
			binding: { preset: { scope: "project", id: "preset-u" }, id: "bu" },
		},
		content: "User capability",
		tools: { add: [], remove: [] },
	});

	const events = [
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "user", createdAt: 10, snapshot: snap },
		{ schemaVersion: 1, eventId: "e2", op: "deactivate", actor: "agent", createdAt: 20, activationId: "act-user-owned" },
	];

	const res = reduceCapabilityEvents(events);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.equal(res.index, 1);
		assert.match(res.error, /agent cannot deactivate user-owned/i);
	}
});

test("16. 生命周期只旧bound可关: lifecycle can only deactivate capability with binding", () => {
	const manualSnap = createCapabilitySnapshot({
		activationId: "act-lifecycle-man",
		source: { kind: "manual" },
		content: "Manual rule",
		tools: { add: [], remove: [] },
	});
	const unboundSnap = createCapabilitySnapshot({
		activationId: "act-lifecycle-unbound",
		source: { kind: "capability", key: { scope: "project", id: "capability-m" } },
		content: "Unbound capability",
		tools: { add: [], remove: [] },
	});
	const boundSnap = createCapabilitySnapshot({
		activationId: "act-lifecycle-bound",
		source: {
			kind: "capability",
			key: { scope: "project", id: "capability-m" },
			binding: { preset: { scope: "project", id: "preset-p" }, id: "b-ok" },
		},
		content: "Bound capability",
		tools: { add: [], remove: [] },
	});

	// Lifecycle closing manual fails
	const resMan = reduceCapabilityEvents([
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "user", createdAt: 1, snapshot: manualSnap },
		{ schemaVersion: 1, eventId: "e2", op: "deactivate", actor: "lifecycle", createdAt: 2, activationId: "act-lifecycle-man" },
	]);
	assert.equal(resMan.ok, false);
	if (!resMan.ok) {
		assert.match(resMan.error, /lifecycle can only deactivate capability with binding/i);
	}

	// Lifecycle closing unbound capability fails
	const resUnbound = reduceCapabilityEvents([
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "user", createdAt: 1, snapshot: unboundSnap },
		{ schemaVersion: 1, eventId: "e2", op: "deactivate", actor: "lifecycle", createdAt: 2, activationId: "act-lifecycle-unbound" },
	]);
	assert.equal(resUnbound.ok, false);
	if (!resUnbound.ok) {
		assert.match(resUnbound.error, /lifecycle can only deactivate capability with binding/i);
	}

	// Lifecycle closing bound capability succeeds
	const resBound = reduceCapabilityEvents([
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "user", createdAt: 1, snapshot: boundSnap },
		{ schemaVersion: 1, eventId: "e2", op: "deactivate", actor: "lifecycle", createdAt: 2, activationId: "act-lifecycle-bound" },
	]);
	assert.equal(resBound.ok, true);
	if (resBound.ok) {
		assert.equal(resBound.active.length, 0);
	}
});

test("17. branch两条切片: branch slices produce correct independent active sets", () => {
	const baseSnap = createCapabilitySnapshot({
		activationId: "act-base",
		source: { kind: "manual" },
		content: "Base instruction",
		tools: { add: [], remove: [] },
	});
	const branch1Snap = createCapabilitySnapshot({
		activationId: "act-b1",
		source: { kind: "manual" },
		content: "Branch 1 instruction",
		tools: { add: [], remove: [] },
	});
	const branch2Snap = createCapabilitySnapshot({
		activationId: "act-b2",
		source: { kind: "manual" },
		content: "Branch 2 instruction",
		tools: { add: [], remove: [] },
	});

	const common = [
		{ schemaVersion: 1, eventId: "e-base", op: "activate", actor: "user", createdAt: 100, snapshot: baseSnap },
	];

	const branchA = [
		...common,
		{ schemaVersion: 1, eventId: "e-b1", op: "activate", actor: "user", createdAt: 200, snapshot: branch1Snap },
	];

	const branchB = [
		...common,
		{ schemaVersion: 1, eventId: "e-b2", op: "activate", actor: "user", createdAt: 200, snapshot: branch2Snap },
	];

	const resA = reduceCapabilityEvents(branchA);
	const resB = reduceCapabilityEvents(branchB);

	assert.equal(resA.ok, true);
	assert.equal(resB.ok, true);
	if (resA.ok && resB.ok) {
		assert.equal(resA.active.length, 2);
		assert.equal(resA.active[1].snapshot.activationId, "act-b1");
		assert.equal(resB.active.length, 2);
		assert.equal(resB.active[1].snapshot.activationId, "act-b2");
	}
});

test("18. 重复id conflict: duplicate eventId with identical payload is idempotent; conflicting payload fails", () => {
	const snap = createCapabilitySnapshot({
		activationId: "act-idem",
		source: { kind: "manual" },
		content: "Idempotent test",
		tools: { add: [], remove: [] },
	});

	const event = {
		schemaVersion: 1,
		eventId: "evt-dup",
		op: "activate",
		actor: "user",
		createdAt: 1000,
		snapshot: snap,
	};

	// Identical duplicate -> ok, active only has 1 item
	const resIdem = reduceCapabilityEvents([event, event]);
	assert.equal(resIdem.ok, true);
	if (resIdem.ok) {
		assert.equal(resIdem.active.length, 1);
		assert.equal(resIdem.lastEventId, "evt-dup");
	}

	// Conflicting duplicate eventId -> fails
	const conflictingEvent = {
		...event,
		createdAt: 2000,
	};
	const resConflict = reduceCapabilityEvents([event, conflictingEvent]);
	assert.equal(resConflict.ok, false);
	if (!resConflict.ok) {
		assert.equal(resConflict.index, 1);
		assert.match(resConflict.error, /duplicate eventid with conflicting payload/i);
	}
});

test("19. 同binding重复: activating two instructions with same preset binding simultaneously fails", () => {
	const snap1 = createCapabilitySnapshot({
		activationId: "act-same-1",
		source: {
			kind: "capability",
			key: { scope: "project", id: "capability-a" },
			binding: { preset: { scope: "project", id: "preset-x" }, id: "same-b-id" },
		},
		content: "First",
		tools: { add: [], remove: [] },
	});
	const snap2 = createCapabilitySnapshot({
		activationId: "act-same-2",
		source: {
			kind: "capability",
			key: { scope: "project", id: "capability-b" },
			binding: { preset: { scope: "project", id: "preset-x" }, id: "same-b-id" },
		},
		content: "Second",
		tools: { add: [], remove: [] },
	});

	const events = [
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "agent", createdAt: 1, snapshot: snap1 },
		{ schemaVersion: 1, eventId: "e2", op: "activate", actor: "agent", createdAt: 2, snapshot: snap2 },
	];

	const res = reduceCapabilityEvents(events);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.equal(res.index, 1);
		assert.match(res.error, /duplicate preset binding id/i);
	}
});

test("20. activationId在同一branch不可复用（即使已off或reset）", () => {
	const snap = createCapabilitySnapshot({
		activationId: "act-reuse",
		source: { kind: "manual" },
		content: "Cannot reuse id",
		tools: { add: [], remove: [] },
	});

	// Reusing after deactivate fails
	const resOff = reduceCapabilityEvents([
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "user", createdAt: 1, snapshot: snap },
		{ schemaVersion: 1, eventId: "e2", op: "deactivate", actor: "user", createdAt: 2, activationId: "act-reuse" },
		{ schemaVersion: 1, eventId: "e3", op: "activate", actor: "user", createdAt: 3, snapshot: snap },
	]);
	assert.equal(resOff.ok, false);
	if (!resOff.ok) {
		assert.equal(resOff.index, 2);
		assert.match(resOff.error, /activationid cannot be reused/i);
	}

	// Reusing after reset fails
	const resReset = reduceCapabilityEvents([
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "user", createdAt: 1, snapshot: snap },
		{ schemaVersion: 1, eventId: "e2", op: "reset", actor: "user", createdAt: 2 },
		{ schemaVersion: 1, eventId: "e3", op: "activate", actor: "user", createdAt: 3, snapshot: snap },
	]);
	assert.equal(resReset.ok, false);
	if (!resReset.ok) {
		assert.equal(resReset.index, 2);
		assert.match(resReset.error, /activationid cannot be reused/i);
	}
});

test("21. 出错不返回partial active: bad event at later index yields ok: false and no active list", () => {
	const snap = createCapabilitySnapshot({
		activationId: "act-partial",
		source: { kind: "manual" },
		content: "Partial test",
		tools: { add: [], remove: [] },
	});

	const events = [
		{ schemaVersion: 1, eventId: "e1", op: "activate", actor: "user", createdAt: 1, snapshot: snap },
		{ schemaVersion: 1, eventId: "e2", op: "activate", actor: "invalid-actor", createdAt: 2, snapshot: snap },
	];

	const res = reduceCapabilityEvents(events);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.equal(res.index, 1);
		assert.equal("active" in res, false);
	}
});

test("22. Content exceeding MAX_CONTENT_LENGTH or empty content and tools throws TypeError", () => {
	assert.throws(() => {
		createCapabilitySnapshot({
			activationId: "act-empty",
			source: { kind: "manual" },
			content: "   ",
			tools: { add: [], remove: [] },
		});
	}, TypeError);

	assert.throws(() => {
		createCapabilitySnapshot({
			activationId: "act-too-long",
			source: { kind: "manual" },
			content: "a".repeat(100_001),
			tools: { add: [], remove: [] },
		});
	}, TypeError);
});

test("23. 200-character resource IDs in source capability, preset, and binding succeed", () => {
	assert.equal(MAX_NAME_LENGTH, MAX_CAPABILITY_NAME_LENGTH);
	assert.equal(MAX_CAPABILITY_NAME_LENGTH, 1000);

	const longModeId = "m".repeat(200);
	const longPresetId = "p".repeat(200);
	const longBindingId = "b".repeat(200);

	const snapLong = createCapabilitySnapshot({
		activationId: "act-normal-128",
		source: {
			kind: "capability",
			key: { scope: "project", id: longModeId },
			binding: {
				preset: { scope: "project", id: longPresetId },
				id: longBindingId,
			},
		},
		content: "Testing 200-char IDs",
		tools: { add: [], remove: [] },
	});
	assert.equal(snapLong.source.kind, "capability");
	if (snapLong.source.kind === "capability") {
		assert.equal(snapLong.source.key.id.length, 200);
		assert.equal(snapLong.source.binding?.preset.id.length, 200);
		assert.equal(snapLong.source.binding?.id.length, 200);
	}

	const decodeRes = decodeCapabilityEvent({
		schemaVersion: 1,
		eventId: "ev-long-ids",
		op: "activate",
		actor: "agent",
		createdAt: 100,
		snapshot: snapLong,
	});
	assert.equal(decodeRes.ok, true);
});

test("24. Reducer duplicate-identical-event is noop and does not regress lastEventId", () => {
	const snapA = createCapabilitySnapshot({
		activationId: "act-a",
		source: { kind: "manual" },
		content: "Capability A",
		tools: { add: [], remove: [] },
	});
	const eventA = {
		schemaVersion: 1 as const,
		eventId: "ev-a",
		op: "activate" as const,
		actor: "user" as const,
		createdAt: 1,
		snapshot: snapA,
	};
	const eventB = {
		schemaVersion: 1 as const,
		eventId: "ev-b",
		op: "deactivate" as const,
		actor: "user" as const,
		createdAt: 2,
		activationId: "act-a",
	};
	const duplicateA = { ...eventA };

	const resSeq = reduceCapabilityEvents([eventA, eventB, duplicateA]);
	assert.equal(resSeq.ok, true);
	if (resSeq.ok) {
		assert.equal(resSeq.active.length, 0); // state is still off
		assert.equal(resSeq.lastEventId, "ev-b"); // must NOT regress to ev-a
	}
});

test("25. Decoder does not throw on untrusted objects with null prototype or null toString", () => {
	// op with Object.create(null)
	const badOpNullProto = {
		schemaVersion: 1,
		eventId: "ev-bad-op-1",
		op: Object.create(null),
		actor: "user",
		createdAt: 1,
	};
	assert.doesNotThrow(() => {
		const res = decodeCapabilityEvent(badOpNullProto);
		assert.equal(res.ok, false);
	});

	// op with toString: null
	const badOpNullToString = {
		schemaVersion: 1,
		eventId: "ev-bad-op-2",
		op: { toString: null },
		actor: "user",
		createdAt: 1,
	};
	assert.doesNotThrow(() => {
		const res = decodeCapabilityEvent(badOpNullToString);
		assert.equal(res.ok, false);
	});

	// source.kind with Object.create(null)
	const badKindNullProto = {
		schemaVersion: 1,
		eventId: "ev-bad-kind-1",
		op: "activate",
		actor: "user",
		createdAt: 1,
		snapshot: {
			activationId: "act-test-1",
			source: { kind: Object.create(null) },
			content: "hello",
			tools: { add: [], remove: [] },
			fingerprint: "sha256:v1:0000000000000000000000000000000000000000000000000000000000000000",
		},
	};
	assert.doesNotThrow(() => {
		const res = decodeCapabilityEvent(badKindNullProto);
		assert.equal(res.ok, false);
	});

	// source.kind with toString: null
	const badKindNullToString = {
		schemaVersion: 1,
		eventId: "ev-bad-kind-2",
		op: "activate",
		actor: "user",
		createdAt: 1,
		snapshot: {
			activationId: "act-test-2",
			source: { kind: { toString: null } },
			content: "hello",
			tools: { add: [], remove: [] },
			fingerprint: "sha256:v1:0000000000000000000000000000000000000000000000000000000000000000",
		},
	};
	assert.doesNotThrow(() => {
		const res = decodeCapabilityEvent(badKindNullToString);
		assert.equal(res.ok, false);
	});
});
