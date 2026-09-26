import assert from "node:assert/strict";
import test from "node:test";

import { parsePromptStack, serializePromptStack } from "../src/codecs/prompt-stack.ts";
import { createToolPolicyRuntime } from "../src/runtime/tool-policy-runtime.ts";
import { negotiateForgeDelegationTools } from "../src/subagent-host.ts";
import type { LoadedPromptStack, PromptStack } from "../src/types.ts";

function createFakePi(initialActive: string[], tools: any[]) {
	let active = [...initialActive];
	const catalog = tools.map((tool) => typeof tool === "string" ? { name: tool } : tool);
	return {
		pi: {
			getActiveTools: () => [...active],
			getAllTools: () => catalog,
			setActiveTools: (names: string[]) => { active = [...names]; },
		} as any,
		active: () => [...active],
	};
}

function loaded(stack: PromptStack): LoadedPromptStack {
	return {
		filePath: `/tmp/${stack.id}.json`,
		scope: "project",
		key: { scope: "project", id: stack.id },
		diagnostics: [],
		stack,
	};
}

function stack(tools: PromptStack["tools"]): PromptStack {
	return { schemaVersion: 1, id: "initial", tools, items: [] };
}

test("tool initial codec preserves [] and rejects invalid, duplicate, and blocked names", () => {
	const parsed = parsePromptStack(JSON.stringify({
		schemaVersion: 1,
		id: "initial",
		tools: { allow: ["read"], initial: ["read", "read", "bash", "tool*", 42] },
		items: [],
	}), "/tmp/initial.json", "project");

	assert.deepEqual(parsed.stack.tools?.initial, ["read", "bash"]);
	assert.ok(parsed.diagnostics.some((d) => d.level === "warning" && /Duplicate tools.initial/.test(d.message)));
	assert.ok(parsed.diagnostics.some((d) => d.level === "error" && /blocked/.test(d.message)));
	assert.ok(parsed.diagnostics.some((d) => d.level === "error" && /concrete tool name/.test(d.message)));

	const empty = parsePromptStack(JSON.stringify({ id: "empty", tools: { initial: [] }, items: [] }), "/tmp/empty.json", "project");
	assert.deepEqual(empty.stack.tools?.initial, []);
	assert.equal(serializePromptStack(empty.stack).includes('"initial": []'), true);
});

test("initial selection is the preset base, while modes add permitted inactive tools and removals win", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash", "grep", "edit"]);
	let active = loaded(stack({ initial: ["read"] }));
	const runtime = createToolPolicyRuntime(fake.pi, () => active);

	runtime.sync();
	assert.deepEqual(fake.active(), ["read"]);
	assert.deepEqual(runtime.previewToolNames(active.stack), ["read"]);
	assert.deepEqual(
		runtime.previewOptions({ selectedTools: ["read", "bash"], toolSnippets: {}, promptGuidelines: [] } as any, active.stack).selectedTools,
		["read"],
	);

	runtime.setCapabilities([{ add: ["grep"], remove: ["read"] }]);
	runtime.sync();
	assert.deepEqual(fake.active(), ["grep"]);
	assert.deepEqual(runtime.previewToolNames(active.stack), ["grep"]);

	runtime.setCapabilities([]);
	runtime.sync();
	assert.deepEqual(fake.active(), ["read"]);

	active = loaded(stack({ initial: [], allow: ["read", "grep"] }));
	runtime.sync();
	assert.deepEqual(fake.active(), []);
	runtime.setCapabilities([{ add: ["grep"], remove: [] }]);
	runtime.sync();
	assert.deepEqual(fake.active(), ["grep"]);
});

test("initial does not bypass allow/deny, and preset off restores reconciled external baseline", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash", "grep"]);
	let active: LoadedPromptStack | undefined = loaded(stack({ initial: ["read"], deny: ["grep"] }));
	const runtime = createToolPolicyRuntime(fake.pi, () => active);

	runtime.sync();
	fake.pi.setActiveTools(["read", "grep"]);
	runtime.sync();
	assert.deepEqual(fake.active(), ["read"]);

	active = undefined;
	runtime.sync();
	assert.deepEqual(fake.active(), ["read", "bash", "grep"]);
});

test("subagent preparation applies initial without enabling every backend tool", () => {
	const result = negotiateForgeDelegationTools(
		[
			{ id: "read-id", name: "read", effects: [] },
			{ id: "write-id", name: "write", effects: [] },
		],
		{ initial: ["read", "missing"] },
		{ level: "workspace-write", network: "allow", allowProcess: true },
	);
	assert.deepEqual(result.effectiveToolNames, ["read"]);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "tools.initial-missing"));
});

test("tool provenance groups registered catalog members without changing source tooltip", () => {
	const tools = [
		{ name: "read", description: "builtin", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
		{ name: "pkg-a", description: "a", sourceInfo: { path: "/p/entry-a.js", source: "acme-tools", scope: "project", origin: "package", baseDir: "/p" } },
		{ name: "pkg-b", description: "b", sourceInfo: { path: "/p/entry-b.js", source: "acme-tools", scope: "project", origin: "package", baseDir: "/p" } },
		{ name: "pkg-user", description: "user", sourceInfo: { path: "/u/entry.js", source: "acme-tools", scope: "user", origin: "package", baseDir: "/p" } },
		{ name: "auto-a", sourceInfo: { path: "/scripts/one.ts", source: "auto", scope: "project", origin: "top-level" } },
		{ name: "auto-b", sourceInfo: { path: "/scripts/two.ts", source: "auto", scope: "project", origin: "top-level" } },
		{ name: "other" },
	];
	const fake = createFakePi(["read", "pkg-a"], tools);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);
	const resources = runtime.policyResources({ toolSnippets: {}, skills: [] } as any);
	const byName = new Map(resources.tools.map((tool) => [tool.name, tool]));

	assert.deepEqual(byName.get("read")?.group, { id: "builtin", label: "Pi" });
	assert.deepEqual(byName.get("pkg-a")?.group, byName.get("pkg-b")?.group);
	assert.notDeepEqual(byName.get("pkg-a")?.group, byName.get("pkg-user")?.group);
	assert.notDeepEqual(byName.get("auto-a")?.group, byName.get("auto-b")?.group);
	assert.equal(byName.get("other")?.group, undefined);
	assert.equal(byName.get("pkg-a")?.source, "acme-tools: /p/entry-a.js");
	assert.equal(byName.get("pkg-a")?.active, true);
	assert.equal(byName.get("pkg-b")?.active, false);
});

test("catalog default baseline is read-only and excludes mode-only tool additions", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash", "paint"]);
	const active = loaded(stack({ initial: ["read"] }));
	const runtime = createToolPolicyRuntime(fake.pi, () => active);
	runtime.sync();
	runtime.setCapabilities([{ add: ["paint"], remove: [] }]);
	runtime.sync();
	const before = runtime.snapshot();
	const tools = runtime.policyResources({ toolSnippets: {}, skills: [] } as any).tools;
	assert.deepEqual(tools.filter(tool => tool.baselineActive).map(tool => tool.name), ["bash", "read"]);
	assert.deepEqual(tools.filter(tool => tool.active).map(tool => tool.name), ["paint", "read"]);
	assert.deepEqual(runtime.snapshot(), before);
	assert.deepEqual(fake.active(), ["read", "paint"]);
});
