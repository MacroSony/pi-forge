import assert from "node:assert/strict";
import test from "node:test";

import { registerForgeSubagentCommand } from "../src/subagent-command.ts";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import type { SubagentBackendDescriptor } from "../src/subagent/contract.ts";
import { createFakeExecutionPlan } from "./helpers/fake-subagent-fixture.ts";

const FAKE_DESCRIPTOR: SubagentBackendDescriptor = {
	id: "fake-backend",
	version: "1.0.0",
	capabilities: {
		access: {
			readOnlyMountIsolation: true,
			readWriteMountIsolation: true,
			symlinkSafeContainment: true,
			processIsolation: true,
			agentNetworkIsolation: true,
		},
		executionBoundaries: ["isolated", "shared-user"],
		limits: { timeoutMs: ["backend-hard"], maxTurns: ["backend-hard"], tokenBudget: ["backend-hard"], maxOutputBytes: ["backend-hard"] },
		cancellation: true,
		mediaMimeTypes: [],
		traceInspection: true,
		artifactRetention: true,
		remoteTransport: false,
		promptRuntimeFidelity: "backend-assisted",
	},
};

test("/forge-agent exposes backend/profile completions, dry planning, and explicit egress consent", async () => {
	const fixture = createFakeExecutionPlan({ runId: "command-run" });
	const prepared: ForgeSubagentPreparedRun = {
		request: fixture.request,
		preflight: fixture.preflight,
		plan: fixture.plan,
		diagnostics: [],
	};
	const calls = { prepare: 0, discard: 0, execute: 0 };
	const runtime: ForgeSubagentRuntime = {
		descriptors: () => [structuredClone(FAKE_DESCRIPTOR)],
		prepare: async () => {
			calls.prepare++;
			return { ok: true, prepared };
		},
		discard: async () => { calls.discard++; },
		execute: async () => {
			calls.execute++;
			return {
				schemaVersion: 1,
				requestId: prepared.request.requestId,
				runId: prepared.plan.runId,
				backendId: prepared.plan.backendId,
				profileFingerprint: prepared.plan.profile.profileFingerprint,
				executionFingerprint: prepared.plan.executionFingerprint,
				model: prepared.plan.model,
				effectiveToolIds: prepared.plan.effectiveToolIds,
				enforcement: { access: prepared.plan.access, limits: prepared.plan.limits },
				durationMs: 12,
				status: "completed",
				output: { text: "command fixture complete", partial: false },
				artifacts: [],
			};
		},
		dispose: async () => undefined,
	};
	const commands: Record<string, any> = {};
	registerForgeSubagentCommand({ registerCommand: (name: string, command: unknown) => { commands[name] = command; } } as any, runtime, () => ["reviewer", "image-viewer"]);
	const command = commands["forge-agent"];
	assert.ok(command);
	assert.deepEqual(command.getArgumentCompletions("pl"), [{ value: "plan", label: "plan" }]);
	assert.deepEqual(command.getArgumentCompletions("run im"), [{ value: "run image-viewer", label: "image-viewer" }]);

	const context = commandContext();
	await command.handler("backends", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /fake-backend/);

	await command.handler("plan reviewer inspect this", context.ctx);
	assert.equal(calls.prepare, 1);
	assert.equal(calls.discard, 1);
	assert.equal(calls.execute, 0);
	assert.match(context.editors.at(-1)?.text ?? "", /Provider transport: not started/);

	await command.handler("run reviewer inspect this", context.ctx);
	assert.equal(calls.prepare, 2, "approval is requested only after exact dry preparation");
	assert.equal(calls.discard, 2, "a rejected prepared plan must be discarded");
	assert.match(context.notifications.at(-1)?.message ?? "", /cancelled before provider transport/);

	context.setHasUI(false);
	await command.handler("run reviewer inspect this", context.ctx);
	assert.equal(calls.prepare, 2, "non-UI execution must fail closed before preparation");
	assert.equal(calls.execute, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /requires interactive provider-egress confirmation/);

	context.setHasUI(true);
	context.setSelection("Approve and run");
	await command.handler("run reviewer inspect this", context.ctx);
	assert.equal(calls.prepare, 3);
	assert.equal(calls.execute, 1);
	assert.match(context.editors.at(-1)?.text ?? "", /command fixture complete/);
	assert.equal(context.statuses["pi-forge-subagent"], undefined);
});

function commandContext() {
	const editors: Array<{ title: string; text: string }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Record<string, string | undefined> = {};
	let selection: string | undefined;
	const ctx = {
		hasUI: true,
		signal: undefined,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			editor: async (title: string, text: string) => { editors.push({ title, text }); return text; },
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			select: async () => selection,
			setStatus: (key: string, value: string | undefined) => { statuses[key] = value; },
		},
	};
	return {
		ctx: ctx as any,
		editors,
		notifications,
		statuses,
		setSelection: (value: string | undefined) => { selection = value; },
		setHasUI: (value: boolean) => { ctx.hasUI = value; },
	};
}
