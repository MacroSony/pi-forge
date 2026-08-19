import assert from "node:assert/strict";
import test from "node:test";
import {
	AGENT_PROFILE_TYPE,
	agentProfileFingerprint,
	type AgentProfile,
	type LoadedAgentProfile,
} from "../src/agent-profile.ts";
import {
	canonicalSubagentJson,
	subagentFingerprint,
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
} from "../src/subagent/fingerprints.ts";
import {
	collectSubagentPromptDependencies,
	negotiateForgeDelegationTools,
	prepareForgeDelegation,
	resolveSubagentHostProfile,
} from "../src/subagent-host.ts";
import { registerMacro } from "../src/macro-engine.ts";
import type { LoadedPromptStack, PromptStack } from "../src/types.ts";

function profile(promptStack: string | null = "worker"): AgentProfile {
	return {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id: "worker",
		name: undefined,
		description: undefined,
		autoActivate: undefined,
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		promptStack,
	};
}

function loadedProfile(promptStack: string | null = "worker"): LoadedAgentProfile {
	return { profile: profile(promptStack), filePath: "/project/.pi/forge/agent-profiles/worker.json", scope: "project", key: { scope: "project", id: "worker" }, diagnostics: [] };
}

function promptStack(overrides: Partial<PromptStack> = {}): LoadedPromptStack {
	return {
		filePath: "/project/.pi/forge/prompt-stacks/worker.json",
		scope: "project",
		key: { scope: "project", id: "worker" },
		diagnostics: [],
		stack: {
			schemaVersion: 1,
			id: "worker",
			mode: "replace",
			tools: { allow: ["read", "paint_*"] },
			items: [
				{ kind: "block", id: "system", role: "system", content: "Built in {{date}} and custom {{ extensions.customMacro }}." },
				{ kind: "slot", id: "custom", role: "system", slot: "custom-slot" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
			...overrides,
		},
	};
}

function hasErrors(diagnostics: readonly { level: string }[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.level === "error");
}

test("Forge-owned canonical fingerprints match the runtime golden vectors", () => {
	// Golden values produced by @zihanw/pi-subagent-runtime's canonical
	// implementation; the vendored helper must stay byte-compatible so host
	// fingerprints remain comparable with client-recomputed ones.
	assert.equal(canonicalSubagentJson({ z: 1, a: { d: 2, b: 1 }, omitted: undefined }), '{"a":{"b":1,"d":2},"z":1}');
	assert.equal(subagentFingerprint({ z: 1, a: { d: 2, b: 1 }, omitted: undefined }), "sha256:v1:7abf5da5469eb969a507f9772e693effee5ed11b4ad9dcdccbe160d292dfcd68");
	assert.equal(subagentSourceProfileFingerprint(profile()), "sha256:v1:f209ac6b0ec3e1c7decc3cea8807856931596509dcdbce1a4c7d3eaeb1ccb8df");
	const goldenStack: PromptStack = {
		schemaVersion: 1,
		id: "worker",
		mode: "replace",
		tools: { allow: ["read", "paint_*"] },
		items: [{ kind: "block", id: "system", role: "system", content: "Built in {{date}} and custom {{ extensions.customMacro }}." }],
	};
	assert.equal(subagentPromptStackFingerprint(goldenStack), "sha256:v1:1bb1aa5f470fc57bf136f63026ee63acfff6e46f97eadbea49029781391742c5");
	assert.equal(subagentFingerprint([1, "two", null, true, { k: [3.5, -0] }]), "sha256:v1:4007e4aed33cd61f0e0536980bbeef8325130d3fda275b747ddd58f1bbd42139");
	assert.equal(subagentFingerprint("fixture"), "sha256:v1:b086de7b32510701e873f3d4ae742917ca1cc1141ffe4a8387d604ef474ef9e4");
	assert.equal(subagentFingerprint({ b: 2, a: 1 }), subagentFingerprint({ a: 1, b: 2 }));
	assert.throws(() => canonicalSubagentJson({ value: Number.NaN }), /non-finite/);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.throws(() => canonicalSubagentJson(cyclic), /cyclic/);
	// Legacy provenance fingerprinting is unchanged and deliberately distinct.
	assert.equal(agentProfileFingerprint(profile()), JSON.stringify(profile()));
});

test("host resolution is model-registry independent and records custom dependencies", () => {
	const resolved = resolveSubagentHostProfile(loadedProfile(), {
		promptStacks: [promptStack()],
		registrations: {
			macros: [{ name: "customMacro", source: "extension-a" }],
			slots: [{ name: "custom-slot", source: "extension-a" }],
		},
	});
	assert.equal(hasErrors(resolved.diagnostics), false);
	assert.deepEqual(resolved.dependencies.map(({ kind, name }) => ({ kind, name })), [
		{ kind: "macro", name: "customMacro" },
		{ kind: "slot", name: "custom-slot" },
	]);
	assert.equal(resolved.snapshot?.profile.model.id, "model");
	assert.match(resolved.snapshot?.profileFingerprint ?? "", /^sha256:v1:/);
	assert.equal("model" in resolved, false);

	const missing = resolveSubagentHostProfile(loadedProfile(), { promptStacks: [promptStack()], registrations: { macros: [], slots: [] } });
	assert.equal(hasErrors(missing.diagnostics), true);
	assert.equal(missing.snapshot, undefined);
	assert.deepEqual(missing.missingDependencies, [
		{ kind: "macro", name: "customMacro" },
		{ kind: "slot", name: "custom-slot" },
	]);

	const noStack = resolveSubagentHostProfile(loadedProfile(null), { promptStacks: [], registrations: { macros: [], slots: [] } });
	assert.equal(noStack.snapshot?.promptStack, null);
	assert.equal(noStack.snapshot?.promptStackFingerprint, null);
	for (const mode of [undefined, "replace", "append", "prepend"] as const) {
		const validMode = resolveSubagentHostProfile(loadedProfile(), {
			promptStacks: [promptStack({ mode })],
			registrations: { macros: [{ name: "customMacro", source: "fixture" }], slots: [{ name: "custom-slot", source: "fixture" }] },
		});
		assert.ok(validMode.snapshot, String(mode));
	}
	const invalidMode = resolveSubagentHostProfile(loadedProfile(), {
		promptStacks: [promptStack({ mode: "merge" as PromptStack["mode"] })],
		registrations: { macros: [{ name: "customMacro", source: "fixture" }], slots: [{ name: "custom-slot", source: "fixture" }] },
	});
	assert.equal(invalidMode.snapshot, undefined);
	assert.equal(invalidMode.diagnostics.some((item) => item.code === "profile.stack-mode"), true);
});

test("host resolution accepts project and global qualified stack references", () => {
	const registrations = { macros: [{ name: "customMacro", source: "fixture" }], slots: [{ name: "custom-slot", source: "fixture" }] };
	const projectShared: LoadedPromptStack = {
		...promptStack({ id: "shared" }),
		filePath: "/project/.pi/forge/prompt-stacks/shared.json",
		scope: "project",
		key: { scope: "project", id: "shared" },
	};
	const globalShared: LoadedPromptStack = {
		...promptStack({ id: "shared" }),
		filePath: "/global/.pi/forge/prompt-stacks/shared.json",
		scope: "global",
		key: { scope: "global", id: "shared" },
	};

	for (const reference of ["global:shared", "project:shared"]) {
		const resolved = resolveSubagentHostProfile(loadedProfile(reference), {
			promptStacks: [projectShared, globalShared],
			registrations,
		});
		assert.equal(hasErrors(resolved.diagnostics), false, reference);
		assert.equal(resolved.snapshot?.promptStackId, reference);
		assert.equal(resolved.snapshot?.promptStack?.id, "shared");
	}
});

test("dependency scanning handles nested macros, static variables, and anonymous registrations", () => {
	const result = collectSubagentPromptDependencies(promptStack({
		variables: { local: "value" },
		items: [{ kind: "block", id: "one", role: "system", content: "{{local}} {{ extensions.anonymous }}" }],
	}).stack, { macros: [{ name: "anonymous" }], slots: [] });
	assert.deepEqual(result.dependencies.map((item) => item.identity), ["macro:anonymous:anonymous"]);
	assert.equal(result.diagnostics.some((item) => item.code === "profile.dependency-anonymous"), true);
});

test("host tool negotiation intersects stack policy with declared effects and access facts", () => {
	const catalog = [
		{ id: "read-id", name: "read", effects: ["filesystem-read"] },
		{ id: "paint-id", name: "paint_generate", effects: ["network"] },
		{ id: "pure-id", name: "paint_validate", effects: [] },
		{ id: "write-id", name: "write", effects: ["filesystem-write"] },
		{ id: "unnamed-id" },
	];
	const none = negotiateForgeDelegationTools(catalog, { allow: ["read", "paint_*", "missing"] }, { level: "none", network: "deny", allowProcess: false });
	assert.deepEqual(none.effectiveToolNames, ["paint_validate"]);
	assert.deepEqual(none.effectiveToolIds, ["pure-id"]);
	assert.ok(none.diagnostics.some((item) => item.code === "tools.unmatched-allow" && item.message.includes("missing")));
	assert.ok(none.diagnostics.some((item) => item.code === "tools.access-filtered"));

	const readOnly = negotiateForgeDelegationTools(catalog, { allow: ["*"] }, { level: "read-only", network: "allow", allowProcess: false });
	assert.deepEqual(readOnly.effectiveToolNames, ["read", "paint_generate", "paint_validate", "unnamed-id"]);

	const noPolicy = negotiateForgeDelegationTools(catalog, undefined, { level: "workspace-write", network: "allow", allowProcess: true });
	assert.deepEqual(noPolicy.effectiveToolIds, catalog.map((tool) => tool.id));
});

test("Forge-native delegation preparation shares one compilation context (extension evaluated once)", () => {
	let calls = 0;
	const unregister = registerMacro({
		name: "fixtureSubOnce",
		render: () => {
			calls += 1;
			return "UV";
		},
	});
	try {
		const stack = promptStack({
			items: [
				{ kind: "block", id: "sys", role: "system", content: "sys={{ extensions.fixtureSubOnce }}" },
				{ kind: "block", id: "msg", role: "user", content: "msg={{ extensions.fixtureSubOnce }}" },
				{ kind: "slot", id: "history", slot: "chat-history" },
			],
		});
		const resolved = resolveSubagentHostProfile(loadedProfile(), {
			promptStacks: [stack],
			registrations: { macros: [{ name: "fixtureSubOnce" }], slots: [] },
		});
		assert.ok(resolved.snapshot, "snapshot should be present");
		const output = prepareForgeDelegation({
			snapshot: resolved.snapshot,
			task: { text: "Do the delegated task." },
			access: { level: "none", network: "deny", allowProcess: false },
			backend: { model: { provider: "test", id: "model" }, thinkingLevel: "high", toolCatalog: [] },
			cwd: ".",
		});
		assert.equal(calls, 1);
		assert.ok(output.systemPrompt.includes("sys=UV"));
		const stackMessage = output.messages.find((message) => message.source === "prompt-stack");
		assert.ok(stackMessage && JSON.stringify(stackMessage.content).includes("msg=UV"));
		const finalMessage = output.messages.at(-1);
		assert.equal(finalMessage?.role, "user");
		assert.equal(finalMessage?.protectedTask, true);
		assert.equal(finalMessage?.source, "delegated-task");
		assert.deepEqual(finalMessage?.content, [{ type: "text", text: "Do the delegated task." }]);
		assert.ok(output.preparedAt.length > 0);
	} finally {
		unregister();
	}
});
