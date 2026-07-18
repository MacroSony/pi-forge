import assert from "node:assert/strict";
import test from "node:test";

import {
	SubagentBackendRegistryError,
} from "../src/subagent/backend-registry.ts";
import {
	hasSubagentErrors,
	isProtectedSubagentTaskPreserved,
	subagentExecutionFingerprint,
	validateAgentResponse,
	validateBackendPreflight,
} from "../src/subagent-contract.ts";
import {
	DeterministicFakeSubagentBackend,
	FAKE_DIGEST,
	createFakeExecutionPlan,
	deterministicRegistry,
	fakePromptRuntime,
	fakeRequest,
	fakeSnapshot,
} from "./helpers/fake-subagent-backend.ts";

test("backend registry has no default backend and owns validated registration lifecycle", () => {
	const registry = deterministicRegistry();
	assert.equal(registry.size, 0);
	assert.deepEqual(registry.descriptors(), []);
	const backend = new DeterministicFakeSubagentBackend();
	const unregister = registry.register(backend);
	assert.equal(registry.size, 1);
	assert.deepEqual(registry.descriptors().map((descriptor) => descriptor.id), ["fake-backend"]);
	assert.throws(() => registry.register(backend), (error: unknown) => registryError(error, "backend.duplicate"));
	assert.equal(unregister(), true);
	assert.equal(unregister(), false);
	assert.throws(
		() => registry.register({ descriptor: { id: "bad" } } as any),
		(error: unknown) => registryError(error, "backend.methods"),
	);
});

test("registry preflight accepts complete media/access/limit receipts and rejects dishonest backends", async () => {
	const registry = deterministicRegistry();
	const backend = new DeterministicFakeSubagentBackend();
	registry.register(backend);
	const request = fakeRequest({
		input: { text: "Inspect image", media: [{ id: "image-1", kind: "image", mimeType: "image/png", digest: FAKE_DIGEST, resourceHandle: "media-1" }] },
		access: {
			level: "workspace-write",
			workspaces: [{ handle: "workspace", mode: "read-write" }],
			workingDirectory: { workspaceHandle: "workspace", path: "src" },
			network: "allow",
			allowProcess: true,
		},
		limits: {
			timeoutMs: { value: 500, enforcement: "required" },
			maxTurns: { value: 3, enforcement: "required" },
			tokenBudget: { value: 2_000, enforcement: "required" },
			maxOutputBytes: { value: 8_000, enforcement: "required" },
		},
	});
	const accepted = await registry.preflight(backend.descriptor.id, request, fakeSnapshot());
	assert.equal(accepted.status, "accepted");
	assert.deepEqual(validateBackendPreflight(accepted, request, fakeSnapshot()), []);

	backend.preflightMode = "omit-limits";
	const missingLimits = await registry.preflight(backend.descriptor.id, request, fakeSnapshot());
	assert.equal(missingLimits.status, "rejected");
	assert.ok(missingLimits.diagnostics.some((item) => item.code === "preflight.limit-missing"));

	backend.preflightMode = "under-enforced-access";
	const readOnlyRequest = fakeRequest({
		requestId: "request-read-only",
		access: { level: "read-only", workspaces: [{ handle: "workspace", mode: "read-only" }], network: "deny" },
	});
	const underEnforced = await registry.preflight(backend.descriptor.id, readOnlyRequest, fakeSnapshot());
	assert.equal(underEnforced.status, "rejected");
	assert.ok(underEnforced.diagnostics.some((item) => item.code === "preflight.read-isolation"));

	backend.preflightMode = "mismatched-descriptor";
	const mismatch = await registry.preflight(backend.descriptor.id, fakeRequest({ requestId: "request-mismatch" }), fakeSnapshot());
	assert.equal(mismatch.status, "rejected");
	assert.ok(mismatch.diagnostics.some((item) => item.code === "preflight.backend-identity"));

	backend.preflightMode = "rejected";
	const refused = await registry.preflight(backend.descriptor.id, fakeRequest({ requestId: "request-refused" }), fakeSnapshot());
	assert.equal(refused.status, "rejected");
	assert.equal(hasSubagentErrors(refused.diagnostics), true);

	const remoteRegistry = deterministicRegistry();
	const remoteBackend = new DeterministicFakeSubagentBackend({ id: "remote-backend", remoteTransport: true });
	remoteRegistry.register(remoteBackend);
	const withoutConsent = await remoteRegistry.preflight(remoteBackend.descriptor.id, fakeRequest({ requestId: "request-no-egress" }), fakeSnapshot());
	assert.equal(withoutConsent.status, "rejected");
	assert.ok(withoutConsent.diagnostics.some((item) => item.code === "preflight.egress"));
	const withConsent = await remoteRegistry.preflight(remoteBackend.descriptor.id, fakeRequest({ requestId: "request-egress", remoteEgressConsent: true }), fakeSnapshot());
	assert.equal(withConsent.status, "accepted");
});

test("registry preparation supports exact and backend-assisted prompt runtimes", async () => {
	for (const fidelity of ["exact-preflight", "backend-assisted"] as const) {
		const registry = deterministicRegistry();
		const backend = new DeterministicFakeSubagentBackend({ fidelity });
		registry.register(backend);
		const result = await createFakeExecutionPlan({ registry, backend, runId: `run-${fidelity}` });
		assert.equal(result.plan.preflight.backend.capabilities.promptRuntimeFidelity, fidelity);
		assert.equal(isProtectedSubagentTaskPreserved(result.plan.messages, result.request.input), true);
		assert.deepEqual(result.plan.effectiveToolIds, ["tool.echo"]);
		assert.equal(backend.preparationCalls.length, fidelity === "backend-assisted" ? 1 : 0);
	}
});

test("backend-assisted preparation cannot bypass or alter the host compiler", async () => {
	const bypassRegistry = deterministicRegistry();
	const bypassBackend = new DeterministicFakeSubagentBackend();
	bypassBackend.prepare = async () => ({
		runtime: fakePromptRuntime(),
		preparation: {
			systemPrompt: "backend-authored",
			messages: [],
			toolNegotiation: { effectiveToolIds: [], effectiveToolNames: [], stackSelectedToolNames: [], unmatchedAllowPatterns: [], diagnostics: [] },
			diagnostics: [],
		},
	});
	bypassRegistry.register(bypassBackend);
	const bypassRequest = fakeRequest();
	const bypassSnapshot = fakeSnapshot();
	const bypassPreflight = await bypassRegistry.preflight(bypassBackend.descriptor.id, bypassRequest, bypassSnapshot);
	assert.equal(bypassPreflight.status, "accepted");
	await assert.rejects(
		() => bypassRegistry.prepare(
			bypassBackend.descriptor.id,
			{ request: bypassRequest, snapshot: bypassSnapshot, preflight: bypassPreflight },
			() => { throw new Error("host preparer should not be reached"); },
		),
		(error: unknown) => registryError(error, "preparation.host-bypass"),
	);

	const mismatchRegistry = deterministicRegistry();
	const mismatchBackend = new DeterministicFakeSubagentBackend();
	mismatchBackend.prepare = async (_input, context) => {
		const result = await context.prepare(fakePromptRuntime());
		return { ...result, preparation: { ...result.preparation, systemPrompt: "backend-tampered" } };
	};
	mismatchRegistry.register(mismatchBackend);
	const mismatchRequest = fakeRequest({ requestId: "request-host-mismatch" });
	const mismatchSnapshot = fakeSnapshot();
	const mismatchPreflight = await mismatchRegistry.preflight(mismatchBackend.descriptor.id, mismatchRequest, mismatchSnapshot);
	assert.equal(mismatchPreflight.status, "accepted");
	await assert.rejects(
		() => mismatchRegistry.prepare(
			mismatchBackend.descriptor.id,
			{ request: mismatchRequest, snapshot: mismatchSnapshot, preflight: mismatchPreflight },
			() => ({
				systemPrompt: "host-compiled",
				messages: [],
				toolNegotiation: { effectiveToolIds: [], effectiveToolNames: [], stackSelectedToolNames: [], unmatchedAllowPatterns: [], diagnostics: [] },
				diagnostics: [],
			}),
		),
		(error: unknown) => registryError(error, "preparation.host-mismatch"),
	);
});

test("registry planning applies declared tool effects after stack policy", async () => {
	const registry = deterministicRegistry();
	const backend = new DeterministicFakeSubagentBackend();
	registry.register(backend);
	const readNetworkRequest = fakeRequest({
		requestId: "request-read-network",
		access: {
			level: "read-only",
			workspaces: [{ handle: "workspace", mode: "read-only" }],
			network: "allow",
		},
	});
	const readPlan = await createFakeExecutionPlan({ registry, backend, request: readNetworkRequest, runId: "run-read-network" });
	assert.deepEqual(readPlan.plan.effectiveToolIds, ["tool.echo", "tool.read", "tool.web"]);

	const fullRequest = fakeRequest({
		requestId: "request-full-access",
		access: {
			level: "workspace-write",
			workspaces: [{ handle: "workspace", mode: "read-write" }],
			network: "allow",
			allowProcess: true,
		},
	});
	const fullPlan = await createFakeExecutionPlan({ registry, backend, request: fullRequest, runId: "run-full-access" });
	assert.deepEqual(fullPlan.plan.effectiveToolIds, ["tool.echo", "tool.read", "tool.write", "tool.shell", "tool.web"]);
});

test("registry executes a valid plan and preserves explicit backend failures", async () => {
	for (const mode of ["completed", "failed"] as const) {
		const registry = deterministicRegistry();
		const backend = new DeterministicFakeSubagentBackend();
		backend.executionMode = mode;
		registry.register(backend);
		const { plan } = await createFakeExecutionPlan({ registry, backend, runId: `run-${mode}` });
		const response = await registry.execute(plan, { authorizationScope: "session.main" });
		assert.equal(response.status, mode);
		assert.deepEqual(validateAgentResponse(response, { plan }), []);
		assert.equal(response.durationMs < 999, true, "registry should replace backend-reported duration");
	}
});

test("registry normalizes provider exceptions and malformed responses", async () => {
	for (const mode of ["throw", "invalid"] as const) {
		const registry = deterministicRegistry();
		const backend = new DeterministicFakeSubagentBackend();
		backend.executionMode = mode;
		registry.register(backend);
		const { plan } = await createFakeExecutionPlan({ registry, backend, runId: `run-${mode}` });
		const response = await registry.execute(plan, { authorizationScope: "session.main" });
		assert.equal(response.status, "failed");
		assert.deepEqual(validateAgentResponse(response, { plan }), []);
		if (response.status === "failed") {
			assert.equal(response.error.code, mode === "throw" ? "backend-execution" : "backend-invalid-response");
		}
	}
});

test("user cancellation wins the completion race and drains before unregister", async () => {
	const registry = deterministicRegistry();
	const backend = new DeterministicFakeSubagentBackend();
	backend.executionMode = "delayed";
	registry.register(backend);
	const { plan } = await createFakeExecutionPlan({ registry, backend, runId: "run-cancel" });
	const execution = registry.execute(plan, { authorizationScope: "session.main" });
	await backend.executionStarted;
	assert.equal(await registry.cancel(plan.runId, "user requested cancellation"), true);
	const response = await execution;
	assert.equal(response.status, "cancelled");
	assert.deepEqual(validateAgentResponse(response, { plan }), []);
	assert.deepEqual(backend.cancelCalls, [{ runId: plan.runId, reason: "user requested cancellation" }]);
	assert.equal(await registry.cancel(plan.runId), false);
	assert.throws(() => registry.unregister(backend.descriptor.id), (error: unknown) => registryError(error, "backend.active"));
	backend.releaseDelayedExecution();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(registry.unregister(backend.descriptor.id), true);
});

test("an abort before backend dispatch cancels without starting execution", async () => {
	const registry = deterministicRegistry();
	const backend = new DeterministicFakeSubagentBackend();
	registry.register(backend);
	const { plan } = await createFakeExecutionPlan({ registry, backend, runId: "run-pre-dispatch-cancel" });
	const controller = new AbortController();
	const execution = registry.execute(plan, { authorizationScope: "session.main", signal: controller.signal });
	controller.abort("cancelled before dispatch");
	const response = await execution;
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(response.status, "cancelled");
	assert.deepEqual(validateAgentResponse(response, { plan }), []);
	assert.equal(backend.executionCalls.length, 0);
	assert.deepEqual(backend.cancelCalls, [{ runId: plan.runId, reason: "cancelled before dispatch" }]);
	assert.equal(registry.unregister(backend.descriptor.id), true);
});

test("host-abort timeout settles once and records backend cancellation", async () => {
	const registry = deterministicRegistry();
	const backend = new DeterministicFakeSubagentBackend({ limitEnforcement: { timeoutMs: "host-abort" } });
	backend.executionMode = "delayed";
	registry.register(backend);
	const request = fakeRequest({ limits: { timeoutMs: { value: 10, enforcement: "best-effort" } } });
	const { plan } = await createFakeExecutionPlan({ registry, backend, request, runId: "run-timeout" });
	const response = await registry.execute(plan, { authorizationScope: "session.main" });
	assert.equal(response.status, "timed-out");
	assert.deepEqual(validateAgentResponse(response, { request, plan }), []);
	assert.equal(backend.cancelCalls[0]?.runId, plan.runId);
	backend.releaseDelayedExecution();
});

test("limit, media, artifact, and trace routing conform to the public contract", async () => {
	const limitRegistry = deterministicRegistry();
	const limitBackend = new DeterministicFakeSubagentBackend();
	limitBackend.executionMode = "limit-reached";
	limitRegistry.register(limitBackend);
	const limitRequest = fakeRequest({ limits: { maxTurns: { value: 2, enforcement: "required" } } });
	const limitPlan = await createFakeExecutionPlan({ registry: limitRegistry, backend: limitBackend, request: limitRequest, runId: "run-limit" });
	const limited = await limitRegistry.execute(limitPlan.plan, { authorizationScope: "session.main" });
	assert.equal(limited.status, "limit-reached");
	assert.deepEqual(validateAgentResponse(limited, { request: limitRequest, plan: limitPlan.plan }), []);

	const registry = deterministicRegistry();
	const backend = new DeterministicFakeSubagentBackend();
	backend.executionMode = "artifact-trace";
	registry.register(backend);
	const mediaRequest = fakeRequest({
		requestId: "request-media",
		input: { text: "Describe", media: [{ id: "image", kind: "image", mimeType: "image/png", digest: FAKE_DIGEST, resourceHandle: "image-resource" }] },
	});
	const { plan } = await createFakeExecutionPlan({ registry, backend, request: mediaRequest, runId: "run-artifact" });
	assert.equal(plan.messages.at(-1)?.content.some((part) => part.type === "media"), true);
	const response = await registry.execute(plan, { authorizationScope: "session.main" });
	assert.equal(response.status, "completed");
	assert.equal(response.artifacts.length, 1);
	assert.ok(response.trace);
	await assert.rejects(
		() => registry.inspectTrace(response.trace!, "session.other"),
		(error: unknown) => registryError(error, "trace.forbidden"),
	);
	assert.deepEqual(await registry.inspectTrace(response.trace!, "session.main"), {
		backendTraceId: "backend-trace-1",
		events: ["prepared", "executed"],
	});
	assert.equal(registry.forgetTrace(response.trace!.handle), true);
	await assert.rejects(
		() => registry.inspectTrace(response.trace!, "session.main"),
		(error: unknown) => registryError(error, "trace.unknown"),
	);
});

test("registry refuses plans that are invalid or not bound to its accepted preflight", async () => {
	const sourceRegistry = deterministicRegistry();
	const backend = new DeterministicFakeSubagentBackend();
	sourceRegistry.register(backend);
	const { plan } = await createFakeExecutionPlan({ registry: sourceRegistry, backend, runId: "run-boundary" });
	const tampered = structuredClone(plan);
	tampered.systemPrompt = "tampered";
	await assert.rejects(
		() => sourceRegistry.execute(tampered, { authorizationScope: "session.main" }),
		(error: unknown) => registryError(error, "execution.invalid-plan"),
	);
	const refingerprinted = structuredClone(plan);
	refingerprinted.systemPrompt = "tampered and refingerprinted";
	refingerprinted.executionFingerprint = subagentExecutionFingerprint(refingerprinted);
	await assert.rejects(
		() => sourceRegistry.execute(refingerprinted, { authorizationScope: "session.main" }),
		(error: unknown) => registryError(error, "execution.unbound-preparation"),
	);
	assert.equal(await sourceRegistry.discard(plan.preflightId), true);

	const foreignRegistry = deterministicRegistry();
	foreignRegistry.register(new DeterministicFakeSubagentBackend());
	await assert.rejects(
		() => foreignRegistry.execute(plan, { authorizationScope: "session.main" }),
		(error: unknown) => registryError(error, "execution.unbound-preflight"),
	);
});

function registryError(error: unknown, code: string): boolean {
	assert.ok(error instanceof SubagentBackendRegistryError);
	assert.equal(error.code, code);
	return true;
}
