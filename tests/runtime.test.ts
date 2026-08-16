import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeState } from "../src/runtime-state.ts";
import { createToolPolicyRuntime, reconcileToolPolicyBaseline } from "../src/runtime/tool-policy-runtime.ts";

test("tool policy baseline reconciliation preserves late additions and external removals", () => {
	assert.deepEqual(
		reconcileToolPolicyBaseline(["read", "bash", "edit", "write"], ["read"], ["read", "paint"]),
		["read", "bash", "edit", "write", "paint"],
	);
	assert.deepEqual(
		reconcileToolPolicyBaseline(["read", "bash", "edit", "write"], ["read", "bash"], ["read"]),
		["read", "edit", "write"],
	);
});

test("tool policy runtime owns filtering, preview, and restoration state", () => {
	let activeTools = ["read", "bash", "paint"];
	const allTools = [
		{ name: "read", description: "Read files" },
		{ name: "bash", description: "Run commands" },
		{ name: "paint", description: "Paint" },
	];
	const pi = {
		getActiveTools: () => [...activeTools],
		getAllTools: () => allTools,
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
	} as any;
	const state = createRuntimeState();
	const active = {
		filePath: "/tmp/read-only.json",
		scope: "project" as const,
		key: { scope: "project" as const, id: "read-only" },
		diagnostics: [],
		stack: { schemaVersion: 1 as const, id: "read-only", tools: { allow: ["read"] }, items: [] },
	};
	state.active = active;
	const runtime = createToolPolicyRuntime(pi, state);

	runtime.sync();
	assert.deepEqual(activeTools, ["read"]);
	assert.deepEqual(runtime.previewToolNames(active.stack), ["read"]);
	assert.match(runtime.blockReason("bash") ?? "", /read-only/);

	allTools.push({ name: "late-tool", description: "Loaded after the policy" });
	activeTools.push("late-tool");
	runtime.restore();
	assert.deepEqual(activeTools, ["read", "bash", "paint", "late-tool"]);
});
