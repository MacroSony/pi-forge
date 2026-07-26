import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import { registerForgeSubagentTool } from "../src/subagent-tool.ts";
import type { AgentResponse } from "../src/subagent/contract.ts";
import type { PiSubprocessRunReport } from "@zihanw/pi-subagent-runtime/backends/subprocess";
import { createFakeExecutionPlan } from "./helpers/fake-subagent-fixture.ts";

test("forge_subagent prepares, previews the full prompt on demand, approves, streams, and returns a rich report", async () => {
	const fixture = await toolFixture();
	const calls = { prepare: 0, discard: 0, execute: 0, takeReport: 0 };
	const response = completedResponse(fixture.prepared, "Review complete with evidence.");
	const report = subprocessReport(fixture.prepared, response.output!.text);
	const runtime: ForgeSubagentRuntime = {
		descriptors: () => [],
		prepare: async () => {
			calls.prepare++;
			return { ok: true, prepared: fixture.prepared };
		},
		discard: async () => { calls.discard++; },
		execute: async (_prepared, _ctx, _signal, onUpdate) => {
			calls.execute++;
			onUpdate?.({ phase: "starting", message: "Starting reviewer." });
			onUpdate?.({ phase: "tool-result", message: "read completed." });
			return response;
		},
		takeReport: () => {
			calls.takeReport++;
			return report;
		},
		dispose: async () => undefined,
	};
	const registered: Record<string, any> = {};
	registerForgeSubagentTool({ registerTool: (tool: any) => { registered[tool.name] = tool; } } as any, runtime, () => [fixture.profileId]);
	const tool = registered.forge_subagent;
	assert.ok(tool);
	assert.equal(tool.executionMode, "sequential");

	const context = toolContext(["View full prompt", "Approve and run"]);
	const updates: any[] = [];
	const result = await tool.execute("tool-call", { profileId: fixture.profileId, task: "Inspect this code carefully." }, undefined, (update: unknown) => updates.push(update), context.ctx);

	assert.equal(calls.prepare, 1);
	assert.equal(calls.discard, 0);
	assert.equal(calls.execute, 1);
	assert.equal(calls.takeReport, 1);
	assert.equal(result.content[0].text, "Review complete with evidence.");
	assert.equal(result.details.status, "completed");
	assert.equal(result.details.approval.approved, true);
	assert.equal(result.details.approval.source, "human");
	assert.equal(result.details.approval.viewedFullPrompt, true);
	assert.equal(result.details.approval.executionFingerprint, fixture.prepared.plan.executionFingerprint);
	assert.equal(result.details.report?.messages.length, 3);
	assert.equal(result.details.report?.executionBoundary, "shared-user");
	const retainedDetails = JSON.stringify(result.details);
	assert.doesNotMatch(retainedDetails, /fixture-image-base64/);
	assert.match(retainedDetails, /"dataOmitted":true/);
	assert.ok(updates.length >= 4);
	assert.match(context.selectTitles[0] ?? "", /Agent prompt:/);
	assert.match(context.selectTitles[0] ?? "", new RegExp(fixture.prepared.plan.model.provider));
	assert.match(context.selectTitles[0] ?? "", /Execution fingerprint:/);
	assert.equal(context.editors.length, 1);
	assert.match(context.editors[0]?.text ?? "", /# Exact provider-bound subagent prompt/);
	assert.match(context.editors[0]?.text ?? "", /## System prompt/);
	assert.match(context.editors[0]?.text ?? "", /protected delegated task/);

	const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme(), {});
	assert.match(collapsed.render(100).join("\n"), /Review complete with evidence/);
	const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme(), {});
	const expandedText = expanded.render(120).join("\n");
	assert.match(expandedText, /Subagent transcript/);
	assert.match(expandedText, /read/);
	assert.match(expandedText, /Image data omitted/);
});

test("forge_subagent rejects a prepared plan without transport and fails closed without UI", async () => {
	const fixture = await toolFixture();
	const calls = { prepare: 0, discard: 0, execute: 0 };
	const runtime: ForgeSubagentRuntime = {
		descriptors: () => [],
		prepare: async () => {
			calls.prepare++;
			return { ok: true, prepared: fixture.prepared };
		},
		discard: async () => { calls.discard++; },
		execute: async () => {
			calls.execute++;
			return completedResponse(fixture.prepared, "should not run");
		},
		dispose: async () => undefined,
	};
	let tool: any;
	registerForgeSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, runtime, () => [fixture.profileId]);

	const rejected = toolContext(["Reject"]);
	const rejection = await tool.execute("reject", { profileId: fixture.profileId, task: "Do not run." }, undefined, undefined, rejected.ctx);
	assert.equal(rejection.details.status, "cancelled");
	assert.equal(rejection.details.approval.approved, false);
	assert.equal(calls.prepare, 1);
	assert.equal(calls.discard, 1);
	assert.equal(calls.execute, 0);

	const noUi = toolContext([]);
	noUi.ctx.hasUI = false;
	const unavailable = await tool.execute("no-ui", { profileId: fixture.profileId, task: "Do not prepare." }, undefined, undefined, noUi.ctx);
	assert.equal(unavailable.details.status, "cancelled");
	assert.match(unavailable.content[0].text, /approval is unavailable/);
	assert.equal(calls.prepare, 1);
});

test("forge_subagent can run without per-invocation UI only after trusted-project opt-in", async () => {
	const fixture = await toolFixture();
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-unattended-tool-"));
	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({ subagents: { allowAgentInvocationWithoutApproval: true } }), "utf8");
	let executeCalls = 0;
	const runtime: ForgeSubagentRuntime = {
		descriptors: () => [],
		prepare: async () => ({ ok: true, prepared: fixture.prepared }),
		discard: async () => undefined,
		execute: async () => {
			executeCalls++;
			return completedResponse(fixture.prepared, "Unattended review complete.");
		},
		dispose: async () => undefined,
	};
	let tool: any;
	registerForgeSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, runtime, () => [fixture.profileId]);
	const context = toolContext([]);
	context.ctx.cwd = cwd;
	context.ctx.hasUI = false;
	context.ctx.isProjectTrusted = () => true;
	try {
		const result = await tool.execute("unattended", { profileId: fixture.profileId, task: "Run from config." }, undefined, undefined, context.ctx);
		assert.equal(executeCalls, 1);
		assert.equal(result.details.status, "completed");
		assert.deepEqual(result.details.approval, {
			required: false,
			approved: true,
			viewedFullPrompt: false,
			source: "trusted-project-config",
			executionFingerprint: fixture.prepared.plan.executionFingerprint,
			approvedAt: result.details.approval.approvedAt,
		});
		assert.ok(result.details.approval.approvedAt);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

async function toolFixture() {
	const fixture = createFakeExecutionPlan({ runId: "tool-run" });
	return {
		profileId: fixture.plan.profile.profile.id,
		prepared: {
			request: fixture.request,
			preflight: fixture.preflight,
			plan: fixture.plan,
			diagnostics: [],
		} satisfies ForgeSubagentPreparedRun,
	};
}

function completedResponse(prepared: ForgeSubagentPreparedRun, text: string): AgentResponse {
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
		durationMs: 25,
		status: "completed",
		output: { text, partial: false },
		artifacts: [],
	};
}

function subprocessReport(prepared: ForgeSubagentPreparedRun, output: string): PiSubprocessRunReport {
	return {
		preparedRunId: prepared.plan.runId,
		executionFingerprint: prepared.plan.executionFingerprint,
		status: "completed",
		startedAt: "2026-07-18T12:00:00.000Z",
		finishedAt: "2026-07-18T12:00:01.000Z",
		exitCode: 0,
		model: prepared.plan.model,
		thinkingLevel: prepared.plan.thinkingLevel,
		effectiveToolNames: ["read"],
		executionBoundary: "shared-user",
		workingDirectory: "/workspace",
		messages: [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }] },
			{
				role: "toolResult",
				toolName: "read",
				content: [
					{ type: "text", text: "source evidence" },
					{ type: "image", data: "fixture-image-base64", mimeType: "image/png" },
				],
				isError: false,
			},
			{ role: "assistant", content: [{ type: "text", text: output }] },
		],
		retention: { maxBytes: 512 * 1024, retainedBytes: 0, truncated: false, omittedMessages: 0 },
		stderr: "",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 0, turns: 2 },
	};
}

function toolContext(selections: string[]) {
	const queue = [...selections];
	const selectTitles: string[] = [];
	const editors: Array<{ title: string; text: string }> = [];
	return {
		ctx: {
			hasUI: true,
			cwd: "/workspace",
			isProjectTrusted: () => true,
			ui: {
				select: async (title: string) => {
					selectTitles.push(title);
					return queue.shift();
				},
				editor: async (title: string, text: string) => {
					editors.push({ title, text });
					return text;
				},
			},
		} as any,
		selectTitles,
		editors,
	};
}

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as any;
}
