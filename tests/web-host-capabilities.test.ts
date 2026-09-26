import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapabilityStateMutation, CapabilityStateView } from "../src/capability-state.ts";
import { createWebEditorHost, type WebHostRuntime } from "../src/web-host.ts";

function fakeCtx(cwd = "/fake/workspace", trusted = true): ExtensionContext {
	return {
		cwd,
		isProjectTrusted: () => trusted,
	} as unknown as ExtensionContext;
}

const sampleState: CapabilityStateView = {
	guard: {
		sessionId: "session-alpha",
		leafId: "leaf-alpha",
		revision: "rev-1",
	},
	trusted: true,
	restoring: false,
	delivery: "prepared",
	textPresentation: "native",
	effectiveTools: ["read_file", "write_file"],
	active: [
		{
			activationId: "act-alpha",
			source: "mode:test",
			name: "Test Mode",
			actor: "user",
			content: "Test instruction content",
			tools: { add: [], remove: [] },
		},
	],
};

test("host.readCapabilityState delegates to runtime and does not infer or mutate state", () => {
	let readCalls = 0;
	let mutateCalls = 0;

	const runtime: WebHostRuntime = {
		readCapabilityState: () => {
			readCalls++;
			return { ok: true, state: sampleState };
		},
		mutateCapabilityState: () => {
			mutateCalls++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebHostRuntime;

	const host = createWebEditorHost(fakeCtx(), runtime);
	assert.equal(typeof host.readCapabilityState, "function");

	const result = host.readCapabilityState!();
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(result.state, sampleState);
	}
	assert.equal(readCalls, 1, "readCapabilityState must be called exactly once");
	assert.equal(mutateCalls, 0, "reading state must never infer or call mutate");
});

test("host returns 503 when runtime capability is missing (never pretends empty)", () => {
	const runtimeWithoutCapabilities: WebHostRuntime = {} as WebHostRuntime;
	const host = createWebEditorHost(fakeCtx(), runtimeWithoutCapabilities);

	assert.equal(typeof host.readCapabilityState, "function");
	assert.equal(typeof host.mutateCapabilityState, "function");

	const readResult = host.readCapabilityState!();
	assert.equal(readResult.ok, false);
	if (!readResult.ok) {
		assert.equal(readResult.status, 503);
		assert.match(readResult.error, /Capability runtime is unavailable/);
	}

	const mutateResult = host.mutateCapabilityState!({
		action: "reset",
		guard: { sessionId: "s1", leafId: null, revision: "r1" },
	});
	assert.equal(mutateResult.ok, false);
	if (!mutateResult.ok) {
		assert.equal(mutateResult.status, 503);
		assert.match(mutateResult.error, /Capability runtime is unavailable/);
	}
});

test("host.mutateCapabilityState forwards valid mutation and full guard without truncation", () => {
	let passedInput: unknown;
	const nextState: CapabilityStateView = {
		...sampleState,
		guard: { sessionId: "session-alpha", leafId: "leaf-alpha", revision: "rev-2" },
		active: [],
	};

	const runtime: WebHostRuntime = {
		mutateCapabilityState: (input: unknown) => {
			passedInput = input;
			return { ok: true, state: nextState };
		},
	} as unknown as WebHostRuntime;

	const host = createWebEditorHost(fakeCtx(), runtime);
	const mutation: CapabilityStateMutation = {
		action: "disable",
		activationId: "act-alpha",
		guard: {
			sessionId: "session-alpha",
			leafId: "leaf-alpha",
			revision: "rev-1",
		},
	};

	const result = host.mutateCapabilityState!(mutation);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(result.state, nextState);
	}
	assert.deepEqual(passedInput, mutation, "Web layer must forward complete guard without truncation");
});

test("host.mutateCapabilityState refuses mutation in untrusted project (403)", () => {
	let mutateCalls = 0;
	const runtime: WebHostRuntime = {
		readCapabilityState: () => ({ ok: true, state: { ...sampleState, trusted: false } }),
		mutateCapabilityState: () => {
			mutateCalls++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebHostRuntime;

	const untrustedCtx = fakeCtx("/workspace", false);
	const host = createWebEditorHost(untrustedCtx, runtime);

	assert.equal(host.isProjectTrusted?.(), false);

	// Read is still allowed and reflects untrusted state
	const readResult = host.readCapabilityState!();
	assert.equal(readResult.ok, true);

	// Mutate must be rejected
	const mutateResult = host.mutateCapabilityState!({
		action: "reset",
		guard: { sessionId: "session-alpha", leafId: null, revision: "rev-1" },
	});
	assert.equal(mutateResult.ok, false);
	if (!mutateResult.ok) {
		assert.equal(mutateResult.status, 403);
		assert.match(mutateResult.error, /Project is not trusted/);
	}
	assert.equal(mutateCalls, 0, "runtime mutate must not be called when project is untrusted");
});

test("host.mutateCapabilityState validates input using shared isCapabilityStateMutation (400)", () => {
	let mutateCalls = 0;
	const runtime: WebHostRuntime = {
		mutateCapabilityState: () => {
			mutateCalls++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebHostRuntime;

	const host = createWebEditorHost(fakeCtx(), runtime);

	// Missing guard
	const bad1 = host.mutateCapabilityState!({ action: "reset" });
	assert.equal(bad1.ok, false);
	if (!bad1.ok) assert.equal(bad1.status, 400);

	// Unknown action
	const bad2 = host.mutateCapabilityState!({
		action: "arbitrary-use",
		guard: { sessionId: "s1", leafId: null, revision: "r1" },
	});
	assert.equal(bad2.ok, false);
	if (!bad2.ok) assert.equal(bad2.status, 400);

	// Extra fields
	const bad3 = host.mutateCapabilityState!({
		action: "reset",
		guard: { sessionId: "s1", leafId: null, revision: "r1" },
		maliciousField: "injection",
	});
	assert.equal(bad3.ok, false);
	if (!bad3.ok) assert.equal(bad3.status, 400);

	assert.equal(mutateCalls, 0, "invalid mutation payloads must not hit runtime");
});

test("host.mutateCapabilityState returns runtime 409 conflict as-is without retry", () => {
	let mutateCalls = 0;
	const runtime: WebHostRuntime = {
		mutateCapabilityState: () => {
			mutateCalls++;
			return {
				ok: false,
				status: 409,
				error: "Capability state guard revision mismatch: expected rev-3, got rev-1.",
			};
		},
	} as unknown as WebHostRuntime;

	const host = createWebEditorHost(fakeCtx(), runtime);
	const mutation: CapabilityStateMutation = {
		action: "reset",
		guard: { sessionId: "s1", leafId: null, revision: "rev-1" },
	};

	const result = host.mutateCapabilityState!(mutation);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.status, 409);
		assert.match(result.error, /revision mismatch/);
	}
	assert.equal(mutateCalls, 1, "host must not retry on conflict");
});
