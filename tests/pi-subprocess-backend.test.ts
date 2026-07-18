import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { prepareSubagentHostPlan } from "../src/subagent-host.ts";
import {
	createAgentExecutionPlan,
	subagentSourceProfileFingerprint,
	type AgentProfileSnapshot,
} from "../src/subagent-contract.ts";
import { SubagentBackendRegistry } from "../src/subagent/backend-registry.ts";
import {
	PI_SUBPROCESS_READONLY_BACKEND_ID,
	PiSubprocessBackend,
} from "../src/subagent/pi-subprocess-backend.ts";
import { createSubprocessBridge } from "../src/subagent/subprocess-bridge.ts";
import { fakeRequest, fakeSnapshot } from "./helpers/fake-subagent-backend.ts";

const PROVIDER = "pi-forge-subprocess-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-forge-subprocess-api";

test("read-only subprocess backend prepares without egress and captures the foreground JSON report", async () => {
	const tempDirectoriesBefore = subprocessTempDirectories();
	const providerContexts: Context[] = [];
	const faux = createFauxCore({ api: API, provider: PROVIDER, models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }] });
	faux.setResponses([(context) => {
		providerContexts.push(structuredClone(context));
		throw new Error("dry preparation must not reach this provider");
	}]);
	const modelRegistry = fixtureModelRegistry(faux);
	const invocationArgs: string[][] = [];
	const events = fixtureEvents();
	const backend = new PiSubprocessBackend({
		modelRegistry,
		cwd: process.cwd(),
		idFactory: () => "pi-subprocess-preflight-fixture",
		invocationFactory: (args) => {
			invocationArgs.push([...args]);
			return {
				command: process.execPath,
				args: ["--input-type=module", "-e", `for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");`],
			};
		},
	});
	const registry = new SubagentBackendRegistry();
	registry.register(backend);
	const snapshot = fixtureSnapshot();
	const request = fakeRequest({
		requestId: "subprocess-request",
		profileId: snapshot.profile.id,
		input: { text: "Inspect the fixture workspace." },
		access: {
			level: "read-only",
			workspaces: [{ handle: "project", mode: "read-only" }],
			workingDirectory: { workspaceHandle: "project", path: "." },
			network: "allow",
		},
		limits: { timeoutMs: { value: 5_000, enforcement: "best-effort" } },
		remoteEgressConsent: true,
	});

	try {
		const preflight = await registry.preflight(PI_SUBPROCESS_READONLY_BACKEND_ID, request, snapshot);
		assert.equal(preflight.status, "accepted", preflight.diagnostics.map((item) => item.message).join("; "));
		if (preflight.status !== "accepted") return;
		assert.equal(preflight.access.executionBoundary, "shared-user");
		assert.equal(preflight.access.enforcement.readOnlyMountIsolation, false);
		assert.deepEqual(preflight.toolCatalog.map((tool) => tool.name), ["read", "grep", "find", "ls"]);
		assert.ok(preflight.diagnostics.some((item) => item.code === "pi-subprocess.shared-user"));

		const prepared = await registry.prepare(
			PI_SUBPROCESS_READONLY_BACKEND_ID,
			{ request, snapshot, preflight },
			prepareSubagentHostPlan,
		);
		assert.equal(providerContexts.length, 0);
		assert.deepEqual(prepared.preparation.toolNegotiation.effectiveToolNames, ["read", "grep", "find", "ls"]);
		assert.match(prepared.preparation.systemPrompt, /Fixture subprocess reviewer/);

		const planned = createAgentExecutionPlan({
			runId: "subprocess-run",
			request,
			snapshot,
			preflight,
			preparation: prepared.preparation,
			runtime: prepared.runtime,
		});
		assert.ok(planned.plan, planned.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
		const updates: string[] = [];
		const response = await registry.execute(planned.plan, {
			authorizationScope: "session.fixture",
			onUpdate: (update) => updates.push(`${update.phase}:${update.message}`),
		});

		assert.equal(response.status, "completed");
		assert.equal(response.output?.text, "Fixture subprocess complete.");
		assert.equal(providerContexts.length, 0);
		assert.equal(invocationArgs.length, 1);
		assertContainsFlag(invocationArgs[0]!, "--tools", "read,grep,find,ls");
		assertContainsFlag(invocationArgs[0]!, "--model", `${PROVIDER}/${MODEL_ID}`);
		for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]) assert.ok(invocationArgs[0]!.includes(flag), flag);
		assert.ok(updates.some((update) => update.startsWith("tool-result:read completed")));
		assert.ok(updates.some((update) => update.startsWith("finishing:Subagent report ready")));

		const report = backend.takeReport(planned.plan.runId);
		assert.ok(report);
		assert.equal(report.status, "completed");
		assert.equal(report.executionBoundary, "shared-user");
		assert.equal(report.messages.length, 2);
		assert.equal(report.usage.turns, 1);
		assert.equal(report.usage.totalTokens, 15);
		assert.equal(backend.takeReport(planned.plan.runId), undefined);
	} finally {
		await backend.dispose();
		modelRegistry.unregisterProvider(PROVIDER);
	}
	assert.deepEqual(subprocessTempDirectories(), tempDirectoriesBefore);
});

test("subprocess bridge replaces only the marker and blocks tools outside the approved plan", () => {
	const handlers: Record<string, Function> = {};
	const input = {
		marker: "fixture-marker",
		systemPrompt: "Exact compiled prompt",
		messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Prepared task" }], protectedTask: true }],
		model: { provider: PROVIDER, id: MODEL_ID },
		effectiveToolNames: ["read"],
	};
	createSubprocessBridge(input)({ on: (name: string, handler: Function) => { handlers[name] = handler; } } as any);
	assert.deepEqual(handlers.before_agent_start?.({ systemPrompt: "other" }), { systemPrompt: input.systemPrompt });
	const transformed = handlers.context?.({
		messages: [
			{ role: "user", content: input.marker, timestamp: 0 },
			{ role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "kept" }], isError: false, timestamp: 1 },
		],
	});
	assert.equal(transformed.messages[0].content, "Prepared task");
	assert.equal(transformed.messages[1].role, "toolResult");
	assert.equal(handlers.tool_call?.({ toolName: "read" }), undefined);
	assert.match(handlers.tool_call?.({ toolName: "write" }).reason, /outside the approved/);
});

test("subprocess backend rejects access claims that a shared-user child cannot enforce", () => {
	const faux = createFauxCore({ api: API, provider: PROVIDER, models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }] });
	const modelRegistry = fixtureModelRegistry(faux);
	const backend = new PiSubprocessBackend({ modelRegistry, cwd: process.cwd(), idFactory: () => "rejected-preflight" });
	const snapshot = fixtureSnapshot();
	try {
		const result = backend.preflight({
			request: fakeRequest({
				profileId: snapshot.profile.id,
				access: { level: "none", workspaces: [], network: "deny" },
				remoteEgressConsent: true,
			}),
			snapshot,
		});
		assert.equal(result.status, "rejected");
		for (const code of ["pi-subprocess.access", "pi-subprocess.cwd", "pi-subprocess.network"]) assert.ok(result.diagnostics.some((item) => item.code === code), code);
	} finally {
		void backend.dispose();
		modelRegistry.unregisterProvider(PROVIDER);
	}
});

function fixtureSnapshot(): AgentProfileSnapshot {
	const snapshot = fakeSnapshot({
		id: "fixture-subprocess-reviewer",
		tools: { allow: ["*"] },
		items: [{ kind: "block", id: "system", role: "system", content: "You are the Fixture subprocess reviewer." }],
	});
	snapshot.profile.id = "fixture-subprocess-reviewer";
	snapshot.profile.model = { provider: PROVIDER, id: MODEL_ID };
	snapshot.profile.promptStack = "fixture-subprocess-reviewer";
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

function fixtureEvents(): unknown[] {
	return [
		{
			type: "tool_result_end",
			message: { role: "toolResult", toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "fixture source" }], details: {}, isError: false, timestamp: 1 },
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Fixture subprocess complete." }],
				api: API,
				provider: PROVIDER,
				model: MODEL_ID,
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
}

function assertContainsFlag(args: string[], flag: string, value: string): void {
	const index = args.indexOf(flag);
	assert.notEqual(index, -1, flag);
	assert.equal(args[index + 1], value);
}

function subprocessTempDirectories(): string[] {
	return readdirSync(tmpdir()).filter((name) => name.startsWith("pi-forge-subprocess-")).sort();
}
