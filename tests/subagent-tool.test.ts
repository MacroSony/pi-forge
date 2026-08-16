import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import {
	registerForgeSubagentTool,
	renderApprovalSummary,
	renderEmbeddedSubagentSummary,
	renderEmbeddedSummaryText,
	summarizeForgeSubagentPlan,
} from "../src/subagent-tool.ts";
import type { AgentResponse } from "../src/subagent/contract.ts";
import type { PiSubprocessRunReport } from "@zihanw/pi-subagent-runtime/backends/subprocess";
import type { ForgeSubagentSettings } from "../src/forge-config.ts";
import type { LoadedAgentProfile, ResolvedAgentProfile } from "../src/agent-profile.ts";
import { parseResourceSelector, type ResourceKey } from "../src/resource-identity.ts";
import type { ForgeSubagentProfileSummary } from "../src/subagent-profile-tool.ts";
import { createContext, createHarness, startSession, writeForgeConfig, writeProfile } from "./helpers/index-command-harness.ts";
import {
	createFakeExecutionPlan,
	fakeAcceptedPreflight,
	fakeRequest,
} from "./helpers/fake-subagent-fixture.ts";

// Keep global-config discovery hermetic; delegation policy is project-only.
const GLOBAL_CONFIG_PATH = join(tmpdir(), `pi-forge-subagent-tool-${process.pid}.json`);
process.env.PI_FORGE_GLOBAL_CONFIG_PATH = GLOBAL_CONFIG_PATH;
const TEST_CWD = join(tmpdir(), `pi-forge-subagent-tool-project-${process.pid}`);
const TEST_CONFIG_DIR = join(TEST_CWD, ".pi", "forge");
mkdirSync(TEST_CONFIG_DIR, { recursive: true });
writeFileSync(join(TEST_CONFIG_DIR, "config.json"), JSON.stringify({
	subagents: {
		profiles: {
			worker: { enabled: true },
		},
	},
}), "utf8");
test.after(() => {
	rmSync(GLOBAL_CONFIG_PATH, { force: true });
	rmSync(TEST_CWD, { recursive: true, force: true });
});

test("forge_subagent prepares, previews the full prompt on demand, approves, streams, and returns a rich report", async () => {
	const fixture = await toolFixture();
	const calls = { prepare: 0, discard: 0, execute: 0, takeReport: 0 };
	const response = completedResponse(fixture.prepared, "Review complete with evidence.");
	const report = subprocessReport(fixture.prepared, response.output!.text);
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => [],
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
	registerForgeSubagentTool({ registerTool: (tool: any) => { registered[tool.name] = tool; } } as any, runtime, () => [fixture.profileId], projectKey);
	const tool = registered.forge_subagent;
	assert.ok(tool);
	assert.equal(tool.executionMode, "parallel");

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
	assert.match(context.selectTitles[0] ?? "", /Task: Inspect this code carefully\./);
	assert.match(context.selectTitles[0] ?? "", new RegExp(fixture.prepared.plan.model.provider));
	assert.match(context.selectTitles[0] ?? "", /Boundary:.*\d+ ms/);
	assert.match(context.selectTitles[0] ?? "", /Execution:/);
	assert.equal(context.editors.length, 1);
	assert.match(context.editors[0]?.text ?? "", /# Subagent approval details/);
	assert.match(context.editors[0]?.text ?? "", /Agent prompt:\n  Inspect this code carefully\./);
	assert.match(context.editors[0]?.text ?? "", new RegExp(fixture.prepared.plan.executionFingerprint));
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

test("plan summaries retain the resolved prompt-stack scope", async () => {
	const fixture = await toolFixture();
	const summary = summarizeForgeSubagentPlan(fixture.prepared, TEST_CWD);
	assert.equal(summary.promptStackId, "project:worker");
});

test("parallel forge_subagent calls serialize approval dialogs but execute concurrently", async () => {
	const fixture = await toolFixture();
	let markFirstEntered!: () => void;
	const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
	let releaseFirst!: () => void;
	const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const selectTitles: string[] = [];
	const executionIntervals: Array<{ startedAt: number; finishedAt: number }> = [];
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => [],
		descriptors: () => [],
		prepare: async () => ({ ok: true, prepared: fixture.prepared }),
		discard: async () => undefined,
		execute: async () => {
			const startedAt = Date.now();
			await sleep(30);
			executionIntervals.push({ startedAt, finishedAt: Date.now() });
			return completedResponse(fixture.prepared, "ok");
		},
		dispose: async () => undefined,
	};
	const registered: Record<string, any> = {};
	registerForgeSubagentTool({ registerTool: (tool: any) => { registered[tool.name] = tool; } } as any, runtime, () => [fixture.profileId], projectKey);
	const tool = registered.forge_subagent;
	assert.equal(tool.executionMode, "parallel");

	const ctx = {
		hasUI: true,
		cwd: TEST_CWD,
		isProjectTrusted: () => true,
		ui: {
			select: async (title: string) => {
				selectTitles.push(title);
				if (selectTitles.length === 1) {
					markFirstEntered();
					await release;
				}
				return "Approve and run";
			},
			editor: async () => "",
		},
	} as any;

	const first = tool.execute("call-1", { profileId: fixture.profileId, task: "Task one." }, undefined, undefined, ctx);
	await firstEntered;
	const second = tool.execute("call-2", { profileId: fixture.profileId, task: "Task two." }, undefined, undefined, ctx);
	await sleep(50);
	assert.equal(selectTitles.length, 1, "the second approval dialog must wait for the first");
	releaseFirst();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(selectTitles.length, 2, "the second approval dialog runs after the first resolves");
	assert.equal(firstResult.details.status, "completed");
	assert.equal(secondResult.details.status, "completed");
	assert.equal(executionIntervals.length, 2);
	assert.ok(intervalsOverlap(executionIntervals), "approved runs must execute concurrently");
});

test("subagent approval selector stays compact for long multiline tasks", async () => {
	const fixture = await toolFixture();
	const task = Array.from({ length: 80 }, (_, index) => `Review requirement ${index} with supporting evidence.`).join("\n");
	const summary = renderApprovalSummary(fixture.prepared, task, `/workspace/${"nested/".repeat(30)}project`);
	const lines = summary.split("\n");

	assert.equal(lines.length, 10);
	assert.ok(lines.every((line) => line.length <= 180), lines.join("\n"));
	assert.match(lines[1] ?? "", /^Task: Review requirement 0 .*\.\.\.$/);
	assert.doesNotMatch(summary, /Review requirement 10/);
	assert.match(summary, /see full prompt/);
	assert.doesNotMatch(summary, new RegExp(fixture.prepared.plan.executionFingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.ok(new Text(summary, 1, 0).render(60).length <= 10, "the selector title should remain compact at 60 columns");
});

test("forge_subagent rejects a prepared plan without transport and fails closed without UI", async () => {
	const fixture = await toolFixture();
	const calls = { prepare: 0, discard: 0, execute: 0 };
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => [],
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
	registerForgeSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, runtime, () => [fixture.profileId], projectKey);

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

	let filteredTool: any;
	registerForgeSubagentTool({ registerTool: (definition: any) => { filteredTool = definition; } } as any, runtime, () => [fixture.profileId, "hidden"], projectKey);
	const hidden = await filteredTool.execute("hidden", { profileId: "hidden", task: "Must not prepare." }, undefined, undefined, rejected.ctx);
	assert.equal(hidden.details.status, "failed");
	assert.match(hidden.content[0].text, /not enabled for subagent delegation/);
	assert.equal(calls.prepare, 1);
});

test("forge_subagent can run without per-invocation UI only after trusted-project opt-in", async () => {
	const fixture = await toolFixture();
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-unattended-tool-"));
	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({
		subagents: {
			allowAgentInvocationWithoutApproval: true,
			profiles: { worker: { enabled: true } },
		},
	}), "utf8");
	let executeCalls = 0;
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => [],
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
	registerForgeSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, runtime, () => [fixture.profileId], projectKey);
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

test("forge_subagent pins unattended invocation to the configured backend and honors interactive overrides", async () => {
	const fixture = await toolFixture();
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-backend-pinning-"));
	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			subagents: {
				allowAgentInvocationWithoutApproval: true,
				backend: "project-default",
				timeoutMs: 90_000,
				profiles: {
					worker: { enabled: true, backend: "configured-backend", timeoutMs: 240_000 },
				},
			},
		}),
		"utf8",
	);
	const prepareRuns: Array<{ backendId?: string; timeoutMs?: number } | undefined> = [];
	let executeCalls = 0;
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => ["configured-backend", "other-backend"],
		descriptors: () => [],
		prepare: async (_profileId, _task, _ctx, run) => {
			prepareRuns.push(run);
			return { ok: true, prepared: fixture.prepared };
		},
		discard: async () => undefined,
		execute: async () => {
			executeCalls++;
			return completedResponse(fixture.prepared, "done");
		},
		dispose: async () => undefined,
	};
	let tool: any;
	registerForgeSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, runtime, () => [fixture.profileId], projectKey);
	const context = toolContext(["Approve and run"]);
	context.ctx.cwd = cwd;
	try {
		// Unattended: a diverging backend parameter fails closed before preparation.
		const pinned = await tool.execute("pinned", { profileId: fixture.profileId, task: "Run unattended.", backend: "other-backend" }, undefined, undefined, context.ctx);
		assert.equal(pinned.details.status, "failed");
		assert.match(pinned.content[0].text, /pinned to the configured backend/);
		assert.equal(prepareRuns.length, 0);
		assert.equal(executeCalls, 0);

		// Unattended: no override resolves to the configured project default.
		const configured = await tool.execute("configured", { profileId: fixture.profileId, task: "Run unattended." }, undefined, undefined, context.ctx);
		assert.equal(configured.details.status, "completed");
		assert.deepEqual(prepareRuns.at(-1), { backendId: "configured-backend", timeoutMs: 240_000 });

		// Unattended: explicitly naming the configured backend is accepted.
		const matching = await tool.execute("matching", { profileId: fixture.profileId, task: "Run unattended.", backend: "configured-backend" }, undefined, undefined, context.ctx);
		assert.equal(matching.details.status, "completed");
		assert.deepEqual(prepareRuns.at(-1), { backendId: "configured-backend", timeoutMs: 240_000 });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}

	// Interactive approval honors an explicit per-run backend override.
	const interactive = toolContext(["Approve and run"]);
	const result = await tool.execute("interactive", { profileId: fixture.profileId, task: "Run interactively.", backend: "other-backend" }, undefined, undefined, interactive.ctx);
	assert.equal(result.details.status, "completed");
	assert.deepEqual(prepareRuns.at(-1), { backendId: "other-backend", timeoutMs: 60_000 });
});

function subagentSettings(overrides: Partial<ForgeSubagentSettings> = {}): ForgeSubagentSettings {
	return {
		allowAgentInvocationWithoutApproval: false,
		timeoutMs: 60_000,
		timeoutSource: "built-in",
		summaryInToolDescription: false,
		profiles: {},
		configPath: "/tmp/config.json",
		globalConfigPath: "/tmp/global.json",
		warnings: [],
		...overrides,
	};
}

function loadedProfile(id: string): LoadedAgentProfile {
	return {
		filePath: `/tmp/${id}.json`,
		scope: "project",
		key: { scope: "project", id },
		diagnostics: [],
		profile: {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id,
			name: `${id} name`,
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: "high",
			promptStack: `${id}-stack`,
		},
	};
}

function resolvedProfile(loaded: LoadedAgentProfile, error?: string): ResolvedAgentProfile {
	return {
		loaded,
		model: { provider: loaded.profile.model.provider, id: loaded.profile.model.id } as any,
		promptStack: undefined,
		effectiveThinkingLevel: loaded.profile.thinkingLevel as any,
		diagnostics: error ? [{ level: "error", message: error }] : [],
	};
}

function profileSummary(overrides: Partial<ForgeSubagentProfileSummary> = {}): ForgeSubagentProfileSummary {
	return {
		id: "reviewer",
		name: "Review specialist",
		description: "Reviews code and architecture.",
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
		promptStack: "review-stack",
		backend: { id: "pi-subprocess-readonly", source: "built-in" },
		timeout: { milliseconds: 60_000, source: "built-in" },
		status: "ready",
		diagnostics: [],
		...overrides,
	};
}

test("embedded subagent summaries render one compact line per enabled profile with bounds", () => {
	const text = renderEmbeddedSummaryText([
		profileSummary(),
		profileSummary({
			id: "translate",
			name: "Translator",
			status: "unavailable",
			diagnostics: [
				{ level: "error", field: "model", message: "Model test-provider/other has no configured authentication." },
				{ level: "error", field: "promptStack", message: "This later error stays in full discovery details." },
			],
		}),
	]);
	assert.match(text, /^- reviewer — Review specialist: test-provider\/test-model · thinking high · stack review-stack; backend pi-subprocess-readonly · 60s$/m);
	assert.match(text, /^- translate — Translator: .* \(unavailable: Model test-provider\/other has no configured authentication\.\)$/m);
	assert.doesNotMatch(text, /later error/);
});

test("embedded subagent summaries cap the profile count and total length", () => {
	const many = Array.from({ length: 12 }, (_, index) => profileSummary({ id: `profile-${index}`, name: undefined }));
	const text = renderEmbeddedSummaryText(many);
	const lines = text.split("\n");
	assert.equal(lines.length, 10); // header + 8 profiles + one omitted line
	assert.match(lines[9] ?? "", /\.\.\. and 4 more enabled profiles/);

	const verbose = renderEmbeddedSummaryText([profileSummary({ name: "x".repeat(400) })]);
	assert.ok(verbose.length <= 1_000, "the embedded summary must respect the character budget");
});

test("renderEmbeddedSubagentSummary gates on the config flag, delegation policy, and resolution", () => {
	const settings = subagentSettings({
		summaryInToolDescription: true,
		profiles: {
			"project:reviewer": { enabled: true },
			"project:broken": { enabled: true },
			"project:hidden": { enabled: false },
		},
	});
	const profiles = [loadedProfile("reviewer"), loadedProfile("broken"), loadedProfile("hidden")];
	const resolve = (loaded: LoadedAgentProfile) => resolvedProfile(loaded, loaded.profile.id === "broken" ? "Model authentication is missing." : undefined);

	const summary = renderEmbeddedSubagentSummary(settings, profiles, resolve);
	assert.ok(summary);
	assert.match(summary, /reviewer/);
	assert.match(summary, /broken.*unavailable: Model authentication is missing\./);
	assert.doesNotMatch(summary, /hidden/);
	// Ready profiles come first.
	assert.ok(summary.indexOf("reviewer") < summary.indexOf("broken"));

	// Disabled flag: no summary at all.
	assert.equal(renderEmbeddedSubagentSummary(subagentSettings({ summaryInToolDescription: false }), profiles, resolve), undefined);
	// No enabled profiles: no summary at all.
	assert.equal(renderEmbeddedSubagentSummary(subagentSettings({ summaryInToolDescription: true }), profiles, resolve), undefined);
});

test("forge_subagent re-registers its description only when the embedded summary changes", () => {
	const registered: any[] = [];
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => [],
		descriptors: () => [],
		prepare: async () => ({ ok: false, diagnostics: [] }),
		discard: async () => undefined,
		execute: async () => completedResponse((await toolFixture()).prepared, "never runs"),
		dispose: async () => undefined,
	};
	let settings = subagentSettings({
		summaryInToolDescription: true,
		profiles: { "project:reviewer": { enabled: true } },
	});
	const profiles = [loadedProfile("reviewer")];
	const refresh = registerForgeSubagentTool(
		{ registerTool: (definition: any) => { registered.push(definition); } } as any,
		runtime,
		() => profiles.map((profile) => profile.profile.id),
		projectKey,
		{
			summarize: () => renderEmbeddedSubagentSummary(settings, profiles, (loaded) => resolvedProfile(loaded)),
		},
	);

	// Registration carries the base description; refresh only happens with a context.
	assert.equal(registered.length, 1);
	assert.match(registered[0].description, /Use forge_subagent_profiles first/);
	assert.doesNotMatch(registered[0].description, /Enabled subagent profiles/);

	refresh({} as any);
	assert.equal(registered.length, 2);
	assert.match(registered[1].description, /Enabled subagent profiles:/);
	assert.match(registered[1].description, /- project:reviewer — reviewer name: test-provider\/test-model · thinking high · stack reviewer-stack; backend pi-subprocess-readonly · 60s/);
	assert.match(registered[1].description, /run forge_subagent_profiles for full descriptions/);
	assert.doesNotMatch(registered[1].description, /Use forge_subagent_profiles first/);

	// Unchanged state: refresh is a no-op.
	refresh({} as any);
	assert.equal(registered.length, 2);

	// Disabling the option reverts the description to the base form.
	settings = subagentSettings();
	refresh({} as any);
	assert.equal(registered.length, 3);
	assert.match(registered[2].description, /Use forge_subagent_profiles first/);
	assert.doesNotMatch(registered[2].description, /Enabled subagent profiles/);
});

test("forge_subagent keeps its initial registration when the embedded summary stays disabled", () => {
	const registered: any[] = [];
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => [],
		descriptors: () => [],
		prepare: async () => ({ ok: false, diagnostics: [] }),
		discard: async () => undefined,
		execute: async () => completedResponse((await toolFixture()).prepared, "never runs"),
		dispose: async () => undefined,
	};
	const refresh = registerForgeSubagentTool(
		{ registerTool: (definition: any) => { registered.push(definition); } } as any,
		runtime,
		() => [],
		projectKey,
		{ summarize: () => undefined },
	);

	assert.equal(registered.length, 1);
	refresh({} as any);
	refresh({} as any);
	assert.equal(registered.length, 1);
});

test("forge_subagent embeds the enabled profile summary through the full extension lifecycle", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-embed-lifecycle-"));
	const targetModel = {
		api: "openai-completions",
		provider: "test",
		id: "reviewer-model",
		name: "Reviewer model",
		baseUrl: "http://localhost.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
	writeProfile(cwd, "reviewer.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "reviewer",
		name: "Review specialist",
		model: { provider: "test", id: "reviewer-model" },
		thinkingLevel: "high",
		promptStack: null,
	});
	writeForgeConfig(cwd, {
		subagents: {
			summaryInToolDescription: true,
			profiles: { reviewer: { enabled: true } },
		},
	});
	const harness = createHarness({ currentModel: targetModel, models: [targetModel], availableModels: [targetModel] });
	const context = createContext(cwd, [], { modelRuntime: harness });
	try {
		assert.match(harness.tools.forge_subagent.description, /Use forge_subagent_profiles first/);

		await startSession(harness, context.ctx);
		assert.match(harness.tools.forge_subagent.description, /Enabled subagent profiles:/);
		assert.match(harness.tools.forge_subagent.description, /- project:reviewer — Review specialist: test\/reviewer-model · thinking high · stack none; backend pi-subprocess-readonly · 60s/);

		// Firing an agent turn with unchanged state does not churn the tool registry.
		const toolsBefore = Object.keys(harness.tools).length;
		await harness.events.before_agent_start?.(
			{ systemPromptOptions: context.ctx.getSystemPromptOptions(), prompt: "Inspect this code." },
			context.ctx,
		);
		assert.equal(Object.keys(harness.tools).length, toolsBefore);
		assert.match(harness.tools.forge_subagent.description, /Enabled subagent profiles:/);

		// Disabling the option reverts the description on the next lifecycle refresh.
		writeForgeConfig(cwd, { subagents: {} });
		await harness.events.before_agent_start?.(
			{ systemPromptOptions: context.ctx.getSystemPromptOptions(), prompt: "Inspect this code." },
			context.ctx,
		);
		assert.match(harness.tools.forge_subagent.description, /Use forge_subagent_profiles first/);
		assert.doesNotMatch(harness.tools.forge_subagent.description, /Enabled subagent profiles:/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function projectKey(selector: string): ResourceKey | undefined {
	const parsed = parseResourceSelector(selector);
	if (!parsed.ok || parsed.selector.scope === "global") return undefined;
	return { scope: "project", id: parsed.selector.id };
}

function toolFixture() {
	const request = fakeRequest({
		limits: { timeoutMs: { value: 300_000, enforcement: "best-effort" } },
	});
	const preflight = fakeAcceptedPreflight({ request });
	preflight.limits.timeoutMs = { value: 300_000, enforcement: "host-abort" };
	const fixture = createFakeExecutionPlan({ request, preflight, runId: "tool-run" });
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
			cwd: TEST_CWD,
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function intervalsOverlap(intervals: Array<{ startedAt: number; finishedAt: number }>): boolean {
	if (intervals.length < 2) return false;
	const [left, right] = intervals;
	return left.startedAt < right.finishedAt && right.startedAt < left.finishedAt;
}
