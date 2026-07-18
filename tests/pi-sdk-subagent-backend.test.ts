import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

import { prepareSubagentHostPlan } from "../src/subagent-host.ts";
import {
	createAgentExecutionPlan,
	subagentExecutionFingerprint,
	subagentSourceProfileFingerprint,
	type AgentProfileSnapshot,
} from "../src/subagent-contract.ts";
import { SubagentBackendRegistry, SubagentBackendRegistryError } from "../src/subagent/backend-registry.ts";
import { PI_SDK_ISOLATED_BACKEND_ID, PiSdkIsolatedBackend } from "../src/subagent/pi-sdk-backend.ts";
import { fakeRequest, fakeSnapshot } from "./helpers/fake-subagent-backend.ts";

const PROVIDER = "pi-forge-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-forge-fixture-api";

test("isolated Pi SDK backend dry-plans behind a provider gate and executes through a real AgentSession", async () => {
	const tempDirectoriesBefore = isolatedTempDirectories();
	const capturedContexts: Context[] = [];
	const faux = createFauxCore({
		api: API,
		provider: PROVIDER,
		models: [{ id: MODEL_ID, name: "Fixture model", reasoning: true }],
		tokensPerSecond: 0,
	});
	faux.setResponses([
		(context) => {
			capturedContexts.push(structuredClone(context));
			return fauxAssistantMessage("fixture backend complete");
		},
		(context) => {
			capturedContexts.push(structuredClone(context));
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture provider failed" });
		},
	]);
	const modelRegistry = fixtureModelRegistry(faux);

	const registry = new SubagentBackendRegistry();
	let preflightSequence = 0;
	const backend = new PiSdkIsolatedBackend({
		modelRegistry,
		now: () => new Date("2026-07-14T12:00:00.000Z"),
		idFactory: () => `pi-sdk-preflight-${++preflightSequence}`,
	});
	registry.register(backend);
	const snapshot = fixtureSnapshot();
	const request = fakeRequest({
		requestId: "pi-sdk-request-1",
		profileId: snapshot.profile.id,
		input: { text: "Return the fixture result." },
		limits: { timeoutMs: { value: 5_000, enforcement: "best-effort" } },
		remoteEgressConsent: true,
	});

	try {
		const preflight = await registry.preflight(PI_SDK_ISOLATED_BACKEND_ID, request, snapshot);
		assert.equal(preflight.status, "accepted", preflight.diagnostics.map((item) => item.message).join("; "));
		const prepared = await registry.prepare(
			PI_SDK_ISOLATED_BACKEND_ID,
			{ request, snapshot, preflight },
			prepareSubagentHostPlan,
		);

		assert.equal(capturedContexts.length, 0, "dry preparation must not invoke provider transport");
		assert.deepEqual(prepared.preparation.toolNegotiation.effectiveToolIds, []);
		assert.equal(prepared.preparation.messages.at(-1)?.protectedTask, true);
		assert.match(prepared.preparation.systemPrompt, /Fixture reviewer/);

		const planned = createAgentExecutionPlan({
			runId: "pi-sdk-run-1",
			request,
			snapshot,
			preflight,
			preparation: prepared.preparation,
			runtime: prepared.runtime,
		});
		assert.ok(planned.plan, planned.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
		const response = await registry.execute(planned.plan, { authorizationScope: "session.fixture" });

		assert.equal(response.status, "completed");
		assert.equal(response.output?.text, "fixture backend complete");
		assert.deepEqual(response.effectiveToolIds, []);
		assert.equal(capturedContexts.length, 1);
		assert.equal(capturedContexts[0]?.tools?.length ?? 0, 0);
		assert.equal(capturedContexts[0]?.systemPrompt, prepared.preparation.systemPrompt);
		assert.match(textOf(capturedContexts[0]?.messages.at(-1)), /Return the fixture result/);

		const failedRequest = { ...structuredClone(request), requestId: "pi-sdk-request-failure", input: { text: "Return a provider failure." } };
		const failedPreflight = await registry.preflight(PI_SDK_ISOLATED_BACKEND_ID, failedRequest, snapshot);
		assert.equal(failedPreflight.status, "accepted");
		const failedPrepared = await registry.prepare(
			PI_SDK_ISOLATED_BACKEND_ID,
			{ request: failedRequest, snapshot, preflight: failedPreflight },
			prepareSubagentHostPlan,
		);
		const failedPlanned = createAgentExecutionPlan({
			runId: "pi-sdk-run-failure",
			request: failedRequest,
			snapshot,
			preflight: failedPreflight,
			preparation: failedPrepared.preparation,
			runtime: failedPrepared.runtime,
		});
		assert.ok(failedPlanned.plan);
		const failedResponse = await registry.execute(failedPlanned.plan, { authorizationScope: "session.fixture" });
		assert.equal(failedResponse.status, "failed");
		if (failedResponse.status === "failed") assert.match(failedResponse.error.message, /fixture provider failed/);

		const tamperRequest = { ...structuredClone(request), requestId: "pi-sdk-request-tamper", input: { text: "Reject a changed plan." } };
		const tamperPreflight = await registry.preflight(PI_SDK_ISOLATED_BACKEND_ID, tamperRequest, snapshot);
		assert.equal(tamperPreflight.status, "accepted");
		const tamperPrepared = await registry.prepare(
			PI_SDK_ISOLATED_BACKEND_ID,
			{ request: tamperRequest, snapshot, preflight: tamperPreflight },
			prepareSubagentHostPlan,
		);
		const tamperPlanned = createAgentExecutionPlan({
			runId: "pi-sdk-run-tamper",
			request: tamperRequest,
			snapshot,
			preflight: tamperPreflight,
			preparation: tamperPrepared.preparation,
			runtime: tamperPrepared.runtime,
		});
		assert.ok(tamperPlanned.plan);
		const tamperedPlan = structuredClone(tamperPlanned.plan);
		tamperedPlan.systemPrompt += "\nchanged after preparation";
		tamperedPlan.executionFingerprint = subagentExecutionFingerprint(tamperedPlan);
		await assert.rejects(
			() => registry.execute(tamperedPlan, { authorizationScope: "session.fixture" }),
			(error: unknown) => error instanceof SubagentBackendRegistryError && error.code === "execution.unbound-preparation",
		);
		assert.equal(capturedContexts.length, 2, "a changed prepared plan must fail before provider transport");
		assert.equal(await registry.discard(tamperPreflight.preflightId), true);

		const dryRequest = { ...structuredClone(request), requestId: "pi-sdk-request-discard", input: { text: "Prepare but do not send." } };
		const dryPreflight = await registry.preflight(PI_SDK_ISOLATED_BACKEND_ID, dryRequest, snapshot);
		assert.equal(dryPreflight.status, "accepted");
		await registry.prepare(
			PI_SDK_ISOLATED_BACKEND_ID,
			{ request: dryRequest, snapshot, preflight: dryPreflight },
			prepareSubagentHostPlan,
		);
		assert.equal(capturedContexts.length, 2);
		assert.equal(await registry.discard(dryPreflight.preflightId), true);
		assert.deepEqual(isolatedTempDirectories(), tempDirectoriesBefore);
	} finally {
		await backend.dispose();
		modelRegistry.unregisterProvider(PROVIDER);
	}
});

test("isolated Pi SDK backend cancels and times out concrete sessions without leaking runtime state", async () => {
	const tempDirectoriesBefore = isolatedTempDirectories();
	const providerStarts: string[] = [];
	const faux = createFauxCore({
		api: API,
		provider: PROVIDER,
		models: [{ id: MODEL_ID, name: "Fixture model", reasoning: true }],
		tokenSize: { min: 1, max: 1 },
		tokensPerSecond: 20,
	});
	faux.setResponses([
		() => {
			providerStarts.push("cancel");
			return fauxAssistantMessage("This cancellation fixture should not finish streaming.");
		},
		() => {
			providerStarts.push("timeout");
			return fauxAssistantMessage("This timeout fixture should not finish streaming.");
		},
	]);
	const modelRegistry = fixtureModelRegistry(faux);
	const registry = new SubagentBackendRegistry();
	let preflightSequence = 0;
	const backend = new PiSdkIsolatedBackend({
		modelRegistry,
		idFactory: () => `pi-sdk-cancellation-${++preflightSequence}`,
	});
	registry.register(backend);
	const snapshot = fixtureSnapshot();

	try {
		const cancellationRequest = fakeRequest({
			requestId: "pi-sdk-request-cancel",
			profileId: snapshot.profile.id,
			input: { text: "Start the cancellation fixture." },
			limits: { timeoutMs: { value: 5_000, enforcement: "best-effort" } },
			remoteEgressConsent: true,
		});
		const cancellationPlan = await preparePiSdkPlan(registry, snapshot, cancellationRequest, "pi-sdk-run-cancel");
		const controller = new AbortController();
		const cancellation = registry.execute(cancellationPlan, { authorizationScope: "session.fixture", signal: controller.signal });
		await waitFor(() => providerStarts.includes("cancel"));
		controller.abort("user cancelled concrete SDK run");
		const cancelled = await cancellation;
		assert.equal(cancelled.status, "cancelled");
		if (cancelled.status === "cancelled") assert.equal(cancelled.reason, "user cancelled concrete SDK run");
		await waitFor(() => sameStrings(isolatedTempDirectories(), tempDirectoriesBefore));

		const timeoutRequest = fakeRequest({
			requestId: "pi-sdk-request-timeout",
			profileId: snapshot.profile.id,
			input: { text: "Start the timeout fixture." },
			limits: { timeoutMs: { value: 10, enforcement: "best-effort" } },
			remoteEgressConsent: true,
		});
		const timeoutPlan = await preparePiSdkPlan(registry, snapshot, timeoutRequest, "pi-sdk-run-timeout");
		const timedOut = await registry.execute(timeoutPlan, { authorizationScope: "session.fixture" });
		assert.equal(timedOut.status, "timed-out");
		if (timedOut.status === "timed-out") assert.equal(timedOut.enforcedTimeoutMs, 10);
		assert.equal(providerStarts.includes("timeout"), true);
		await waitFor(() => sameStrings(isolatedTempDirectories(), tempDirectoriesBefore));
	} finally {
		await backend.dispose();
		modelRegistry.unregisterProvider(PROVIDER);
	}
	assert.deepEqual(isolatedTempDirectories(), tempDirectoriesBefore);
});

test("isolated Pi SDK backend rejects unsupported access, media, hard limits, and missing auth", async () => {
	const missingKeyName = "PI_FORGE_TEST_MISSING_API_KEY_7B763E";
	delete process.env[missingKeyName];
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(PROVIDER, {
		api: API,
		baseUrl: "https://fixture.invalid",
		apiKey: `$${missingKeyName}`,
		streamSimple: createFauxCore({ api: API, provider: PROVIDER }).streamSimple,
		models: [{
			id: MODEL_ID,
			name: "Fixture model",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_000,
		}],
	});
	const backend = new PiSdkIsolatedBackend({ modelRegistry, idFactory: () => "pi-sdk-rejected" });
	const snapshot = fixtureSnapshot();
	const result = backend.preflight({
		request: fakeRequest({
			profileId: snapshot.profile.id,
			input: { text: "Inspect", media: [{ id: "image", kind: "image", mimeType: "image/png", digest: `sha256:v1:${"0".repeat(64)}`, resourceHandle: "image" }] },
			access: { level: "read-only", workspaces: [{ handle: "project", mode: "read-only" }], network: "allow" },
			limits: { maxTurns: { value: 2, enforcement: "required" } },
			remoteEgressConsent: true,
		}),
		snapshot,
	});
	assert.equal(result.status, "rejected");
	const codes = result.diagnostics.map((item) => item.code);
	for (const code of ["pi-sdk.access", "pi-sdk.network", "pi-sdk.media", "pi-sdk.limit", "pi-sdk.auth"]) assert.ok(codes.includes(code), code);

	modelRegistry.unregisterProvider(PROVIDER);
});

function fixtureSnapshot(): AgentProfileSnapshot {
	const snapshot = fakeSnapshot({
		id: "fixture-reviewer",
		tools: { allow: ["*"] },
		items: [
			{ kind: "block", id: "system", role: "system", content: "You are the Fixture reviewer." },
			{ kind: "block", id: "preface", role: "user", content: "Review carefully before answering." },
		],
	});
	snapshot.profile.id = "fixture-reviewer";
	snapshot.profile.model = { provider: PROVIDER, id: MODEL_ID };
	snapshot.profile.promptStack = "fixture-reviewer";
	snapshot.profileFingerprint = subagentSourceProfileFingerprint(snapshot.profile);
	return snapshot;
}

function fixtureModelRegistry(faux: ReturnType<typeof createFauxCore>): ModelRegistry {
	const authStorage = AuthStorage.inMemory({ [PROVIDER]: { type: "api_key", key: "fixture-key" } });
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(PROVIDER, {
		api: API,
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-key",
		streamSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => faux.streamSimple(model, context, options),
		models: [{
			id: MODEL_ID,
			name: "Fixture model",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_000,
		}],
	});
	return modelRegistry;
}

async function preparePiSdkPlan(
	registry: SubagentBackendRegistry,
	snapshot: AgentProfileSnapshot,
	request: ReturnType<typeof fakeRequest>,
	runId: string,
) {
	const preflight = await registry.preflight(PI_SDK_ISOLATED_BACKEND_ID, request, snapshot);
	assert.equal(preflight.status, "accepted", preflight.diagnostics.map((item) => item.message).join("; "));
	const prepared = await registry.prepare(
		PI_SDK_ISOLATED_BACKEND_ID,
		{ request, snapshot, preflight },
		prepareSubagentHostPlan,
	);
	const planned = createAgentExecutionPlan({
		runId,
		request,
		snapshot,
		preflight,
		preparation: prepared.preparation,
		runtime: prepared.runtime,
	});
	assert.ok(planned.plan, planned.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
	return planned.plan;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms.`);
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function textOf(message: Context["messages"][number] | undefined): string {
	if (!message || !("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

function isolatedTempDirectories(): string[] {
	return readdirSync(tmpdir()).filter((name) => name.startsWith("pi-forge-subagent-")).sort();
}
