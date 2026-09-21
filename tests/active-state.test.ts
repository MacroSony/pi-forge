import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	FORGE_ACTIVE_STATE_CHANNEL,
	FORGE_ACTIVE_STATE_REQUEST_CHANNEL,
	ForgeActiveStatePublisher,
	activeStateProjectKey,
	validateActiveStateEvent,
	validateActiveStateRequest,
	type ActiveStateTransport,
	type ForgeActiveStateEvent,
	type ForgeActiveStateWorkspaceView,
} from "../src/active-state.ts";

class MemoryTransport implements ActiveStateTransport {
	readonly emitted: { channel: string; data: unknown }[] = [];
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	onEmit?: (channel: string, data: unknown) => void;

	emit(channel: string, data: unknown): void {
		this.emitted.push({ channel, data });
		this.onEmit?.(channel, data);
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
		set.add(handler);
		this.handlers.set(channel, set);
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			set.delete(handler);
		};
	}

	listenerCount(channel: string): number {
		return this.handlers.get(channel)?.size ?? 0;
	}

	events(): ForgeActiveStateEvent[] {
		return this.emitted
			.filter((entry) => entry.channel === FORGE_ACTIVE_STATE_CHANNEL)
			.map((entry) => entry.data as ForgeActiveStateEvent);
	}
}

function createPublisher(
	transport: MemoryTransport,
	readWorkspace: () => ForgeActiveStateWorkspaceView,
	instanceIds: string[] = ["instance-1", "instance-2", "instance-3"],
): ForgeActiveStatePublisher {
	let index = 0;
	return new ForgeActiveStatePublisher({
		transport,
		readWorkspace,
		hostname: "test-host",
		createInstanceId: () => instanceIds[index++] ?? `instance-${index}`,
	});
}

test("publishes monotonic revisions per instance and retires the instance on session switch", () => {
	const transport = new MemoryTransport();
	const view: ForgeActiveStateWorkspaceView = {
		stackKey: "project:alpha",
		profile: { profileId: "p", scope: "project", promptStack: "project:alpha" },
	};
	const publisher = createPublisher(transport, () => view);

	publisher.bindSession({ sessionId: "session-a", cwd: "/tmp/a" });
	publisher.publish();
	view.stackKey = "project:beta";
	publisher.publish();

	const first = transport.events();
	assert.equal(first.length, 3);
	assert.deepEqual(first.map((event) => event.revision), [1, 2, 3]);
	const instanceA = first[0]!.instanceId;
	assert.ok(first.every((event) => event.instanceId === instanceA));
	assert.ok(first.every((event) => event.sessionId === "session-a"));
	assert.equal(first[2]!.stackKey, "project:beta");
	assert.equal(first[2]!.profileKey, null);

	publisher.bindSession({ sessionId: "session-b", cwd: "/tmp/b" });
	const all = transport.events();
	const clear = all[3]!;
	assert.equal(clear.sessionId, "session-a");
	assert.equal(clear.instanceId, instanceA);
	assert.equal(clear.stackKey, null);
	assert.equal(clear.profileKey, null);
	assert.equal(clear.revision, 4);

	const second = all[4]!;
	assert.equal(second.sessionId, "session-b");
	assert.equal(second.instanceId, "instance-2");
	assert.equal(second.revision, 1);
	assert.equal(publisher.sessionId, "session-b");
	assert.equal(publisher.instanceId, "instance-2");
});

test("answers late snapshot requests only for the bound session and fails closed", () => {
	const transport = new MemoryTransport();
	const publisher = createPublisher(transport, () => ({ stackKey: "global:base" }));
	publisher.bindSession({ sessionId: "session-a", cwd: "/tmp/a" });
	const before = transport.events().length;

	// Omitted session id answers the current snapshot (late subscriber support).
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1" });
	assert.equal(transport.events().length, before + 1);
	assert.equal(transport.events().at(-1)!.revision, 1);
	assert.equal(transport.events().at(-1)!.stackKey, "global:base");

	// Matching session id answers.
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1", sessionId: "session-a" });
	assert.equal(transport.events().length, before + 2);

	// Wrong session id is ignored: an ephemeral child cannot become this Pet.
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1", sessionId: "session-b" });
	assert.equal(transport.events().length, before + 2);

	// Malformed and oversized requests fail closed without emitting.
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1", extra: true });
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "2" });
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1", sessionId: "x".repeat(5000) });
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, "not-an-object");
	assert.equal(transport.events().length, before + 2);
});

test("retains profile provenance only while the recorded prompt stack matches", () => {
	const transport = new MemoryTransport();
	const view: ForgeActiveStateWorkspaceView = {
		stackKey: "project:alpha",
		profile: { profileId: "p", scope: "project", promptStack: "project:alpha" },
	};
	const publisher = createPublisher(transport, () => view);
	publisher.bindSession({ sessionId: "session", cwd: "/tmp/a" });
	assert.equal(transport.events().at(-1)!.profileKey, "project:p");

	view.stackKey = "project:beta";
	publisher.publish();
	assert.equal(transport.events().at(-1)!.profileKey, null, "manual stack drift must not retain unrelated profile");

	view.stackKey = "project:alpha";
	publisher.publish();
	assert.equal(transport.events().at(-1)!.profileKey, "project:p");

	// Disabled equals disabled: a profile that disabled the stack still matches.
	view.stackKey = null;
	view.profile = { profileId: "p", scope: "project", promptStack: null };
	publisher.publish();
	assert.equal(transport.events().at(-1)!.profileKey, "project:p");

	view.stackKey = "global:base";
	publisher.publish();
	assert.equal(transport.events().at(-1)!.profileKey, null);

	view.profile = { profileId: "g", scope: "global", promptStack: "global:base" };
	publisher.publish();
	assert.equal(transport.events().at(-1)!.profileKey, "global:g");

	view.profile = { profileId: "bad id!", scope: "global", promptStack: "global:base" };
	publisher.publish();
	assert.equal(transport.events().at(-1)!.profileKey, null);
});

test("emits an opaque project key and only allowlisted scalar fields", () => {
	const transport = new MemoryTransport();
	const cwd = join(tmpdir(), "pi-forge-active-state-project");
	const view = {
		stackKey: "project:alpha",
		profile: { profileId: "p", scope: "project", promptStack: "project:alpha" },
		promptText: "SECRET-PROMPT",
		filePath: cwd,
		token: "SECRET-TOKEN",
	} as ForgeActiveStateWorkspaceView;
	const publisher = createPublisher(transport, () => view);
	publisher.bindSession({ sessionId: "session", cwd });

	const event = transport.events().at(-1)!;
	assert.deepEqual(
		Object.keys(event).sort(),
		["instanceId", "profileKey", "projectKey", "revision", "schemaVersion", "sessionId", "stackKey"],
	);
	const serialized = JSON.stringify(event);
	assert.doesNotMatch(serialized, /SECRET-PROMPT|SECRET-TOKEN/);
	assert.ok(!serialized.includes(cwd));
	assert.equal(event.projectKey, activeStateProjectKey(cwd, "test-host"));
	assert.match(event.projectKey!, /^[0-9a-f]{64}$/);

	// Same path is stable; different path or hostname is isolated.
	const otherCwd = join(tmpdir(), "pi-forge-active-state-other");
	assert.notEqual(activeStateProjectKey(cwd, "test-host"), activeStateProjectKey(otherCwd, "test-host"));
	assert.equal(activeStateProjectKey(cwd, "test-host"), activeStateProjectKey(cwd, "test-host"));
	assert.notEqual(activeStateProjectKey(cwd, "test-host"), activeStateProjectKey(cwd, "other-host"));
});

test("validators reject malformed, oversized, and unsafe payloads", () => {
	const base = {
		schemaVersion: "1",
		sessionId: "session",
		instanceId: "instance",
		revision: 1,
		stackKey: null,
		profileKey: null,
		projectKey: null,
	};
	assert.equal(validateActiveStateEvent(base).ok, true);
	assert.equal(validateActiveStateEvent({ ...base, projectKey: "a".repeat(64), stackKey: "project:alpha" }).ok, true);
	assert.equal(validateActiveStateEvent({ ...base, stackKey: "project:alpha" }).ok, false);
	assert.equal(validateActiveStateEvent({ ...base, profileKey: "project:alpha" }).ok, false);
	assert.equal(validateActiveStateEvent({ ...base, stackKey: "project:has space" }).ok, false);
	assert.equal(validateActiveStateEvent({ ...base, projectKey: "zz" }).ok, false);
	assert.equal(validateActiveStateEvent({ ...base, revision: -1 }).ok, false);
	assert.equal(validateActiveStateEvent({ ...base, revision: 1.5 }).ok, false);
	assert.equal(validateActiveStateEvent({ ...base, extra: 1 }).ok, false);
	assert.equal(validateActiveStateEvent({ ...base, sessionId: "x".repeat(2000) }).ok, false);

	assert.equal(validateActiveStateRequest({ schemaVersion: "1" }).ok, true);
	assert.equal(validateActiveStateRequest({ schemaVersion: "1", sessionId: "session" }).ok, true);
	assert.equal(validateActiveStateRequest({ schemaVersion: "1", sessionId: "x".repeat(2000) }).ok, false);
	assert.equal(validateActiveStateRequest({ schemaVersion: "2" }).ok, false);
	assert.equal(validateActiveStateRequest({ schemaVersion: "1", extra: true }).ok, false);
});

test("disposal emits a clear snapshot, unregisters, and is idempotent", () => {
	const transport = new MemoryTransport();
	const publisher = createPublisher(transport, () => ({ stackKey: "global:base" }));
	publisher.bindSession({ sessionId: "session", cwd: "/tmp/a" });
	assert.equal(transport.listenerCount(FORGE_ACTIVE_STATE_REQUEST_CHANNEL), 1);

	publisher.dispose();
	assert.equal(transport.listenerCount(FORGE_ACTIVE_STATE_REQUEST_CHANNEL), 0);
	const cleared = transport.events().at(-1)!;
	assert.equal(cleared.sessionId, "session");
	assert.equal(cleared.stackKey, null);
	assert.equal(cleared.profileKey, null);
	assert.equal(publisher.attached, false);

	const count = transport.events().length;
	publisher.dispose();
	assert.equal(transport.events().length, count);
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1" });
	assert.equal(transport.events().length, count);
});

test("a throwing workspace read fails closed to clear fields without throwing", () => {
	const transport = new MemoryTransport();
	const publisher = createPublisher(transport, () => {
		throw new Error("workspace unavailable");
	});
	publisher.bindSession({ sessionId: "session", cwd: "/tmp/a" });
	const event = transport.events().at(-1)!;
	assert.equal(event.stackKey, null);
	assert.equal(event.profileKey, null);
	assert.match(event.projectKey!, /^[0-9a-f]{64}$/);
});

test("empty cwd fails closed for project-scoped bindings and profile provenance", () => {
	const transport = new MemoryTransport();
	const view: ForgeActiveStateWorkspaceView = {
		stackKey: "project:alpha",
		profile: { profileId: "p", scope: "project", promptStack: "project:alpha" },
	};
	const publisher = createPublisher(transport, () => view);
	publisher.bindSession({ sessionId: "session", cwd: "" });
	const event = transport.events().at(-1)!;
	assert.equal(event.projectKey, null);
	assert.equal(event.stackKey, null);
	assert.equal(event.profileKey, null);
	// The publisher must never emit a snapshot its own validator rejects.
	assert.equal(validateActiveStateEvent(event).ok, true);

	// A global profile that merely disabled the stack must not be reported as
	// compatible when the effective project stack was dropped for lack of a key.
	view.profile = { profileId: "g", scope: "global", promptStack: null };
	publisher.publish();
	const dropped = transport.events().at(-1)!;
	assert.equal(dropped.stackKey, null);
	assert.equal(dropped.profileKey, null);
	assert.equal(validateActiveStateEvent(dropped).ok, true);
});

test("instance id validator rejects control characters, paths, and oversized values", () => {
	const base = { schemaVersion: "1", sessionId: "session", instanceId: "uuid-1", revision: 1, stackKey: null, profileKey: null, projectKey: null };
	assert.equal(validateActiveStateEvent(base).ok, true);
	assert.equal(validateActiveStateEvent({ ...base, instanceId: "a".repeat(128) }).ok, true);
	assert.equal(validateActiveStateEvent({ ...base, instanceId: "a".repeat(129) }).ok, false);
	for (const bad of ["a/b", "a\\b", "a b", "a.b", "a:b", "a\nb", "a\0b", "", "  ", "../x", "a=b"]) {
		assert.equal(validateActiveStateEvent({ ...base, instanceId: bad }).ok, false, `instanceId ${JSON.stringify(bad)} must be rejected`);
	}
});

test("rotates the publisher instance epoch at the safe-integer revision boundary", () => {
	const transport = new MemoryTransport();
	const publisher = createPublisher(transport, () => ({ stackKey: "global:base" }), ["epoch-1", "epoch-2"]);
	publisher.bindSession({ sessionId: "session", cwd: "/tmp/a" });
	(publisher as unknown as { revisionValue: number }).revisionValue = Number.MAX_SAFE_INTEGER;
	publisher.publish();

	const events = transport.events();
	const bound = events.at(-2)!;
	const rotated = events.at(-1)!;
	assert.equal(bound.instanceId, "epoch-1");
	assert.equal(rotated.instanceId, "epoch-2");
	assert.equal(rotated.revision, 1);
	assert.notEqual(rotated.instanceId, bound.instanceId);
});

test("suspension suppresses publishes and request replies until bind resumes", () => {
	const transport = new MemoryTransport();
	const view: ForgeActiveStateWorkspaceView = { stackKey: "global:base" };
	const publisher = createPublisher(transport, () => view);
	publisher.bindSession({ sessionId: "session", cwd: "/tmp/a" });
	const before = transport.events().length;

	publisher.suspend();
	publisher.publish();
	view.stackKey = "global:next";
	publisher.publish();
	transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1" });
	assert.equal(transport.events().length, before, "suspended publisher must not answer or publish");

	publisher.bindSession({ sessionId: "session", cwd: "/tmp/a" });
	assert.equal(transport.events().length, before + 1);
	assert.equal(transport.events().at(-1)!.stackKey, "global:next");
});

test("clear publication is reentrancy-safe across switch, dispose, and invalid sessions", () => {
	type Scenario = {
		name: string;
		operation: (publisher: ForgeActiveStatePublisher) => void;
		expectedSessions: string[];
	};
	const scenarios: Scenario[] = [
		{
			name: "switch",
			operation: (publisher) => publisher.bindSession({ sessionId: "session-b", cwd: "/tmp/b" }),
			expectedSessions: ["session-a", "session-a", "session-b"],
		},
		{
			name: "dispose",
			operation: (publisher) => publisher.dispose(),
			expectedSessions: ["session-a", "session-a"],
		},
		{
			name: "invalid session",
			operation: (publisher) => publisher.bindSession({ sessionId: "", cwd: "/tmp/b" }),
			expectedSessions: ["session-a", "session-a"],
		},
	];

	for (const scenario of scenarios) {
		test(`reentrant clear: ${scenario.name}`, () => {
			const transport = new MemoryTransport();
			const publisher = createPublisher(transport, () => ({ stackKey: "global:base" }));
			publisher.bindSession({ sessionId: "session-a", cwd: "/tmp/a" });
			let reentered = false;
			transport.onEmit = (channel, data) => {
				const event = data as ForgeActiveStateEvent;
				if (reentered || channel !== FORGE_ACTIVE_STATE_CHANNEL || event.stackKey !== null) return;
				reentered = true;
				// All of these can happen synchronously in a downstream clear callback.
				transport.emit(FORGE_ACTIVE_STATE_REQUEST_CHANNEL, { schemaVersion: "1" });
				publisher.publish();
				publisher.dispose();
			};

			scenario.operation(publisher);

			const events = transport.events();
			assert.deepEqual(events.map((event) => event.sessionId), scenario.expectedSessions);
			assert.deepEqual(events.map((event) => event.stackKey), ["global:base", null, ...(scenario.name === "switch" ? ["global:base"] : [])]);
			assert.equal(events.filter((event) => event.stackKey === null).length, 1);
		});
	}
});

test("throwing transport emit/on/unsubscribe never breaks publisher lifecycle", () => {
	const throwing: ActiveStateTransport = {
		emit() { throw new Error("emit boom"); },
		on() { throw new Error("on boom"); },
	};
	const publisher = new ForgeActiveStatePublisher({
		transport: throwing,
		readWorkspace: () => ({ stackKey: "global:base" }),
		hostname: "test-host",
		createInstanceId: () => "uuid-1",
	});
	assert.doesNotThrow(() => publisher.bindSession({ sessionId: "session", cwd: "/tmp/a" }));
	assert.doesNotThrow(() => publisher.publish());
	assert.doesNotThrow(() => publisher.dispose());

	const unsubscribeThrows: ActiveStateTransport = {
		emit() {},
		on() { return () => { throw new Error("unsubscribe boom"); }; },
	};
	const publisher2 = new ForgeActiveStatePublisher({
		transport: unsubscribeThrows,
		readWorkspace: () => ({ stackKey: "global:base" }),
		hostname: "test-host",
		createInstanceId: () => "uuid-1",
	});
	assert.doesNotThrow(() => publisher2.bindSession({ sessionId: "session", cwd: "/tmp/a" }));
	assert.doesNotThrow(() => publisher2.dispose());
});
