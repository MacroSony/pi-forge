import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FORGE_ACTIVE_STATE_CHANNEL,
	FORGE_ACTIVE_STATE_REQUEST_CHANNEL,
	type ForgeActiveStateEvent,
} from "../src/active-state.ts";
import { createContext, createHarness, startSession, writeStack } from "./helpers/index-command-harness.ts";

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-forge-active-state-"));
}

test("real lifecycle publishes, rebinds, queries, and clears active-state over the bus", async () => {
	const cwd = tempCwd();
	writeStack(cwd, "alpha.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "alpha",
		autoActivate: true,
		items: [],
	});
	writeStack(cwd, "beta.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "beta",
		items: [],
	});

	const harness = createHarness();
	const { ctx } = createContext(cwd, [], { trusted: true });
	const events: ForgeActiveStateEvent[] = [];
	harness.eventsBus.on(FORGE_ACTIVE_STATE_CHANNEL, (data) => events.push(data as ForgeActiveStateEvent));

	await startSession(harness, ctx);
	assert.ok(events.length >= 1, "session start must publish an active-state snapshot");
	const started = events.at(-1)!;
	assert.equal(started.schemaVersion, "1");
	assert.equal(started.sessionId, "test-session");
	assert.equal(started.stackKey, "project:alpha");
	assert.equal(started.profileKey, null);
	assert.match(started.projectKey!, /^[0-9a-f]{64}$/);
	const instanceId = started.instanceId;

	// Explicit preset changes publish on the same live instance.
	await harness.commands.preset.handler("use beta", ctx);
	const switched = events.at(-1)!;
	assert.equal(switched.stackKey, "project:beta");
	assert.equal(switched.sessionId, "test-session");
	assert.equal(switched.instanceId, instanceId);
	assert.ok(switched.revision > started.revision);

	// Late subscriber snapshot query (no session id) answers with current state.
	const beforeQuery = events.length;
	harness.eventsBus.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1" });
	assert.equal(events.length, beforeQuery + 1);
	assert.deepEqual(events.at(-1), switched);

	// A wrong-session query is ignored.
	harness.eventsBus.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1", sessionId: "some-child" });
	assert.equal(events.length, beforeQuery + 1);

	// Shutdown clears context and unregisters the request listener.
	await harness.events.session_shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
	const cleared = events.at(-1)!;
	assert.equal(cleared.sessionId, "test-session");
	assert.equal(cleared.stackKey, null);
	assert.equal(cleared.profileKey, null);
	assert.ok(cleared.revision > switched.revision);
	assert.equal(harness.eventsBus.handlers.get(FORGE_ACTIVE_STATE_REQUEST_CHANNEL)?.size ?? 0, 0);
});

test("session change without prior shutdown never leaks new workspace under the old session id", async () => {
	const cwd = tempCwd();
	writeStack(cwd, "alpha.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "alpha",
		autoActivate: true,
		items: [],
	});
	writeStack(cwd, "beta.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "beta",
		items: [],
	});

	const harness = createHarness();
	const { ctx } = createContext(cwd, [], { trusted: true });
	const events: ForgeActiveStateEvent[] = [];
	harness.eventsBus.on(FORGE_ACTIVE_STATE_CHANNEL, (data) => events.push(data as ForgeActiveStateEvent));
	await startSession(harness, ctx);

	const oldInstance = events.at(-1)!.instanceId;
	assert.equal(events.at(-1)!.sessionId, "test-session");

	const beforeSwitch = events.length;
	const ctxB = createContext(cwd, [], { trusted: true }).ctx;
	ctxB.sessionManager.getSessionId = () => "session-b";
	const startB = harness.events.session_start!({ type: "session_start", reason: "startup" }, ctxB);
	// Query the snapshot while the restore is still in flight. It must not be
	// answered with the old binding or an intermediate workspace snapshot.
	harness.eventsBus.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1" });
	await startB;

	const switched = events.slice(beforeSwitch);
	assert.equal(
		switched.length,
		2,
		`expected exactly one clear + one rebind, got ${switched.map((event) => `${event.sessionId}:${event.stackKey}:${event.revision}`).join(", ")}`,
	);
	assert.equal(switched[0]!.sessionId, "test-session");
	assert.equal(switched[0]!.stackKey, null);
	assert.equal(switched[0]!.profileKey, null);
	assert.equal(switched[0]!.instanceId, oldInstance);
	assert.equal(switched[1]!.sessionId, "session-b");
	assert.equal(switched[1]!.stackKey, "project:alpha");
	assert.notEqual(switched[1]!.instanceId, oldInstance);
	// No intermediate snapshot may carry the new workspace under the old session.
	assert.ok(switched.every((event) => !(event.sessionId === "test-session" && event.stackKey !== null)));

	// Once restoration completes, a late query answers from the latest complete
	// snapshot and repeats the current revision.
	const completed = switched[1]!;
	const beforeQuery = events.length;
	harness.eventsBus.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1" });
	assert.equal(events.length, beforeQuery + 1);
	assert.deepEqual(events.at(-1), completed);
});

test("session_compact preserves the live instance epoch and does not clear cosmetic state", async () => {
	const cwd = tempCwd();
	writeStack(cwd, "alpha.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "alpha",
		autoActivate: true,
		items: [],
	});

	const harness = createHarness();
	const { ctx } = createContext(cwd, [], { trusted: true });
	const events: ForgeActiveStateEvent[] = [];
	harness.eventsBus.on(FORGE_ACTIVE_STATE_CHANNEL, (data) => events.push(data as ForgeActiveStateEvent));
	await startSession(harness, ctx);

	const instance = events.at(-1)!.instanceId;
	const revision = events.at(-1)!.revision;
	const before = events.length;

	await harness.events.session_compact!({ type: "session_compact", reason: "compact" }, ctx);

	const compacted = events.slice(before);
	assert.equal(compacted.length, 1);
	assert.equal(compacted[0]!.instanceId, instance, "compaction must not recreate the cosmetic epoch");
	assert.ok(compacted[0]!.revision > revision, "compaction must publish a fresh monotonic revision");
	assert.equal(compacted[0]!.sessionId, "test-session");
	assert.equal(compacted[0]!.stackKey, "project:alpha");
});

test("restoration failure detaches and clears instead of retaining a stale binding", async () => {
	const cwd = tempCwd();
	writeStack(cwd, "alpha.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "alpha",
		autoActivate: true,
		items: [],
	});

	const harness = createHarness();
	const { ctx } = createContext(cwd, [], { trusted: true });
	const events: ForgeActiveStateEvent[] = [];
	harness.eventsBus.on(FORGE_ACTIVE_STATE_CHANNEL, (data) => events.push(data as ForgeActiveStateEvent));
	await startSession(harness, ctx);

	const boundInstance = events.at(-1)!.instanceId;
	const beforeFailure = events.length;

	const ctxB = createContext(cwd, [], { trusted: true }).ctx;
	ctxB.sessionManager.getSessionId = () => "session-b";
	ctxB.isProjectTrusted = () => {
		throw new Error("trusted check boom");
	};

	await assert.rejects(
		harness.events.session_start!({ type: "session_start", reason: "startup" }, ctxB),
		/trusted check boom/,
	);

	const afterFailure = events.slice(beforeFailure);
	assert.equal(afterFailure.length, 1);
	assert.equal(afterFailure[0]!.sessionId, "test-session");
	assert.equal(afterFailure[0]!.stackKey, null);
	assert.equal(afterFailure[0]!.profileKey, null);
	assert.equal(afterFailure[0]!.instanceId, boundInstance);
	// The failed restore must not leave a session-b request listener behind.
	assert.equal(harness.eventsBus.handlers.get(FORGE_ACTIVE_STATE_REQUEST_CHANNEL)?.size ?? 0, 0);
});

test("throwing bus does not prevent shutdown tool-policy restoration or teardown", async () => {
	const cwd = tempCwd();
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
		type: "pi-forge.prompt-stack",
		id: "default",
		tools: { allow: ["read"] },
		items: [],
	});
	const baselineTools = ["read", "bash", "edit", "write"];
	const harness = createHarness({ activeTools: baselineTools });
	const { ctx } = createContext(cwd);
	await startSession(harness, ctx);
	assert.deepEqual(harness.getActiveTools(), ["read"]);

	// The optional active-state transport turns hostile after startup. Its
	// failures must not skip tool-policy restoration or workspace teardown.
	harness.eventsBus.emit = () => {
		throw new Error("emit boom");
	};
	harness.eventsBus.on = () => {
		throw new Error("on boom");
	};

	// The bus error may surface, but every teardown step must still complete.
	await assert.rejects(
		harness.events.session_shutdown!({ type: "session_shutdown", reason: "reload" }, ctx),
		/emit boom/,
	);
	assert.deepEqual(harness.getActiveTools(), baselineTools, "tool-policy restoration must run despite the throwing bus");
});
