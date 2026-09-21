import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InstructionStateMutation, InstructionStateView } from "../src/instruction-state.ts";
import { createWebEditorHost, type WebHostRuntime } from "../src/web-host.ts";

function fakeCtx(cwd = "/fake/workspace", trusted = true): ExtensionContext {
	return {
		cwd,
		isProjectTrusted: () => trusted,
	} as unknown as ExtensionContext;
}

const sampleState: InstructionStateView = {
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

test("host.readInstructions delegates to runtime and does not infer or mutate state", () => {
	let readCalls = 0;
	let mutateCalls = 0;

	const runtime: WebHostRuntime = {
		readInstructions: () => {
			readCalls++;
			return { ok: true, state: sampleState };
		},
		mutateInstructions: () => {
			mutateCalls++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebHostRuntime;

	const host = createWebEditorHost(fakeCtx(), runtime);
	assert.equal(typeof host.readInstructions, "function");

	const result = host.readInstructions!();
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(result.state, sampleState);
	}
	assert.equal(readCalls, 1, "readInstructions must be called exactly once");
	assert.equal(mutateCalls, 0, "reading state must never infer or call mutate");
});

test("host returns 503 when runtime capability is missing (never pretends empty)", () => {
	const runtimeWithoutInstructions: WebHostRuntime = {} as WebHostRuntime;
	const host = createWebEditorHost(fakeCtx(), runtimeWithoutInstructions);

	assert.equal(typeof host.readInstructions, "function");
	assert.equal(typeof host.mutateInstructions, "function");

	const readResult = host.readInstructions!();
	assert.equal(readResult.ok, false);
	if (!readResult.ok) {
		assert.equal(readResult.status, 503);
		assert.match(readResult.error, /Instruction runtime is unavailable/);
	}

	const mutateResult = host.mutateInstructions!({
		action: "reset",
		guard: { sessionId: "s1", leafId: null, revision: "r1" },
	});
	assert.equal(mutateResult.ok, false);
	if (!mutateResult.ok) {
		assert.equal(mutateResult.status, 503);
		assert.match(mutateResult.error, /Instruction runtime is unavailable/);
	}
});

test("host.mutateInstructions forwards valid mutation and full guard without truncation", () => {
	let passedInput: unknown;
	const nextState: InstructionStateView = {
		...sampleState,
		guard: { sessionId: "session-alpha", leafId: "leaf-alpha", revision: "rev-2" },
		active: [],
	};

	const runtime: WebHostRuntime = {
		mutateInstructions: (input: unknown) => {
			passedInput = input;
			return { ok: true, state: nextState };
		},
	} as unknown as WebHostRuntime;

	const host = createWebEditorHost(fakeCtx(), runtime);
	const mutation: InstructionStateMutation = {
		action: "off",
		activationId: "act-alpha",
		guard: {
			sessionId: "session-alpha",
			leafId: "leaf-alpha",
			revision: "rev-1",
		},
	};

	const result = host.mutateInstructions!(mutation);
	assert.equal(result.ok, true);
	if (result.ok) {
		assert.deepEqual(result.state, nextState);
	}
	assert.deepEqual(passedInput, mutation, "Web layer must forward complete guard without truncation");
});

test("host.mutateInstructions refuses mutation in untrusted project (403)", () => {
	let mutateCalls = 0;
	const runtime: WebHostRuntime = {
		readInstructions: () => ({ ok: true, state: { ...sampleState, trusted: false } }),
		mutateInstructions: () => {
			mutateCalls++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebHostRuntime;

	const untrustedCtx = fakeCtx("/workspace", false);
	const host = createWebEditorHost(untrustedCtx, runtime);

	assert.equal(host.isProjectTrusted?.(), false);

	// Read is still allowed and reflects untrusted state
	const readResult = host.readInstructions!();
	assert.equal(readResult.ok, true);

	// Mutate must be rejected
	const mutateResult = host.mutateInstructions!({
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

test("host.mutateInstructions validates input using shared isInstructionStateMutation (400)", () => {
	let mutateCalls = 0;
	const runtime: WebHostRuntime = {
		mutateInstructions: () => {
			mutateCalls++;
			return { ok: true, state: sampleState };
		},
	} as unknown as WebHostRuntime;

	const host = createWebEditorHost(fakeCtx(), runtime);

	// Missing guard
	const bad1 = host.mutateInstructions!({ action: "reset" });
	assert.equal(bad1.ok, false);
	if (!bad1.ok) assert.equal(bad1.status, 400);

	// Unknown action
	const bad2 = host.mutateInstructions!({
		action: "arbitrary-use",
		guard: { sessionId: "s1", leafId: null, revision: "r1" },
	});
	assert.equal(bad2.ok, false);
	if (!bad2.ok) assert.equal(bad2.status, 400);

	// Extra fields
	const bad3 = host.mutateInstructions!({
		action: "reset",
		guard: { sessionId: "s1", leafId: null, revision: "r1" },
		maliciousField: "injection",
	});
	assert.equal(bad3.ok, false);
	if (!bad3.ok) assert.equal(bad3.status, 400);

	assert.equal(mutateCalls, 0, "invalid mutation payloads must not hit runtime");
});

test("host.mutateInstructions returns runtime 409 conflict as-is without retry", () => {
	let mutateCalls = 0;
	const runtime: WebHostRuntime = {
		mutateInstructions: () => {
			mutateCalls++;
			return {
				ok: false,
				status: 409,
				error: "Instruction state guard revision mismatch: expected rev-3, got rev-1.",
			};
		},
	} as unknown as WebHostRuntime;

	const host = createWebEditorHost(fakeCtx(), runtime);
	const mutation: InstructionStateMutation = {
		action: "reset",
		guard: { sessionId: "s1", leafId: null, revision: "rev-1" },
	};

	const result = host.mutateInstructions!(mutation);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.equal(result.status, 409);
		assert.match(result.error, /revision mismatch/);
	}
	assert.equal(mutateCalls, 1, "host must not retry on conflict");
});
