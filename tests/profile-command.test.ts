import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { AGENT_PROFILE_TYPE, agentProfileFingerprint, agentProfilePath, type AgentProfile, type AgentProfileProvenance } from "../src/agent-profile.ts";
import { GLOBAL_FORGE_DIR_ENV } from "../src/storage.ts";
import { PROFILE_ENTRY_TYPE } from "../src/runtime-state.ts";
import { createContext, createHarness, startSession, writeProfile, writeStack } from "./helpers/index-command-harness.ts";

function model(provider: string, id: string): Model<any> {
	return {
		api: "openai-completions",
		provider,
		id,
		name: id,
		baseUrl: "http://localhost.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

function profile(id: string, targetModel: Model<any>, promptStack: string | null, thinkingLevel = "high"): AgentProfile {
	return {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id,
		name: id,
		model: { provider: targetModel.provider, id: targetModel.id },
		thinkingLevel: thinkingLevel as AgentProfile["thinkingLevel"],
		promptStack,
	};
}

function runtime(cwd: string, currentModel: Model<any>, models: Model<any>[], thinkingLevel = "low") {
	const harness = createHarness({ currentModel, models, availableModels: models, thinkingLevel });
	const context = createContext(cwd, [], { modelRuntime: harness });
	return { harness, context };
}

test("/profile lists profiles and completes commands and ids", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const targetModel = model("test", "reviewer-model");
	writeProfile(cwd, "reviewer.json", profile("reviewer", targetModel, null));
	const { harness, context } = runtime(cwd, targetModel, [targetModel]);
	await startSession(harness, context.ctx);

	const complete = harness.commands.profile.getArgumentCompletions!;
	const commandCompletions = complete("u");
	const idCompletions = complete("use ");
	await harness.commands.profile.handler("list", context.ctx);

	assert.deepEqual(commandCompletions, [{ value: "use", label: "use" }]);
	assert.deepEqual(idCompletions, [{ value: "use reviewer", label: "reviewer" }]);
	assert.match(context.editors.at(-1)?.text ?? "", /reviewer — reviewer \[profile\]/);
	assert.match(context.editors.at(-1)?.text ?? "", /\/profile save <id>/);
});

test("/profile use applies once, previews effective tools, and reports runtime drift", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "small");
	const targetModel = model("test", "large");
	writeStack(cwd, "reviewer.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "reviewer-stack",
		autoActivate: false,
		tools: { allow: ["read"] },
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeProfile(cwd, "reviewer.json", profile("reviewer", targetModel, "reviewer-stack"));
	const { harness, context } = runtime(cwd, currentModel, [currentModel, targetModel]);
	await startSession(harness, context.ctx);

	await harness.commands.profile.handler("preview reviewer", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /Effective tools after stack policy: read/);
	assert.match(context.editors.at(-1)?.text ?? "", /Applicable: yes/);

	await harness.commands.profile.handler("use reviewer", context.ctx);
	assert.equal(harness.getCurrentModel(), targetModel);
	assert.equal(harness.getThinkingLevel(), "high");
	assert.deepEqual(harness.getActiveTools(), ["read"]);
	const profileEntry = [...harness.appended].reverse().find((entry) => entry.type === PROFILE_ENTRY_TYPE);
	assert.ok(profileEntry);
	assert.equal((profileEntry.data as { provenance: AgentProfileProvenance }).provenance.profileId, "reviewer");

	await harness.commands.profile.handler("status", context.ctx);
	let status = context.editors.at(-1)?.text ?? "";
	assert.match(status, /Last applied profile: reviewer/);
	assert.match(status, /model: unchanged/);
	assert.match(status, /thinking level: unchanged/);
	assert.match(status, /prompt stack: unchanged/);

	await harness.setModel(currentModel);
	harness.setThinkingLevel("low");
	await harness.commands.preset.handler("use none", context.ctx);
	await harness.commands.profile.handler("status", context.ctx);
	status = context.editors.at(-1)?.text ?? "";
	assert.match(status, /test\/large → test\/small/);
	assert.match(status, /high → low/);
	assert.match(status, /project:reviewer-stack → \(none\)/);
});

test("fresh sessions auto-activate one profile instead of the standalone default stack", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "current");
	const targetModel = model("test", "target");
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
		type: "pi-forge.prompt-stack",
		id: "standalone-default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeStack(cwd, "worker.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "worker-stack",
		autoActivate: false,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeProfile(cwd, "worker.json", { ...profile("worker", targetModel, "worker-stack"), autoActivate: true });
	const harness = createHarness({ currentModel, models: [currentModel, targetModel], availableModels: [currentModel, targetModel], thinkingLevel: "low" });
	const bootstrapEntries = [
		{
			id: "initial-model",
			parentId: null,
			type: "model_change",
			provider: currentModel.provider,
			modelId: currentModel.id,
		},
		{
			id: "initial-thinking",
			parentId: "initial-model",
			type: "thinking_level_change",
			thinkingLevel: "low",
		},
	];
	const context = createContext(cwd, bootstrapEntries, { leafId: "initial-thinking", modelRuntime: harness });

	await startSession(harness, context.ctx);

	assert.equal(harness.getCurrentModel(), targetModel);
	assert.equal(harness.getThinkingLevel(), "high");
	assert.equal(context.statuses["pi-forge"], "stack:worker-stack");
	assert.ok(harness.appended.some((entry) => entry.type === PROFILE_ENTRY_TYPE));
	assert.match(context.notifications.find((entry) => /auto-activated profile/.test(entry.message))?.message ?? "", /worker/);
});

test("startup with existing conversation content does not auto-activate a profile", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "current");
	const targetModel = model("test", "target");
	writeProfile(cwd, "worker.json", { ...profile("worker", targetModel, null), autoActivate: true });
	const harness = createHarness({ currentModel, models: [currentModel, targetModel], availableModels: [currentModel, targetModel], thinkingLevel: "low" });
	const entries = [{
		id: "existing-message",
		parentId: null,
		type: "message",
		message: { role: "user", content: "Existing work" },
	}];
	const context = createContext(cwd, entries, { leafId: "existing-message", modelRuntime: harness });

	await startSession(harness, context.ctx);

	assert.equal(harness.setModelCalls.length, 0);
	assert.equal(harness.getCurrentModel(), currentModel);
	assert.equal(harness.getThinkingLevel(), "low");
	assert.equal(harness.appended.some((entry) => entry.type === PROFILE_ENTRY_TYPE), false);
});

test("reload, resume, and fork session starts never auto-activate a profile", async () => {
	for (const reason of ["reload", "resume", "fork"] as const) {
		const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
		const currentModel = model("test", `current-${reason}`);
		const targetModel = model("test", `target-${reason}`);
		writeProfile(cwd, "worker.json", { ...profile("worker", targetModel, null), autoActivate: true });
		const harness = createHarness({ currentModel, models: [currentModel, targetModel], availableModels: [currentModel, targetModel], thinkingLevel: "low" });
		const context = createContext(cwd, [], { modelRuntime: harness });

		await harness.events.session_start?.({ type: "session_start", reason }, context.ctx);
		await harness.events.resources_discover?.({ type: "resources_discover", cwd, reason: reason === "reload" ? "reload" : "startup" }, context.ctx);

		assert.equal(harness.setModelCalls.length, 0, reason);
		assert.equal(harness.getCurrentModel(), currentModel, reason);
		assert.equal(harness.getThinkingLevel(), "low", reason);
		assert.equal(harness.appended.some((entry) => entry.type === PROFILE_ENTRY_TYPE), false, reason);
	}
});

test("an auto-activated profile with a null prompt stack suppresses standalone stack autoload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "current");
	const targetModel = model("test", "target");
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
		type: "pi-forge.prompt-stack",
		id: "standalone-default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeProfile(cwd, "worker.json", { ...profile("worker", targetModel, null), autoActivate: true });
	const { harness, context } = runtime(cwd, currentModel, [currentModel, targetModel]);

	await startSession(harness, context.ctx);

	assert.equal(harness.getCurrentModel(), targetModel);
	assert.equal(context.statuses["pi-forge"], undefined);
	assert.ok(harness.appended.some((entry) => entry.type === "pi-forge-prompt-stack-state" && (entry.data as { activeStackId?: string }).activeStackId === "none"));
});

test("ambiguous profile autoload fails closed instead of selecting a fallback stack", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "current");
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
		type: "pi-forge.prompt-stack",
		id: "standalone-default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	for (const id of ["one", "two"]) {
		writeProfile(cwd, `${id}.json`, { ...profile(id, currentModel, null), autoActivate: true });
	}
	const { harness, context } = runtime(cwd, currentModel, [currentModel]);

	await startSession(harness, context.ctx);

	assert.equal(context.statuses["pi-forge"], undefined);
	assert.equal(harness.appended.some((entry) => entry.type === PROFILE_ENTRY_TYPE), false);
	assert.match(context.notifications.find((entry) => /multiple agent profiles/.test(entry.message))?.message ?? "", /no profile or fallback prompt stack/);
});

test("/profile use fails preflight without mutating runtime", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "available");
	const unavailableModel = model("test", "unavailable");
	writeProfile(cwd, "blocked.json", profile("blocked", unavailableModel, null));
	const harness = createHarness({
		currentModel,
		models: [currentModel, unavailableModel],
		availableModels: [currentModel],
		thinkingLevel: "low",
	});
	const context = createContext(cwd, [], { modelRuntime: harness });
	await startSession(harness, context.ctx);

	await harness.commands.profile.handler("use blocked", context.ctx);

	assert.equal(harness.getCurrentModel(), currentModel);
	assert.equal(harness.getThinkingLevel(), "low");
	assert.equal(harness.setModelCalls.length, 0);
	assert.equal(harness.appended.some((entry) => entry.type === PROFILE_ENTRY_TYPE), false);
	assert.match(context.notifications.at(-1)?.message ?? "", /failed preflight/);
	assert.match(context.editors.at(-1)?.text ?? "", /has no configured authentication/);
});

test("/profile use rolls model and thinking back when Pi applies an unexpected thinking level", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "current");
	const targetModel = model("test", "target");
	writeProfile(cwd, "worker.json", profile("worker", targetModel, null, "high"));
	const harness = createHarness({
		currentModel,
		models: [currentModel, targetModel],
		thinkingLevel: "low",
		resolveThinkingLevel: (_model, requested) => requested === "high" ? "low" : requested,
	});
	const context = createContext(cwd, [], { modelRuntime: harness });
	await startSession(harness, context.ctx);

	await harness.commands.profile.handler("use worker", context.ctx);

	assert.equal(harness.getCurrentModel(), currentModel);
	assert.equal(harness.getThinkingLevel(), "low");
	assert.deepEqual(harness.setModelCalls, [targetModel, currentModel]);
	assert.equal(harness.appended.some((entry) => entry.type === PROFILE_ENTRY_TYPE), false);
	assert.match(context.notifications.at(-1)?.message ?? "", /Previous runtime state was restored/);
});

test("/profile save captures current state, preserves metadata, and does not create provenance", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "writer-model");
	writeStack(cwd, "writer.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "writer",
		autoActivate: false,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const { harness, context } = runtime(cwd, currentModel, [currentModel], "medium");
	await startSession(harness, context.ctx);
	await harness.commands.preset.handler("use writer", context.ctx);

	await harness.commands.profile.handler("save captured", context.ctx);
	const path = agentProfilePath(cwd, "captured");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(saved.model, { provider: "test", id: "writer-model" });
	assert.equal(saved.thinkingLevel, "medium");
	assert.equal(saved.promptStack, "writer");
	assert.equal(saved.tools, undefined);
	assert.equal(harness.appended.some((entry) => entry.type === PROFILE_ENTRY_TYPE), false);

	saved.name = "Captured Writer";
	saved.description = "Writes project prose.";
	saved.autoActivate = true;
	writeFileSync(path, JSON.stringify(saved, null, 2));
	await harness.commands.profile.handler("reload", context.ctx);
	harness.setThinkingLevel("low");
	await harness.commands.profile.handler("save captured --overwrite", context.ctx);
	const overwritten = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(overwritten.name, "Captured Writer");
	assert.equal(overwritten.description, "Writes project prose.");
	assert.equal(overwritten.autoActivate, true);
	assert.equal(overwritten.thinkingLevel, "low");

	await harness.commands.profile.handler("status", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /Last applied profile: \(none\)/);
});

test("/profile reload changes definitions without reapplying and /profile forget only clears provenance", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const initialModel = model("test", "initial");
	const targetModel = model("test", "target");
	writeProfile(cwd, "worker.json", profile("worker", targetModel, null));
	const { harness, context } = runtime(cwd, initialModel, [initialModel, targetModel]);
	await startSession(harness, context.ctx);
	await harness.commands.profile.handler("use worker", context.ctx);
	assert.equal(harness.setModelCalls.length, 1);

	writeProfile(cwd, "worker.json", profile("worker", initialModel, null, "low"));
	await harness.commands.profile.handler("reload", context.ctx);
	assert.equal(harness.setModelCalls.length, 1);
	assert.equal(harness.getCurrentModel(), targetModel);
	assert.equal(harness.getThinkingLevel(), "high");
	await harness.commands.profile.handler("status", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /Profile source: changed since application/);

	await harness.commands.profile.handler("forget", context.ctx);
	assert.equal(harness.getCurrentModel(), targetModel);
	assert.equal(harness.getThinkingLevel(), "high");
	assert.deepEqual(harness.appended.at(-1), { type: PROFILE_ENTRY_TYPE, data: { provenance: null } });
	await harness.commands.profile.handler("status", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /Last applied profile: \(none\)/);
});

test("session restoration restores profile provenance without applying its runtime snapshot", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "current");
	const targetModel = model("test", "target");
	const storedProfile = { ...profile("worker", targetModel, null), autoActivate: true };
	writeProfile(cwd, "worker.json", storedProfile);
	const provenance: AgentProfileProvenance = {
		profileId: "worker",
		sourcePath: agentProfilePath(cwd, "worker"),
		sourceFingerprint: agentProfileFingerprint(storedProfile),
		appliedAt: "2026-07-11T12:00:00.000Z",
		snapshot: {
			model: { provider: targetModel.provider, id: targetModel.id },
			thinkingLevel: "high",
			promptStack: null,
		},
	};
	const entries = [{
		id: "profile-entry",
		parentId: null,
		type: "custom",
		customType: PROFILE_ENTRY_TYPE,
		data: { provenance },
	}];
	const harness = createHarness({ currentModel, models: [currentModel, targetModel], thinkingLevel: "low" });
	const context = createContext(cwd, entries, { leafId: "profile-entry", modelRuntime: harness });

	await startSession(harness, context.ctx);
	assert.equal(harness.setModelCalls.length, 0);
	assert.equal(harness.getCurrentModel(), currentModel);
	assert.equal(harness.getThinkingLevel(), "low");
	await harness.commands.profile.handler("status", context.ctx);
	const status = context.editors.at(-1)?.text ?? "";
	assert.match(status, /Last applied profile: worker/);
	assert.match(status, /test\/target → test\/current/);
	assert.match(status, /high → low/);
});

test("untrusted fresh sessions browse but never auto-apply global profiles or stacks", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-global-"));
	const previousGlobal = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		const globalStacks = join(globalDir, "prompt-stacks");
		mkdirSync(globalStacks, { recursive: true });
		writeFileSync(join(globalStacks, "auto.json"), JSON.stringify({
			schemaVersion: 1,
			autoActivate: true,
			type: "pi-forge.prompt-stack",
			id: "global-auto",
			items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
		}));
		const globalProfiles = join(globalDir, "agent-profiles");
		mkdirSync(globalProfiles, { recursive: true });
		const currentModel = model("test", "current");
		const targetModel = model("test", "global-target");
		writeFileSync(join(globalProfiles, "global.json"), JSON.stringify({
			schemaVersion: 1,
			autoActivate: true,
			type: AGENT_PROFILE_TYPE,
			id: "global-profile",
			model: { provider: targetModel.provider, id: targetModel.id },
			thinkingLevel: "high",
			promptStack: null,
		}));

		const harness = createHarness({ currentModel, models: [currentModel, targetModel], availableModels: [currentModel, targetModel], thinkingLevel: "low" });
		const context = createContext(cwd, [], { trusted: false, modelRuntime: harness });
		await startSession(harness, context.ctx);

		assert.equal(harness.getCurrentModel(), currentModel);
		assert.equal(harness.getThinkingLevel(), "low");
		assert.equal(context.statuses["pi-forge"], undefined);
		assert.equal(harness.appended.some((entry) => entry.type === PROFILE_ENTRY_TYPE), false);
	} finally {
		if (previousGlobal === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobal;
	}
});

test("untrusted projects cannot apply or save profiles, but reload stays global-only", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-command-"));
	const currentModel = model("test", "current");
	const harness = createHarness({ currentModel, models: [currentModel], thinkingLevel: "off" });
	const context = createContext(cwd, [], { trusted: false, modelRuntime: harness });
	await startSession(harness, context.ctx);

	await harness.commands.profile.handler("save blocked", context.ctx);
	assert.equal(existsSync(agentProfilePath(cwd, "blocked")), false);
	assert.match(context.notifications.at(-1)?.message ?? "", /not trusted/);
	await harness.commands.profile.handler("reload", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /remain disabled/);
	await harness.commands.profile.handler("use blocked", context.ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /not trusted/);
});
