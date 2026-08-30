import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	AGENT_PROFILE_TYPE,
	agentProfileFingerprint,
	agentProfilePath,
	loadAgentProfiles,
	resolveAgentProfile,
	type AgentProfile,
	type AgentProfileProvenance,
} from "../src/agent-profile.ts";
import {
	applyResolvedAgentProfile,
	captureAgentProfile,
	createAgentProfilePreview,
	deleteAgentProfile,
	forgetAgentProfileProvenance,
	getAgentProfileRuntimeStatus,
	writeAgentProfile,
} from "../src/profile-service.ts";
import { PROFILE_ENTRY_TYPE } from "../src/session-adapter.ts";

function model(provider = "test", id = "model"): Model<any> {
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

function profile(id = "worker"): AgentProfile {
	return {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id,
		name: "Worker",
		description: "Shared service fixture.",
		autoActivate: true,
		model: { provider: "test", id: "target" },
		thinkingLevel: "high",
		promptStack: null,
	};
}

test("profile service captures runtime state while preserving editable metadata", () => {
	const existing = {
		filePath: "/tmp/worker.json",
		scope: "project" as const,
		key: { scope: "project" as const, id: profile().id },
		profile: profile(),
		diagnostics: [],
	};
	const captured = captureAgentProfile("worker", "project", {
		model: { provider: "test", id: "replacement" },
		thinkingLevel: "medium",
		promptStack: { scope: "project", id: "reviewer" },
	}, existing);

	assert.equal(captured.ok, true);
	if (!captured.ok) return;
	assert.equal(captured.profile.name, "Worker");
	assert.equal(captured.profile.description, "Shared service fixture.");
	assert.equal(captured.profile.autoActivate, true);
	assert.deepEqual(captured.profile.model, { provider: "test", id: "replacement" });
	assert.equal(captured.profile.thinkingLevel, "medium");
	assert.equal(captured.profile.promptStack, "reviewer");

	const missingModel = captureAgentProfile("worker", "project", { model: null, thinkingLevel: "off", promptStack: null });
	assert.equal(missingModel.ok, false);
	assert.match(missingModel.diagnostics[0]?.message ?? "", /without a selected model/);
});

test("profile repository writes, protects, and deletes project-local profiles", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-service-"));
	const value = profile();
	const first = writeAgentProfile(cwd, value);

	assert.equal(first.ok, true);
	const filePath = agentProfilePath(cwd, value.id);
	assert.equal(existsSync(filePath), true);
	assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), value);
	assert.equal(writeAgentProfile(cwd, value).ok, false);

	const changed = { ...value, thinkingLevel: "low" as const };
	const overwrite = writeAgentProfile(cwd, changed, { overwrite: true });
	assert.equal(overwrite.ok, true);
	assert.equal(JSON.parse(readFileSync(filePath, "utf8")).thinkingLevel, "low");

	const outside = writeAgentProfile(cwd, value, { filePath: join(cwd, "outside.json"), overwrite: true });
	assert.deepEqual(outside.ok ? undefined : outside.reason, "invalid-path");

	const loaded = loadAgentProfiles(cwd)[0]!;
	writeFileSync(filePath, JSON.stringify({ ...loaded.profile, name: "Externally replaced" }, null, 2));
	const staleDelete = deleteAgentProfile(cwd, loaded);
	assert.deepEqual(staleDelete.ok ? undefined : staleDelete.reason, "changed");
	assert.equal(existsSync(filePath), true);
	writeFileSync(filePath, JSON.stringify(loaded.profile, null, 2));
	assert.deepEqual(deleteAgentProfile(cwd, loaded), { ok: true, filePath });
	assert.equal(existsSync(filePath), false);
	assert.equal(deleteAgentProfile(cwd, loaded).ok, false);

	const outsideTarget = join(cwd, "outside-target.json");
	writeFileSync(outsideTarget, "outside\n");
	symlinkSync(outsideTarget, filePath);
	const symlinkOverwrite = writeAgentProfile(cwd, changed, { filePath, overwrite: true });
	assert.deepEqual(symlinkOverwrite.ok ? undefined : symlinkOverwrite.reason, "invalid-path");
	assert.equal(readFileSync(outsideTarget, "utf8"), "outside\n");
	assert.deepEqual(deleteAgentProfile(cwd, { ...loaded, filePath }).ok, false);
	assert.equal(readFileSync(outsideTarget, "utf8"), "outside\n");
});

test("profile service returns immutable typed preview and drift status", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-service-"));
	const value = profile();
	assert.equal(writeAgentProfile(cwd, value).ok, true);
	const loaded = loadAgentProfiles(cwd)[0]!;
	const targetModel = model("test", "target");
	const resolved = resolveAgentProfile(loaded, { models: [targetModel], availableModels: [targetModel], promptStacks: [] });
	const current = {
		model: { provider: "test", id: "current" },
		thinkingLevel: "low" as const,
		promptStack: "writer",
		effectiveTools: ["read", "bash"],
	};
	const preview = createAgentProfilePreview(resolved, current, ["read"]);

	assert.equal(preview.applicable, true);
	assert.deepEqual(preview.current, current);
	assert.deepEqual(preview.target.model, value.model);
	assert.deepEqual(preview.target.effectiveTools, ["read"]);
	current.effectiveTools.push("write");
	assert.deepEqual(preview.current.effectiveTools, ["read", "bash"]);

	const provenance: AgentProfileProvenance = {
		profileId: value.id,
		sourcePath: loaded.filePath,
		sourceFingerprint: agentProfileFingerprint(value),
		appliedAt: "2026-07-12T12:00:00.000Z",
		snapshot: { model: value.model, thinkingLevel: value.thinkingLevel, promptStack: value.promptStack },
	};
	const status = getAgentProfileRuntimeStatus([loaded], provenance, preview.current);
	assert.equal(status.lastApplied?.sourceState, "unchanged");
	assert.equal(status.lastApplied?.drift.model.changed, true);
	assert.equal(status.lastApplied?.drift.thinkingLevel.changed, true);
	assert.equal(status.lastApplied?.drift.promptStack.changed, true);

	const changedSource = { ...loaded, profile: { ...loaded.profile, description: "Changed" } };
	assert.equal(getAgentProfileRuntimeStatus([changedSource], provenance, preview.current).lastApplied?.sourceState, "changed");
	assert.equal(getAgentProfileRuntimeStatus([], provenance, preview.current).lastApplied?.sourceState, "missing");
});

test("profile service applies and forgets provenance independently of command rendering", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-service-"));
	const value = profile();
	assert.equal(writeAgentProfile(cwd, value).ok, true);
	const targetModel = model("test", "target");
	const initialModel = model("test", "initial");
	const resolved = resolveAgentProfile(loadAgentProfiles(cwd)[0]!, {
		models: [initialModel, targetModel],
		availableModels: [initialModel, targetModel],
		promptStacks: [],
	});
	let currentModel = initialModel;
	let thinkingLevel = "low";
	const appended: Array<{ type: string; data: unknown }> = [];
	const pi = {
		async setModel(next: Model<any>) {
			currentModel = next;
			return true;
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (next: string) => {
			thinkingLevel = next;
		},
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	};
	const ctx = { get model() { return currentModel; } };
	const state: { lastAppliedProfile?: AgentProfileProvenance } = {};
	const result = await applyResolvedAgentProfile(pi as any, state, { setActive: (id) => id === "none" }, resolved, ctx as any);

	assert.equal(result.ok, true);
	assert.equal(currentModel, targetModel);
	assert.equal(thinkingLevel, "high");
	assert.equal(state.lastAppliedProfile?.profileId, "worker");
	assert.equal(appended.at(-1)?.type, PROFILE_ENTRY_TYPE);
	assert.equal(forgetAgentProfileProvenance(pi as any, state), true);
	assert.deepEqual(appended.at(-1), { type: PROFILE_ENTRY_TYPE, data: { provenance: null } });
	assert.equal(forgetAgentProfileProvenance(pi as any, state), false);
});

test("captureAgentProfile serializes promptStack relative to target scope", () => {
	const runtime = {
		model: { provider: "test", id: "model" },
		thinkingLevel: "off" as const,
	};

	// Same scope -> bare ID.
	const projectSame = captureAgentProfile("worker", "project", {
		...runtime,
		promptStack: { scope: "project", id: "reviewer" },
	});
	assert.equal(projectSame.ok, true);
	if (projectSame.ok) assert.equal(projectSame.profile.promptStack, "reviewer");

	// Project profile referencing a global stack -> qualified.
	const projectToGlobal = captureAgentProfile("worker", "project", {
		...runtime,
		promptStack: { scope: "global", id: "reviewer" },
	});
	assert.equal(projectToGlobal.ok, true);
	if (projectToGlobal.ok) assert.equal(projectToGlobal.profile.promptStack, "global:reviewer");

	// Global profile referencing a project stack is rejected.
	const globalToProject = captureAgentProfile("worker", "global", {
		...runtime,
		promptStack: { scope: "project", id: "reviewer" },
	});
	assert.equal(globalToProject.ok, false);
	if (!globalToProject.ok) {
		assert.match(globalToProject.diagnostics[0]?.message ?? "", /Cannot capture a global profile referencing a project preset/);
	}

	// Global profile with its own global stack -> bare ID.
	const globalSame = captureAgentProfile("worker", "global", {
		...runtime,
		promptStack: { scope: "global", id: "reviewer" },
	});
	assert.equal(globalSame.ok, true);
	if (globalSame.ok) assert.equal(globalSame.profile.promptStack, "reviewer");
});
