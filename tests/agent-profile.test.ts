import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	AGENT_PROFILE_TYPE,
	agentProfileFingerprint,
	agentProfilesDir,
	isResolvedAgentProfileUsable,
	isUsableAgentProfile,
	loadAgentProfiles,
	resolveAgentProfile,
} from "../src/agent-profile.ts";
import { loadPromptStacks, promptStacksDir } from "../src/loader.ts";

function writeProfile(cwd: string, name: string, value: unknown): void {
	mkdirSync(agentProfilesDir(cwd), { recursive: true });
	writeFileSync(join(agentProfilesDir(cwd), name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function writeStack(cwd: string, id: string, items: unknown[] = [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }]): void {
	mkdirSync(promptStacksDir(cwd), { recursive: true });
	writeFileSync(join(promptStacksDir(cwd), `${id}.json`), JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id,
		items,
	}, null, 2));
}

function model(provider = "test-provider", id = "test-model", reasoning = true): Model<any> {
	return {
		api: "openai-completions",
		provider,
		id,
		name: id,
		baseUrl: "http://localhost.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

test("loadAgentProfiles reads a valid project profile", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	writeProfile(cwd, "reviewer.json", {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id: "reviewer",
		name: "Reviewer",
		description: "Reviews code.",
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
		promptStack: "reviewer",
	});

	const profiles = loadAgentProfiles(cwd);

	assert.equal(profiles.length, 1);
	assert.equal(profiles[0]?.profile.id, "reviewer");
	assert.equal(profiles[0]?.profile.promptStack, "reviewer");
	assert.equal(isUsableAgentProfile(profiles[0]!), true);
	assert.equal(profiles[0]?.diagnostics.length, 0);
});

test("loadAgentProfiles rejects inert and malformed fields", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	writeProfile(cwd, "bad.json", {
		schemaVersion: 2,
		type: "other-profile",
		id: "../bad",
		model: { provider: "", id: "model", topP: 0.9 },
		thinkingLevel: "turbo",
		tools: ["read"],
	});

	const loaded = loadAgentProfiles(cwd)[0]!;
	const messages = loaded.diagnostics.map((diagnostic) => `${diagnostic.field ?? ""} ${diagnostic.message}`).join("\n");

	assert.equal(isUsableAgentProfile(loaded), false);
	assert.match(messages, /Unsupported profile field: tools/);
	assert.match(messages, /Unsupported model field: topP/);
	assert.match(messages, /schemaVersion must be 1/);
	assert.match(messages, /type must be "pi-forge\.agent-profile"/);
	assert.match(messages, /Profile id must start/);
	assert.match(messages, /thinkingLevel must be one of/);
	assert.match(messages, /promptStack is required/);
});

test("loadAgentProfiles reports invalid JSON and duplicate profile ids", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	writeProfile(cwd, "broken.json", "{ nope");
	for (const name of ["a.json", "b.json"]) {
		writeProfile(cwd, name, {
			schemaVersion: 1,
			type: AGENT_PROFILE_TYPE,
			id: "same",
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: "off",
			promptStack: null,
		});
	}

	const profiles = loadAgentProfiles(cwd);
	const broken = profiles.find((loaded) => loaded.filePath.endsWith("broken.json"))!;
	const duplicates = profiles.filter((loaded) => loaded.profile.id === "same");

	assert.match(broken.diagnostics[0]?.message ?? "", /Failed to parse JSON/);
	assert.equal(duplicates.length, 2);
	for (const loaded of duplicates) {
		assert.match(loaded.diagnostics.find((diagnostic) => /Duplicate profile id/.test(diagnostic.message))?.message ?? "", /a\.json, b\.json/);
	}
});

test("resolveAgentProfile resolves exact model, thinking level, and prompt stack", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	writeStack(cwd, "reviewer");
	writeProfile(cwd, "reviewer.json", {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id: "reviewer",
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
		promptStack: "reviewer",
	});
	const targetModel = model();
	const loaded = loadAgentProfiles(cwd)[0]!;

	const resolved = resolveAgentProfile(loaded, {
		models: [targetModel],
		availableModels: [targetModel],
		promptStacks: loadPromptStacks(cwd),
	});

	assert.equal(isResolvedAgentProfileUsable(resolved), true);
	assert.equal(resolved.model, targetModel);
	assert.equal(resolved.effectiveThinkingLevel, "high");
	assert.equal(resolved.promptStack?.stack.id, "reviewer");
	assert.equal(resolved.diagnostics.length, 0);
	assert.equal(agentProfileFingerprint(loaded.profile), JSON.stringify(loaded.profile));
});

test("resolveAgentProfile blocks missing auth, unsupported thinking, and bad stack references", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	writeStack(cwd, "bad-stack", []);
	writeProfile(cwd, "bad-runtime.json", {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id: "bad-runtime",
		model: { provider: "test-provider", id: "plain-model" },
		thinkingLevel: "high",
		promptStack: "bad-stack",
	});
	const plainModel = model("test-provider", "plain-model", false);

	const resolved = resolveAgentProfile(loadAgentProfiles(cwd)[0]!, {
		models: [plainModel],
		availableModels: [],
		promptStacks: loadPromptStacks(cwd),
	});
	const messages = resolved.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

	assert.equal(isResolvedAgentProfileUsable(resolved), false);
	assert.equal(resolved.effectiveThinkingLevel, "off");
	assert.match(messages, /has no configured authentication/);
	assert.match(messages, /would clamp it to off/);
	assert.match(messages, /Prompt stack bad-stack: No enabled chat-history slot found/);
});

test("resolveAgentProfile reports unknown models and prompt stacks", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	writeProfile(cwd, "missing.json", {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id: "missing",
		model: { provider: "missing-provider", id: "missing-model" },
		thinkingLevel: "off",
		promptStack: "missing-stack",
	});

	const resolved = resolveAgentProfile(loadAgentProfiles(cwd)[0]!, { models: [], availableModels: [], promptStacks: [] });
	const messages = resolved.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

	assert.match(messages, /Unknown model: missing-provider\/missing-model/);
	assert.match(messages, /Unknown prompt stack: missing-stack/);
});
