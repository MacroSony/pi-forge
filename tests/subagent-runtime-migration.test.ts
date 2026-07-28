import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_PROFILE_TYPE, type LoadedAgentProfile } from "../src/agent-profile.ts";
import { createForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import type { PiForgeRuntimeState } from "../src/runtime-state.ts";
import type { LoadedPromptStack } from "../src/types.ts";

const PROVIDER = "pi-forge-migration-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-forge-migration-api";

/**
 * Dogfoods the migrated Forge host: the public createForgeSubagentRuntime
 * drives both runtime-package process backends through the unchanged
 * profile resolution, compilation, approval-plan, and response surfaces.
 */
test("forge subagent runtime prepares and executes through both migrated process backends", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-migration-"));
	const faux = createFauxCore({
		api: API,
		provider: PROVIDER,
		models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
	});
	faux.setResponses([() => {
		throw new Error("dry preparation must not reach this provider");
	}]);
	const { modelRegistry } = await fixtureModelRuntime(faux);

	const subprocessArgs: string[][] = [];
	const preparationController = new AbortController();
	const runtime = createForgeSubagentRuntime(fixtureState(), {
		subprocess: {
			invocationFactory: (args) => {
				subprocessArgs.push([...args]);
				return {
					command: process.execPath,
					args: ["--input-type=module", "-e", scriptedSubprocessChild()],
				};
			},
		},
		rpc: {
			invocationFactory: () => ({
				command: process.execPath,
				args: ["--input-type=module", "-e", scriptedRpcChild()],
			}),
		},
	});
	const ctx = fixtureContext(modelRegistry, cwd, preparationController.signal);

	try {
		const descriptors = runtime.descriptors(ctx).map((descriptor) => descriptor.id).sort();
		assert.deepEqual(descriptors, ["pi-rpc-readonly", "pi-subprocess-readonly"]);
		const invalidTimeout = await runtime.prepare("fixture-worker", "Reject an invalid timeout.", ctx, { timeoutMs: 999 });
		assert.equal(invalidTimeout.ok, false);
		assert.equal(invalidTimeout.ok ? undefined : invalidTimeout.diagnostics[0]?.code, "host.timeout");

		for (const backendId of ["pi-subprocess-readonly", "pi-rpc-readonly"] as const) {
			const scoped = createForgeSubagentRuntime(fixtureState(), {
				backendId,
				subprocess: {
					invocationFactory: (args) => {
						subprocessArgs.push([...args]);
						return {
							command: process.execPath,
							args: ["--input-type=module", "-e", scriptedSubprocessChild()],
						};
					},
				},
				rpc: {
					invocationFactory: () => ({
						command: process.execPath,
						args: ["--input-type=module", "-e", scriptedRpcChild()],
					}),
				},
			});
			const preparedResult = await scoped.prepare("fixture-worker", "Review the migration fixture.", ctx, { timeoutMs: 300_000 });
			assert.equal(preparedResult.ok, true, preparedResult.ok === false ? preparedResult.diagnostics.map((item) => item.message).join("; ") : "");
			assert.equal(getEventListeners(preparationController.signal, "abort").length, 0);
			if (!preparedResult.ok) continue;
			const { prepared } = preparedResult;

			// The approval surface keeps its pre-migration shape and content.
			assert.equal(prepared.plan.backendId, backendId);
			assert.equal(prepared.plan.profile.profile.id, "fixture-worker");
			assert.equal(prepared.plan.model.provider, PROVIDER);
			assert.equal(prepared.plan.thinkingLevel, "high");
			assert.deepEqual(prepared.plan.effectiveToolIds, ["pi.read", "pi.grep", "pi.find", "pi.ls"]);
			assert.match(prepared.plan.systemPrompt, /Fixture migration worker/);
			assert.equal(prepared.plan.messages.at(-1)?.protectedTask, true);
			const taskPart = prepared.plan.messages.at(-1)?.content[0];
			assert.equal(taskPart?.type, "text");
			assert.match(taskPart?.type === "text" ? taskPart.text : "", /Review the migration fixture/);
			assert.match(prepared.plan.executionFingerprint, /^sha256:v1:/);
			assert.match(prepared.plan.promptRuntimeFingerprint, /^sha256:v1:/);
			assert.equal(prepared.plan.access.executionBoundary, "shared-user");
			assert.equal(prepared.request.limits.timeoutMs?.value, 300_000);
			assert.equal(prepared.plan.limits.timeoutMs?.value, 300_000);

			const updates: string[] = [];
			const executionController = new AbortController();
			const response = await scoped.execute(prepared, ctx, executionController.signal, (update) => updates.push(`${update.phase}:${update.message}`));
			assert.equal(response.status, "completed", JSON.stringify(response));
			assert.equal(getEventListeners(executionController.signal, "abort").length, 0);
			if (response.status !== "completed") continue;
			assert.equal(response.output?.text, `Fixture ${backendId} complete.`);
			assert.equal(response.backendId, backendId);
			assert.equal(response.requestId, prepared.request.requestId);
			assert.equal(response.profileFingerprint, prepared.plan.profile.profileFingerprint);
			assert.equal(response.executionFingerprint, prepared.plan.executionFingerprint);
			assert.deepEqual(response.effectiveToolIds, prepared.plan.effectiveToolIds);
			assert.ok(updates.some((update) => update.startsWith("finishing:")));

			assert.ok(scoped.takeReport);
			const report = scoped.takeReport(response.runId);
			assert.ok(report, backendId);
			assert.equal(report.status, "completed");
			assert.equal(report.executionBoundary, "shared-user");
			await scoped.dispose();
		}

		assert.equal(subprocessArgs.length >= 1, true);
		const subprocessFlags = subprocessArgs[0]!;
		for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"]) {
			assert.ok(subprocessFlags.includes(flag), flag);
		}
	} finally {
		await runtime.dispose();
		modelRegistry.unregisterProvider(PROVIDER);
		rmSync(cwd, { recursive: true, force: true });
	}
});

function fixtureState(): PiForgeRuntimeState {
	const stack: LoadedPromptStack = {
		stack: {
			schemaVersion: 1,
			id: "fixture-worker",
			mode: "replace",
			items: [{ kind: "block", id: "system", role: "system", content: "You are the Fixture migration worker." }],
		},
		filePath: "/fixture/worker.md",
		diagnostics: [],
	};
	const profile: LoadedAgentProfile = {
		profile: {
			schemaVersion: 1,
			type: AGENT_PROFILE_TYPE,
			id: "fixture-worker",
			model: { provider: PROVIDER, id: MODEL_ID },
			thinkingLevel: "high",
			promptStack: "fixture-worker",
		},
		filePath: "/fixture/worker.profile.md",
		diagnostics: [],
	};
	return {
		stacks: [stack],
		profiles: [profile],
		contextRewritePending: false,
		sessionVariables: {},
		latestCompileDiagnostics: [],
		forgeExtensionDiagnostics: [],
		forgeExtensionPaths: [],
		interceptNextProviderPayload: false,
	} as unknown as PiForgeRuntimeState;
}

function fixtureContext(modelRegistry: ModelRegistry, cwd: string, signal?: AbortSignal): ExtensionContext {
	return {
		modelRegistry,
		cwd,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "migration-fixture-session" },
		...(signal ? { signal } : {}),
	} as unknown as ExtensionContext;
}

function scriptedSubprocessChild(): string {
	return `const { writeSync } = await import("node:fs");
for (const event of ${JSON.stringify(fixtureFd3Events("pi-subprocess-readonly"))}) writeSync(3, JSON.stringify(event) + "\\n");
`;
}

function scriptedRpcChild(): string {
	return `const { writeSync } = await import("node:fs");
let buffer = "";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index;
	while ((index = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		if (command.type === "prompt") {
			send({ type: "response", command: "prompt", id: command.id, success: true });
			for (const event of ${JSON.stringify(fixtureFd3Events("pi-rpc-readonly"))}) writeSync(3, JSON.stringify(event) + "\\n");
			send({ type: "agent_end", messages: [], willRetry: false });
			send({ type: "agent_settled" });
		} else if (command.type === "abort") {
			send({ type: "response", command: "abort", id: command.id, success: true });
			send({ type: "agent_settled" });
		}
	}
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));
`;
}

function fixtureFd3Events(backendId: string): unknown[] {
	return [
		{
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "fixture source" }],
				isError: false,
				timestamp: 1,
			},
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `Fixture ${backendId} complete.` }],
				api: API,
				provider: PROVIDER,
				model: MODEL_ID,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
}

async function fixtureModelRuntime(
	faux: ReturnType<typeof createFauxCore>,
): Promise<{ modelRegistry: ModelRegistry; modelRuntime: ModelRuntime }> {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(PROVIDER, {
		api: API,
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-key",
		streamSimple: (
			model: Model<any>,
			context: Context,
			options?: SimpleStreamOptions,
		) => faux.streamSimple(model, context, options),
		models: [
			{
				id: MODEL_ID,
				name: "Fixture model",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 4_000,
			},
		],
	});
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}
