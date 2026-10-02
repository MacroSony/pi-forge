import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPiBasePrompt, projectPresetSystemPrompt } from "../src/capability-projection.ts";
import { createToolPolicyRuntime } from "../src/runtime/tool-policy-runtime.ts";
import type { LoadedPromptStack, PromptToolPolicy } from "../src/types.ts";

// These exercise Forge with a changing catalog, not a native MCP handshake or SDK reload.
function fixture(policy: PromptToolPolicy, known = ["read"], active = ["read"]) {
	const catalog = new Set(known);
	let selected = [...active];
	const stack: LoadedPromptStack = {
		filePath: "/fixture/preset.json", scope: "project", key: { scope: "project", id: "fixture" },
		diagnostics: [], stack: { schemaVersion: 1, id: "fixture", tools: policy, items: [] },
	};
	const pi = {
		getActiveTools: () => [...selected],
		getAllTools: () => [...catalog].map(name => ({ name, description: name })),
		setActiveTools: (names: string[]) => { selected = [...names]; },
	} as unknown as ExtensionAPI;
	return { catalog, active: () => selected, runtime: createToolPolicyRuntime(pi, () => stack), pi, stack };
}

test("late registration: explicit initial tools become selected on sync, unrelated tools do not", () => {
	const f = fixture({ allow: ["*"], initial: ["read", "mcp__demo__ping"] });
	f.runtime.sync();
	assert.deepEqual(f.active(), ["read"]);
	f.catalog.add("mcp__demo__ping").add("unrequested");
	f.runtime.sync();
	assert.deepEqual(f.active(), ["read", "mcp__demo__ping"]);
	// Absence from the loadout is NOT a new execution restriction in this patch.
	assert.equal(f.runtime.blockReason("unrequested"), undefined);
});

test("late Capability add: unavailable fails, registration permits enable/off and snapshot restoration", () => {
	const name = "mcp__demo__ping";
	const f = fixture({ allow: ["read", name], initial: ["read"] });
	const patch = { add: [name], remove: [] };
	f.runtime.sync();
	assert.throws(() => f.runtime.setCapabilities([patch]), /not registered/);
	assert.deepEqual(f.active(), ["read"]);
	f.catalog.add(name);
	f.runtime.setCapabilities([patch]); f.runtime.sync();
	assert.deepEqual(f.active(), ["read", name]);
	const snapshot = f.runtime.snapshot();
	const restored = createToolPolicyRuntime(f.pi, () => f.stack);
	restored.setCapabilities([patch], snapshot); restored.sync();
	assert.deepEqual(f.active(), ["read", name]);
	restored.setCapabilities([]); restored.sync();
	assert.deepEqual(f.active(), ["read"]);
	assert.equal(restored.blockReason(name), undefined, "off is loadout-only for permitted deferred tools");
	restored.setCapabilities([{ add: [], remove: [name] }]);
	assert.match(restored.blockReason(name) ?? "", /blocked by active capability/);
});

test("late forbidden tools remain unselected and blocked under either valid allow or deny policy", () => {
	for (const policy of [{ allow: ["read", "permitted"] }, { deny: ["forbidden"], initial: ["read", "forbidden"] }]) {
		const f = fixture(policy);
		f.runtime.sync(); f.catalog.add("forbidden"); f.runtime.sync();
		assert.deepEqual(f.active(), ["read"]);
		assert.throws(() => f.runtime.setCapabilities([{ add: ["forbidden"], remove: [] }]), /blocked by prompt stack/);
		assert.match(f.runtime.blockReason("forbidden") ?? "", /blocked by prompt stack/);
	}
});

test("native MCP names are exact: stale add rejects; stale deny/remove do not silently alias new names", () => {
	const old = "mcp__demo-server__ping", current = "mcp__demo_server__ping";
	const f = fixture({ allow: ["read", current], initial: ["read"] }, ["read", current]);
	assert.throws(() => f.runtime.setCapabilities([{ add: [old], remove: [] }]), /not registered/);
	assert.equal(f.runtime.validateCapabilities([{ add: [current], remove: [] }]), undefined);
	const staleDeny = fixture({ deny: [old] }, ["read", current], ["read", current]);
	staleDeny.runtime.sync();
	assert.equal(staleDeny.runtime.blockReason(current), undefined, "old deny must be explicitly migrated, not assumed safe");
	staleDeny.runtime.setCapabilities([{ add: [], remove: [old] }]); staleDeny.runtime.sync();
	assert.ok(staleDeny.active().includes(current));
	staleDeny.runtime.setCapabilities([{ add: [], remove: [current] }]); staleDeny.runtime.sync();
	assert.match(staleDeny.runtime.blockReason(current) ?? "", /blocked by active capability/);
});

test("MCP normalization collisions do not broaden a permitted exact hash name", () => {
	const one = "mcp__demo__a_b_108b2fb7", two = "mcp__demo__a_b_f8c0c823";
	const f = fixture({ allow: ["read", one] }, ["read", one, two]);
	for (const candidate of ["mcp__demo__a-b", "mcp__demo__a_b"]) {
		assert.throws(() => f.runtime.setCapabilities([{ add: [candidate], remove: [] }]), /not registered/);
	}
	assert.equal(f.runtime.validateCapabilities([{ add: [one], remove: [] }]), undefined);
	assert.match(f.runtime.validateCapabilities([{ add: [two], remove: [] }]) ?? "", /blocked by prompt stack/);
});

test("MCP foreign sections keep initial, update, empty, and removal semantics without duplicating Pi base", () => {
	const messages: AgentMessage[] = [
		{ role: "system", content: "base", sections: { preamble: "PI_BASE", mcp_servers: "MCP_INITIAL" }, timestamp: 1 },
		{ role: "user", content: "hello", timestamp: 2 },
		{ role: "system", content: "", sections: { mcp_servers: "MCP_UPDATED" }, timestamp: 3 },
		{ role: "system", content: "", sections: { mcp_servers: "" }, timestamp: 4 },
		{ role: "system", content: "", sections: { mcp_servers: null }, timestamp: 5 },
	];
	const before = structuredClone(messages);
	assert.match(getPiBasePrompt(messages.slice(0, 1), "fallback"), /PI_BASE/);
	assert.doesNotMatch(getPiBasePrompt(messages.slice(0, 1), "fallback"), /MCP_INITIAL/);
	const projected = projectPresetSystemPrompt(messages, "FORGE");
	assert.deepEqual(projected, [
		{ role: "system", content: "FORGE", sections: { mcp_servers: "MCP_INITIAL" }, timestamp: 1 },
		...messages.slice(1),
	]);
	assert.deepEqual(messages, before, "projection must not mutate the incoming transcript");
});
