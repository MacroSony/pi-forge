import assert from "node:assert/strict";
import test from "node:test";
import type { LoadedAgentProfile, ResolvedAgentProfile } from "../src/agent-profile.ts";
import { registerForgeSubagentProfilesTool } from "../src/subagent-profile-tool.ts";

test("forge_subagent_profiles exposes ready profile descriptions and unavailable diagnostics without egress", async () => {
	const reviewer = loadedProfile("reviewer", "Reviews code and architecture.", "Review specialist");
	const broken = loadedProfile("broken", "Currently unavailable.");
	const profiles = [reviewer, broken];
	let resolveCalls = 0;
	const registered: Record<string, any> = {};

	registerForgeSubagentProfilesTool(
		{ registerTool: (tool: any) => { registered[tool.name] = tool; } } as any,
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
	assert.equal(result.details.profiles[0].description, "Reviews code and architecture.");
	assert.equal(result.details.profiles[0].status, "ready");
	assert.equal(result.details.profiles[1].status, "unavailable");
	assert.match(result.content[0].text, /reviewer — Review specialist/);
	assert.match(result.content[0].text, /Description: Reviews code and architecture\./);
	assert.match(result.content[0].text, /test-provider\/test-model; thinking: high; stack: reviewer-stack/);
	assert.match(result.content[0].text, /Unavailable because: Model authentication is missing\./);
});

test("forge_subagent_profiles fails closed for an untrusted project", async () => {
	let profileReads = 0;
	let tool: any;
	registerForgeSubagentProfilesTool(
		{ registerTool: (definition: any) => { tool = definition; } } as any,
		() => {
			profileReads++;
			return [];
		},
		() => { throw new Error("must not resolve"); },
	);

	const result = await tool.execute("catalog", {}, undefined, undefined, trustedContext(false));
	assert.equal(result.details.status, "disabled");
	assert.deepEqual(result.details.profiles, []);
	assert.match(result.content[0].text, /project is not trusted/);
	assert.equal(profileReads, 0);
});

function loadedProfile(id: string, description: string, name?: string): LoadedAgentProfile {
	return {
		filePath: `/workspace/.pi/forge/agent-profiles/${id}.json`,
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
	return { isProjectTrusted: () => trusted } as any;
}
