import assert from "node:assert/strict";
import test from "node:test";
import { createToolPolicyRuntime } from "../src/runtime/tool-policy-runtime.ts";
import type { LoadedPromptStack, PromptStack } from "../src/types.ts";

function fixture(policy: PromptStack["tools"] = { allow: ["read", "pet", "forge_capability"], initial: ["read", "forge_capability"] }, exposures: Record<string, "direct" | "deferred" | "codemode"> = {}) {
	let active = ["read", "forge_capability"];
	const applied: string[][] = [];
	let stack: LoadedPromptStack | undefined = {
		filePath: "/tmp/gate.json", scope: "project", key: { scope: "project", id: "gate" }, diagnostics: [],
		stack: { schemaVersion: 1, id: "gate", tools: policy, items: [] },
	};
	const sourceInfo = { path: "/extensions/mcp.ts", source: "auto", scope: "project", origin: "top-level" };
	const tools: any[] = ["read", "pet", "forge_capability", "mcp", "mcp__hitch", "mcp__hitch__read"].map(name => ({ name, sourceInfo: { ...sourceInfo }, ...(exposures[name] ? { exposure: exposures[name] } : {}) }));
	const pi = {
		getActiveTools: () => [...active], getAllTools: () => tools,
		setActiveTools: (names: string[]) => { active = [...names]; applied.push([...names]); },
	};
	const runtime = createToolPolicyRuntime(pi as any, () => stack);
	return { pi, tools, runtime, applied, active: () => active, setStack: (next: LoadedPromptStack | undefined) => { stack = next; } };
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

test("namespace descendants remain subject to explicit stack deny and capability remove", () => {
	const denied = fixture({ deny: ["mcp__hitch__*"], initial: ["mcp"] });
	denied.runtime.sync();
	assert.equal(denied.runtime.blockReason("mcp__hitch"), undefined);
	assert.match(denied.runtime.blockReason("mcp__hitch__read")!, /blocked by prompt stack/);
	const removed = fixture({ allow: ["mcp"], initial: ["mcp"] });
	removed.runtime.sync();
	removed.runtime.setCapabilities([{ add: [], remove: ["mcp__hitch__read"] }]);
	assert.match(removed.runtime.blockReason("mcp__hitch__read")!, /blocked by active capability/);
	removed.runtime.setCapabilities([]);
	assert.equal(removed.runtime.blockReason("mcp__hitch__read"), undefined);
});

test("namespace metadata is fail-closed and compares registrar identity rather than a shared source label", () => {
	for (const field of ["path", "source", "scope", "origin", "baseDir"]) {
		const f = fixture({ allow: ["mcp"], initial: ["mcp"] });
		f.runtime.sync();
		f.tools.find(t => t.name === "mcp__hitch__read").sourceInfo[field] = "different";
		assert.ok(f.runtime.blockReason("mcp__hitch__read"), field);
	}
	for (const missing of [undefined, {}, { source: "auto" }]) {
		const f = fixture({ allow: ["mcp"], initial: ["mcp"] });
		f.runtime.sync();
		f.tools.find(t => t.name === "mcp__hitch__read").sourceInfo = missing;
		assert.ok(f.runtime.blockReason("mcp__hitch__read"));
	}
	const f = fixture({ allow: ["mcp"], initial: [] });
	f.runtime.sync();
	assert.ok(f.runtime.blockReason("mcp__hitch__read"), "same provenance cannot authorize an inactive parent");
});

test("gate recomputes after stack reload, restored empty state and dynamic registration without trusting lastApplied", () => {
	const f = fixture();
	f.runtime.sync();
	f.runtime.setCapabilities([], { baseline: [], lastApplied: ["pet"] });
	assert.ok(f.runtime.blockReason("pet"));
	f.setStack({ filePath: "/tmp/empty.json", scope: "project", key: { scope: "project", id: "empty" }, diagnostics: [],
		stack: { schemaVersion: 1, id: "empty", tools: { allow: ["read", "pet"], initial: [] }, items: [] } });
	assert.ok(f.runtime.blockReason("read"), "reload must not retain the previous applied selection");
	f.runtime.sync();
	assert.deepEqual(f.active(), []);
	f.runtime.setCapabilities([{ add: ["pet"], remove: [] }]);
	assert.equal(f.runtime.blockReason("pet"), undefined);
	f.tools.splice(f.tools.findIndex(t => t.name === "pet"), 1);
	assert.ok(f.runtime.blockReason("pet"), "unregistered tools are not authorized by stale effects");
});

test("deny-only gate fails closed before baseline initialization, but restored baseline is authoritative before sync", () => {
	const f = fixture({ deny: ["forbidden"] });
	assert.ok(f.runtime.blockReason("read"));
	f.runtime.setCapabilities([], { baseline: ["read"], lastApplied: [] });
	assert.equal(f.runtime.blockReason("read"), undefined);
	f.runtime.setCapabilities([], { baseline: [], lastApplied: ["read"] });
	assert.ok(f.runtime.blockReason("read"), "empty baseline is not uninitialized permission");
});

test("no active stack or no resource policy preserves legacy execution semantics, including capability removals", () => {
	for (const policy of [undefined, { initial: [] }, { allow: ["*"] }]) {
		const f = fixture(policy);
		// fixture's default policy is intentional for undefined, so explicitly remove it here.
		if (!policy) f.setStack({ filePath: "/tmp/no-policy.json", scope: "project", key: { scope: "project", id: "no-policy" }, diagnostics: [],
			stack: { schemaVersion: 1, id: "no-policy", items: [] } });
		f.runtime.sync();
		assert.equal(f.runtime.blockReason("pet"), undefined);
		assert.equal(f.runtime.blockReason("unknown"), undefined);
		f.runtime.setCapabilities([{ add: [], remove: ["pet"] }]);
		assert.match(f.runtime.blockReason("pet")!, /blocked by active capability/);
		f.setStack(undefined);
		assert.equal(f.runtime.blockReason("unknown"), undefined);
		assert.match(f.runtime.blockReason("pet")!, /blocked by active capability/);
	}
});

test("real lifecycle tool_call hook gates both direct and codemode nested targets on capability enable/disable", async () => {
	const { registerLifecycleHandlers } = await import("../src/lifecycle.ts");
	const f = fixture();
	const handlers: Record<string, (...args: any[]) => any> = {};
	registerLifecycleHandlers({ ...f.pi, on: (event: string, handler: any) => { handlers[event] = handler; } } as any,
		{} as any, {} as any, { toolPolicyBlockReason: f.runtime.blockReason } as any);
	f.runtime.sync();
	for (const parentToolCallId of [undefined, "codemode-parent"]) {
		const event = { type: "tool_call", toolName: "pet", toolCallId: "child", input: {}, ...(parentToolCallId ? { parentToolCallId } : {}) };
		const blocked = await handlers.tool_call(event);
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /not currently enabled.*forge_capability/);
		assert.doesNotMatch(blocked.reason, /not registered|not found|does not exist/);
		f.runtime.setCapabilities([{ add: ["pet"], remove: [] }]);
		assert.equal(await handlers.tool_call(event), undefined);
		f.runtime.setCapabilities([]);
		assert.equal((await handlers.tool_call(event)).block, true);
	}
});

test("namespace child of a permitted but disabled parent explains how to enable it; impostors stay hard-blocked", () => {
	const f = fixture({ allow: ["read", "forge_capability", "mcp__hitch"], initial: ["read", "forge_capability"] });
	f.runtime.sync();
	assert.match(f.runtime.blockReason("mcp__hitch__read")!, /not currently enabled.*forge_capability/);
	f.tools.find(t => t.name === "mcp__hitch__read").sourceInfo.path = "/extensions/impostor.ts";
	assert.match(f.runtime.blockReason("mcp__hitch__read")!, /blocked by prompt stack/);
});


test("sync retains externally activated authorized namespace children without changing the effective set", () => {
	const f = fixture({ allow: ["mcp__hitch"], initial: ["mcp__hitch"] });
	f.runtime.sync();
	f.pi.setActiveTools([...f.active(), "mcp__hitch__read"]);
	const calls = f.applied.length;
	f.runtime.sync();
	f.runtime.sync();
	assert.ok(f.active().includes("mcp__hitch__read"));
	assert.equal(f.runtime.blockReason("mcp__hitch__read"), undefined);
	assert.deepEqual(f.runtime.previewToolNames({ schemaVersion: 1, id: "gate", tools: { allow: ["mcp__hitch"], initial: ["mcp__hitch"] }, items: [] }), ["mcp__hitch"]);
	assert.equal(f.applied.length, calls, "retention must not cause removal/re-add churn");
	assert.deepEqual(f.runtime.snapshot().lastApplied, f.active());
});

test("sync retains unauthorized deferred/codemode tools but the gate still points to forge_capability", () => {
	for (const exposure of ["deferred", "codemode"] as const) {
		const f = fixture(undefined, { pet: exposure });
		f.runtime.sync();
		f.pi.setActiveTools([...f.active(), "pet"]);
		const calls = f.applied.length;
		f.runtime.sync();
		f.runtime.sync();
		assert.ok(f.active().includes("pet"), exposure);
		assert.match(f.runtime.blockReason("pet")!, /not currently enabled.*forge_capability/);
		assert.equal(f.applied.length, calls);
		assert.deepEqual(f.runtime.snapshot().lastApplied, f.active());
	}
});

test("sync removes externally activated direct tools, including legacy missing exposure", () => {
	for (const exposure of ["direct", undefined] as const) {
		const f = fixture(undefined, exposure ? { pet: exposure } : {});
		f.runtime.sync();
		f.pi.setActiveTools([...f.active(), "pet"]);
		f.runtime.sync();
		assert.ok(!f.active().includes("pet"));
		const calls = f.applied.length;
		f.runtime.sync();
		assert.equal(f.applied.length, calls);
	}
});

test("stack deny and capability remove override deferred retention and namespace authorization", () => {
	for (const exclusion of ["deny", "remove"]) {
		const f = fixture({ initial: ["mcp"], deny: exclusion === "deny" ? ["mcp__hitch__*"] : ["forbidden"] }, { mcp__hitch__read: "deferred" });
		f.runtime.sync();
		if (exclusion === "remove") f.runtime.setCapabilities([{ add: [], remove: ["mcp__hitch__read"] }]);
		f.pi.setActiveTools([...f.active(), "mcp__hitch__read"]);
		f.runtime.sync();
		assert.ok(!f.active().includes("mcp__hitch__read"));
		assert.match(f.runtime.blockReason("mcp__hitch__read")!, /blocked by/);
	}
});


test("retained capability tools do not become external baseline additions on later syncs", () => {
	for (const exposure of ["deferred", "codemode"] as const) {
		const policy = { allow: ["read", "pet", "forge_capability"], initial: ["read", "forge_capability"] };
		const f = fixture(policy, { pet: exposure });
		f.runtime.sync();
		const baseline = f.runtime.snapshot().baseline;
		f.runtime.setCapabilities([{ add: ["pet"], remove: [] }]);
		f.runtime.sync();
		f.runtime.setCapabilities([]);
		const calls = f.applied.length;
		f.runtime.sync();
		f.runtime.sync();
		assert.ok(f.active().includes("pet"));
		assert.equal(f.applied.length, calls);
		assert.deepEqual(f.runtime.snapshot().baseline, baseline, "retention is Forge-applied, not a fresh external activation");
		assert.deepEqual(f.runtime.snapshot().lastApplied, f.active());
		assert.deepEqual(f.runtime.previewToolNames({ schemaVersion: 1, id: "gate", tools: policy, items: [] }), policy.initial);
		assert.match(f.runtime.blockReason("pet")!, /forge_capability/, "retention must not authorize execution");
	}
});

test("deny-only presets preserve existing external-addition baseline absorption", () => {
	for (const exposure of ["direct", "deferred", "codemode"] as const) {
		const f = fixture({ deny: ["forbidden"] }, { pet: exposure });
		f.runtime.sync();
		f.pi.setActiveTools([...f.active(), "pet"]);
		const calls = f.applied.length;
		f.runtime.sync();
		f.runtime.sync();
		assert.ok(f.runtime.snapshot().baseline.includes("pet"), "deny-only presets already absorb external additions");
		assert.ok(f.active().includes("pet"));
		assert.equal(f.runtime.blockReason("pet"), undefined, "the policy-derived baseline, not retention, authorizes this tool");
		assert.equal(f.applied.length, calls);
	}
});

test("capability disable still removes its direct additions with initial or legacy baseline selection", () => {
	for (const policy of [
		{ allow: ["read", "pet", "forge_capability"], initial: ["read", "forge_capability"] },
		{ deny: ["forbidden"] },
		{ initial: ["read", "forge_capability"] },
	]) {
		const f = fixture(policy, { pet: "direct" });
		f.runtime.sync();
		f.runtime.setCapabilities([{ add: ["pet"], remove: [] }]);
		f.runtime.sync();
		assert.ok(f.active().includes("pet"));
		f.runtime.setCapabilities([]);
		f.runtime.sync();
		assert.ok(!f.active().includes("pet"), "deactivation intentionally removes direct tools");
		assert.ok(!f.runtime.snapshot().baseline.includes("pet"));
		const calls = f.applied.length;
		f.runtime.sync();
		assert.equal(f.applied.length, calls);
	}
});
