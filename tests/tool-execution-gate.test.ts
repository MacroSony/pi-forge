import assert from "node:assert/strict";
import test from "node:test";
import { createToolPolicyRuntime } from "../src/runtime/tool-policy-runtime.ts";
import type { LoadedPromptStack, PromptStack } from "../src/types.ts";

function fixture(policy: PromptStack["tools"] = { allow: ["read", "pet", "forge_capability"], initial: ["read", "forge_capability"] }) {
	let active = ["read", "forge_capability"];
	let stack: LoadedPromptStack | undefined = {
		filePath: "/tmp/gate.json", scope: "project", key: { scope: "project", id: "gate" }, diagnostics: [],
		stack: { schemaVersion: 1, id: "gate", tools: policy, items: [] },
	};
	const sourceInfo = { path: "/extensions/mcp.ts", source: "auto", scope: "project", origin: "top-level" };
	const tools: any[] = ["read", "pet", "forge_capability", "mcp", "mcp__hitch", "mcp__hitch__read"].map(name => ({ name, sourceInfo: { ...sourceInfo } }));
	const pi = {
		getActiveTools: () => [...active], getAllTools: () => tools,
		setActiveTools: (names: string[]) => { active = [...names]; },
	};
	const runtime = createToolPolicyRuntime(pi as any, () => stack);
	return { pi, tools, runtime, active: () => active, setStack: (next: LoadedPromptStack | undefined) => { stack = next; } };
}

test("gate uses Forge effective selection: allow alone cannot execute, capability enable/disable takes effect immediately", () => {
	const f = fixture();
	f.runtime.sync();
	assert.match(f.runtime.blockReason("pet")!, /not currently enabled.*forge_capability/);
	assert.equal(f.runtime.blockReason("forge_capability"), undefined);
	f.pi.setActiveTools(["read", "pet", "forge_capability"]);
	assert.match(f.runtime.blockReason("pet")!, /not currently enabled/, "external setActiveTools is not authorization");
	f.runtime.setCapabilities([{ add: ["pet"], remove: [] }]);
	assert.equal(f.runtime.blockReason("pet"), undefined);
	f.runtime.sync();
	assert.ok(f.active().includes("pet"));
	f.runtime.setCapabilities([]);
	assert.match(f.runtime.blockReason("pet")!, /forge_capability/, "must not reuse lastApplied");
	f.runtime.sync();
	assert.ok(!f.active().includes("pet"));
});

test("namespace authorization requires an enabled parent and identical registration source, not child allow membership", () => {
	const f = fixture({ allow: ["mcp__hitch"], initial: ["mcp__hitch"] });
	f.runtime.sync();
	assert.equal(f.runtime.blockReason("mcp__hitch__read"), undefined);
	f.tools.find(t => t.name === "mcp__hitch__read").sourceInfo.path = "/extensions/impostor.ts";
	assert.match(f.runtime.blockReason("mcp__hitch__read")!, /blocked|not currently enabled/);
});
