import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	AGENT_PROFILE_TYPE,
	agentProfileFingerprint,
	agentProfilesDir,
	chooseAutoActivateAgentProfile,
	hasAutoActivateAgentProfile,
	isResolvedAgentProfileUsable,
	isUsableAgentProfile,
	loadAgentProfileFile,
	loadAgentProfiles,
	resolveAgentProfile,
	validateAgentProfilePromptStackScope,
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
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
		promptStack: "reviewer",
	});

	const profiles = loadAgentProfiles(cwd);

	assert.equal(profiles.length, 1);
	assert.equal(profiles[0]?.profile.id, "reviewer");
	assert.equal(profiles[0]?.profile.promptStack, "reviewer");
	assert.equal(profiles[0]?.profile.autoActivate, true);
	assert.equal(chooseAutoActivateAgentProfile(profiles)?.profile.id, "reviewer");
	assert.equal(hasAutoActivateAgentProfile(profiles), true);
	assert.equal(isUsableAgentProfile(profiles[0]!), true);
	assert.equal(profiles[0]?.diagnostics.length, 0);
});

test("loadAgentProfiles rejects ambiguous auto-activation", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	for (const name of ["reviewer", "writer"]) {
		writeProfile(cwd, `${name}.json`, {
			schemaVersion: 1,
			type: AGENT_PROFILE_TYPE,
			id: name,
			autoActivate: true,
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: "high",
			promptStack: null,
		});
	}

	const profiles = loadAgentProfiles(cwd);
	assert.equal(chooseAutoActivateAgentProfile(profiles), undefined);
	assert.equal(hasAutoActivateAgentProfile(profiles), true);
	for (const loaded of profiles) {
		assert.match(loaded.diagnostics.find((diagnostic) => diagnostic.field === "autoActivate")?.message ?? "", /exactly one is allowed/);
		assert.equal(isUsableAgentProfile(loaded), false);
	}
});

test("loadAgentProfiles rejects inert and malformed fields", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	writeProfile(cwd, "bad.json", {
		schemaVersion: 2,
		type: "other-profile",
		id: "../bad",
		model: { provider: "", id: "model", topP: 0.9 },
		thinkingLevel: "turbo",
		autoActivate: "yes",
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
	assert.match(messages, /autoActivate must be a boolean/);
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
		assert.match(loaded.diagnostics.find((diagnostic) => /Duplicate (project )?profile id/.test(diagnostic.message))?.message ?? "", /a\.json, b\.json/);
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

test("resolveAgentProfile warns when allowed tool patterns match no registered tools", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-profile-"));
	writeStack(cwd, "researcher");
	const stackPath = join(promptStacksDir(cwd), "researcher.json");
	const stack = JSON.parse(readFileSync(stackPath, "utf8"));
	stack.tools = { allow: ["read", "web_*"] };
	writeFileSync(stackPath, JSON.stringify(stack, null, 2));
	writeProfile(cwd, "researcher.json", {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id: "researcher",
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: "researcher",
	});
	const targetModel = model();

	const resolved = resolveAgentProfile(loadAgentProfiles(cwd)[0]!, {
		models: [targetModel],
		availableModels: [targetModel],
		promptStacks: loadPromptStacks(cwd),
		toolNames: ["read"],
	});

	assert.equal(isResolvedAgentProfileUsable(resolved), true);
	assert.match(resolved.diagnostics.find((diagnostic) => diagnostic.level === "warning")?.message ?? "", /web_\*.*matches no registered tools/);
});

test("resolveAgentProfile resolves promptStack relative to profile scope", () => {
	const targetModel = model();
	const resources = (stacks: Array<{ scope: "global" | "project"; id: string }>) => ({
		models: [targetModel],
		availableModels: [targetModel],
		promptStacks: stacks.map(({ scope, id }) => ({
			scope,
			key: { scope, id },
			filePath: `/${scope}/${id}.json`,
			diagnostics: [],
			stack: { schemaVersion: 1 as const, type: "pi-forge.prompt-stack" as const, id, items: [] },
		})),
	});

	function loaded(scope: "global" | "project", id: string, promptStack: string | null): ReturnType<typeof loadAgentProfileFile> {
		return {
			scope,
			key: { scope, id },
			filePath: `/${scope}/${id}.json`,
			diagnostics: [],
			profile: {
				schemaVersion: 1,
				type: AGENT_PROFILE_TYPE,
				id,
				model: { provider: targetModel.provider, id: targetModel.id },
				thinkingLevel: "high",
				promptStack,
			},
		};
	}

	// Project profile with bare id resolves its own project stack, not a same-ID global stack.
	const collision = resources([{ scope: "global", id: "reviewer" }, { scope: "project", id: "reviewer" }]);
	const projectBare = resolveAgentProfile(loaded("project", "p", "reviewer"), collision);
	assert.equal(projectBare.promptStack?.scope, "project");

	// Project profile can explicitly reference a global stack.
	const globalExplicit = resolveAgentProfile(loaded("project", "p", "global:reviewer"), collision);
	assert.equal(globalExplicit.promptStack?.scope, "global");

	// Project profile with a missing project stack gets a global suggestion, no fallback.
	const missing = resolveAgentProfile(loaded("project", "p", "missing"), collision);
	assert.equal(missing.promptStack, undefined);
	assert.match(
		missing.diagnostics.find((diagnostic) => diagnostic.field === "promptStack")?.message ?? "",
		/Unknown prompt stack: missing/,
	);

	// Global profile referencing a project stack is rejected.
	const globalToProject = resolveAgentProfile(loaded("global", "g", "project:reviewer"), collision);
	assert.equal(globalToProject.promptStack, undefined);
	assert.match(
		globalToProject.diagnostics.find((diagnostic) => diagnostic.field === "promptStack")?.message ?? "",
		/cannot reference project prompt stack/,
	);

	// Global profile with a bare id resolves its own global stack.
	const globalOnly = resources([{ scope: "global", id: "reviewer" }]);
	const globalBare = resolveAgentProfile(loaded("global", "g", "reviewer"), globalOnly);
	assert.equal(globalBare.promptStack?.scope, "global");
});

test("validateAgentProfilePromptStackScope rejects global-to-project references", () => {
	const base = {
		schemaVersion: 1 as const,
		type: AGENT_PROFILE_TYPE,
		id: "reviewer",
		model: { provider: "test", id: "model" },
		thinkingLevel: "high" as const,
		promptStack: null,
	};
	assert.deepEqual(validateAgentProfilePromptStackScope(base, "global"), []);
	assert.deepEqual(validateAgentProfilePromptStackScope({ ...base, promptStack: "shared" }, "global"), []);
	assert.deepEqual(validateAgentProfilePromptStackScope({ ...base, promptStack: "global:shared" }, "project"), []);
	const rejected = validateAgentProfilePromptStackScope({ ...base, promptStack: "project:shared" }, "global");
	assert.equal(rejected.length, 1);
	assert.match(rejected[0]?.message ?? "", /cannot reference project prompt stack/);
});

test("chooseAutoActivateAgentProfile honors project-over-global shadowing", () => {
	const base = {
		schemaVersion: 1 as const,
		type: AGENT_PROFILE_TYPE,
		id: "reviewer",
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high" as const,
		promptStack: null,
	};
	const globalLoaded = {
		profile: { ...base, autoActivate: true },
		filePath: "/global/reviewer.json",
		scope: "global" as const,
		key: { scope: "global" as const, id: "reviewer" },
		diagnostics: [],
	};
	const projectLoaded = {
		profile: { ...base, autoActivate: false },
		filePath: "/project/reviewer.json",
		scope: "project" as const,
		key: { scope: "project" as const, id: "reviewer" },
		diagnostics: [],
	};
	// The shadowed global auto-activate candidate must not win over the same-ID
	// project profile that explicitly opts out.
	assert.equal(chooseAutoActivateAgentProfile([globalLoaded, projectLoaded]), undefined);
	// Without the shadowing project profile, the global candidate still activates.
	assert.equal(chooseAutoActivateAgentProfile([globalLoaded])?.profile.id, "reviewer");
	// A same-ID project profile shadows the global definition even without an
	// explicit autoActivate field — matching chooseAutoActivateStack semantics.
	const projectNeutral = {
		...projectLoaded,
		profile: { ...base },
	};
	assert.equal(chooseAutoActivateAgentProfile([globalLoaded, projectNeutral]), undefined);
});
