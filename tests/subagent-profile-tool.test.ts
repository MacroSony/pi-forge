import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LoadedAgentProfile, ResolvedAgentProfile } from "../src/agent-profile.ts";
import { registerForgeSubagentProfilesTool } from "../src/subagent-profile-tool.ts";

// Keep global-config discovery hermetic; delegation policy is project-only.
const GLOBAL_CONFIG_PATH = join(tmpdir(), `pi-forge-profiles-tool-${process.pid}.json`);
process.env.PI_FORGE_GLOBAL_CONFIG_PATH = GLOBAL_CONFIG_PATH;
const TEST_CWD = join(tmpdir(), `pi-forge-profiles-tool-project-${process.pid}`);
const TEST_CONFIG_DIR = join(TEST_CWD, ".pi", "forge");
mkdirSync(TEST_CONFIG_DIR, { recursive: true });
writeFileSync(join(TEST_CONFIG_DIR, "config.json"), JSON.stringify({
	subagents: {
		profiles: {
			reviewer: { enabled: true },
			broken: { enabled: true },
		},
	},
}), "utf8");
test.after(() => {
	rmSync(GLOBAL_CONFIG_PATH, { force: true });
	rmSync(TEST_CWD, { recursive: true, force: true });
});

test("forge_subagent_profiles exposes ready profile descriptions and unavailable diagnostics without egress", async () => {
	const reviewer = loadedProfile("reviewer", "Reviews code and architecture.", "Review specialist");
	const broken = loadedProfile("broken", "Currently unavailable.");
	const hidden = loadedProfile("hidden", "Must not be exposed.");
	const profiles = [reviewer, broken, hidden];
	let resolveCalls = 0;
	let invocationActive = true;
	const registered: Record<string, any> = {};

	registerForgeSubagentProfilesTool(
		{
			registerTool: (tool: any) => { registered[tool.name] = tool; },
			getActiveTools: () => invocationActive ? ["forge_subagent_profiles", "forge_subagent"] : ["forge_subagent_profiles"],
		} as any,
		() => profiles,
		(loaded) => {
			resolveCalls++;
			return resolvedProfile(loaded, loaded === broken ? "Model authentication is missing." : undefined);
		},
	);

	const tool = registered.forge_subagent_profiles;
	assert.ok(tool);
	assert.deepEqual(tool.parameters.properties, {});
	const result = await tool.execute("catalog", {}, undefined, undefined, trustedContext());

	assert.equal(resolveCalls, 2);
	assert.equal(result.details.status, "completed");
	assert.equal(result.details.invocationToolAvailable, true);
	assert.equal(result.details.approvalMode, "interactive");
	assert.deepEqual(result.details.defaultBackend, { id: "pi-subprocess-readonly", source: "built-in" });
	assert.deepEqual(result.details.timeout, { milliseconds: 60_000, source: "built-in" });
	assert.match(result.content[0].text, /Default backend: pi-subprocess-readonly \(built-in\)/);
	assert.match(result.content[0].text, /Timeout: 60000 ms \(built-in; best-effort host abort\)/);
	assert.equal(result.details.profiles[0].description, "Reviews code and architecture.");
	assert.equal(result.details.profiles[0].status, "ready");
	assert.equal(result.details.profiles[1].status, "unavailable");
	assert.equal(result.details.profiles.some((profile: any) => profile.id === "hidden"), false);
	assert.match(result.content[0].text, /reviewer — Review specialist/);
	assert.match(result.content[0].text, /Description: Reviews code and architecture\./);
	assert.match(result.content[0].text, /Parent invocation tool: active/);
	assert.match(result.content[0].text, /test-provider\/test-model; thinking: high; stack: reviewer-stack/);
	assert.match(result.content[0].text, /Unavailable because: Model authentication is missing\./);
	assert.match(result.content[0].text, /Execution: backend pi-subprocess-readonly \(built-in\); timeout 60000 ms/);

	invocationActive = false;
	const policyBlocked = await tool.execute("catalog", {}, undefined, undefined, trustedContext());
	assert.equal(policyBlocked.details.invocationToolAvailable, false);
	assert.match(policyBlocked.content[0].text, /current tool policy must permit forge_subagent/);
});

test("forge_subagent_profiles fails closed for an untrusted project", async () => {
	let profileReads = 0;
	let tool: any;
	registerForgeSubagentProfilesTool(
		{
			registerTool: (definition: any) => { tool = definition; },
			getActiveTools: () => ["forge_subagent_profiles"],
		} as any,
		() => {
			profileReads++;
			return [];
		},
		() => { throw new Error("must not resolve"); },
	);

	const result = await tool.execute("catalog", {}, undefined, undefined, trustedContext(false));
	assert.equal(result.details.status, "disabled");
	assert.equal(result.details.invocationToolAvailable, false);
	assert.deepEqual(result.details.profiles, []);
	assert.match(result.content[0].text, /project is not trusted/);
	assert.equal(profileReads, 0);
});

test("forge_subagent_profiles exposes trusted-project unattended approval mode", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-unattended-profiles-"));
	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({
		subagents: {
			allowAgentInvocationWithoutApproval: true,
			profiles: { reviewer: { enabled: true } },
		},
	}), "utf8");
	let tool: any;
	registerForgeSubagentProfilesTool(
		{
			registerTool: (definition: any) => { tool = definition; },
			getActiveTools: () => ["forge_subagent_profiles", "forge_subagent"],
		} as any,
		() => [loadedProfile("reviewer", "Reviews code.")],
		(loaded) => resolvedProfile(loaded),
	);
	try {
		const result = await tool.execute("catalog", {}, undefined, undefined, { cwd, isProjectTrusted: () => true });
		assert.equal(result.details.approvalMode, "unattended-config");
		assert.match(result.content[0].text, /may contact the provider without per-run human approval/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("forge_subagent_profiles reports per-profile backend and timeout overrides", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-backend-profiles-"));
	const configDir = join(cwd, ".pi", "forge");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "config.json"), JSON.stringify({
		subagents: {
			profiles: {
				reviewer: { enabled: true, backend: "pi-rpc-readonly", timeoutMs: 300_000 },
			},
		},
	}), "utf8");
	let tool: any;
	registerForgeSubagentProfilesTool(
		{
			registerTool: (definition: any) => { tool = definition; },
			getActiveTools: () => ["forge_subagent_profiles", "forge_subagent"],
		} as any,
		() => [loadedProfile("reviewer", "Reviews code.")],
		(loaded) => resolvedProfile(loaded),
	);
	try {
		const result = await tool.execute("catalog", {}, undefined, undefined, { cwd, isProjectTrusted: () => true });
		assert.deepEqual(result.details.defaultBackend, { id: "pi-subprocess-readonly", source: "built-in" });
		assert.deepEqual(result.details.timeout, { milliseconds: 60_000, source: "built-in" });
		assert.deepEqual(result.details.profiles[0].backend, { id: "pi-rpc-readonly", source: "project-profile" });
		assert.deepEqual(result.details.profiles[0].timeout, { milliseconds: 300_000, source: "project-profile" });
		assert.match(result.content[0].text, /Execution: backend pi-rpc-readonly \(project profile override\); timeout 300000 ms \(project profile override/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function loadedProfile(id: string, description: string, name?: string): LoadedAgentProfile {
	return {
		filePath: `/workspace/.pi/forge/agent-profiles/${id}.json`,
		scope: "project",
		key: { scope: "project", id },
		diagnostics: [],
		profile: {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id,
			name,
			description,
			model: { provider: "test-provider", id: "test-model" },
			thinkingLevel: "high",
			promptStack: "reviewer-stack",
		},
	};
}

function resolvedProfile(loaded: LoadedAgentProfile, error?: string): ResolvedAgentProfile {
	return {
		loaded,
		model: error ? undefined : { provider: loaded.profile.model.provider, id: loaded.profile.model.id } as any,
		promptStack: undefined,
		effectiveThinkingLevel: loaded.profile.thinkingLevel,
		diagnostics: error ? [{ level: "error", field: "model", message: error }] : [],
	};
}

function trustedContext(trusted = true) {
	return { cwd: TEST_CWD, isProjectTrusted: () => trusted } as any;
}
