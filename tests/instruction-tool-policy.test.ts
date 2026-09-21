import assert from "node:assert/strict";
import test from "node:test";

import {
	createToolPolicyRuntime,
	type ToolPolicySnapshot,
} from "../src/runtime/tool-policy-runtime.ts";
import type { LoadedPromptStack } from "../src/types.ts";

function createFakePi(initialActive: string[], registeredNames?: string[]) {
	let activeTools = [...initialActive];
	const allNames = registeredNames ?? initialActive;
	const all = allNames.map((name) => ({
		name,
		description: `Description of ${name}`,
		promptGuidelines: [`Guideline for ${name}`],
	}));
	return {
		pi: {
			getActiveTools: () => [...activeTools],
			getAllTools: () => all,
			setActiveTools: (names: string[]) => {
				activeTools = [...names];
			},
		} as any,
		getActive: () => [...activeTools],
		allTools: all,
	};
}

test("1. 无policy mode开关: mode can activate and deactivate without preset policy", () => {
	const fake = createFakePi(["read", "bash", "edit", "write"], ["read", "bash", "edit", "write", "grep"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	// Activate mode removing bash and adding grep
	runtime.setInstructionModes([{ add: ["grep"], remove: ["bash"] }]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "edit", "write", "grep"]);
	assert.equal(runtime.blockReason("bash"), 'Tool "bash" is blocked by active instruction mode.');
	assert.equal(runtime.blockReason("read"), undefined);

	// Deactivate mode (off)
	runtime.setInstructionModes([]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash", "edit", "write"]);
	assert.equal(runtime.blockReason("bash"), undefined);
});

test("2. overlappingadd/remove: remove globally wins when tool is in both add and remove", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash", "grep"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	// Patch 1 adds grep, Patch 2 removes grep
	runtime.setInstructionModes([
		{ add: ["grep"], remove: [] },
		{ add: [], remove: ["grep"] },
	]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash"]);
	assert.equal(runtime.blockReason("grep"), 'Tool "grep" is blocked by active instruction mode.');

	// Single patch with overlapping add and remove
	runtime.setInstructionModes([{ add: ["grep"], remove: ["grep"] }]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash"]);
	assert.equal(runtime.blockReason("grep"), 'Tool "grep" is blocked by active instruction mode.');
});

test("3. 两个共享remove关闭一个不会恢复: sharing removed tool across modes stays removed until all close", () => {
	const fake = createFakePi(["read", "bash", "edit"], ["read", "bash", "edit"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	// Both mode 1 and mode 2 remove bash
	runtime.setInstructionModes([
		{ add: [], remove: ["bash"] },
		{ add: [], remove: ["bash"] },
	]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "edit"]);

	// Deactivate mode 1; mode 2 still active
	runtime.setInstructionModes([{ add: [], remove: ["bash"] }]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "edit"]);
	assert.equal(runtime.blockReason("bash"), 'Tool "bash" is blocked by active instruction mode.');

	// Deactivate mode 2
	runtime.setInstructionModes([]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash", "edit"]);
	assert.equal(runtime.blockReason("bash"), undefined);
});

test("4. 原有tool被add off不删: turning off mode that added an existing baseline tool preserves it", () => {
	const fake = createFakePi(["read", "bash", "edit"], ["read", "bash", "edit"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	// Baseline has read; mode also adds read
	runtime.setInstructionModes([{ add: ["read"], remove: [] }]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash", "edit"]);

	// Deactivate mode
	runtime.setInstructionModes([]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash", "edit"]);
});

test("5. external add/remove保留: external tool additions and removals are reconciled and preserved", () => {
	const fake = createFakePi(["read", "bash", "edit"], ["read", "bash", "edit", "custom"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	// Mode removes bash
	runtime.setInstructionModes([{ add: [], remove: ["bash"] }]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "edit"]);

	// External plugin adds "custom" and removes "edit"
	fake.pi.setActiveTools(["read", "custom"]);

	// Sync reconciles external changes
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "custom"]);

	// Turn off mode: baseline should restore bash, retain custom, and not resurrect edit
	runtime.setInstructionModes([]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash", "custom"]);
});

test("6. top deny不可add且call blocked: preset deny policy wins over mode add and blocks tool call", () => {
	const fake = createFakePi(["read", "edit"], ["read", "bash", "edit"]);
	const activeStack: LoadedPromptStack = {
		filePath: "/tmp/deny-bash.json",
		scope: "project",
		key: { scope: "project", id: "deny-bash" },
		diagnostics: [],
		stack: {
			schemaVersion: 1,
			id: "deny-bash",
			tools: { deny: ["bash"] },
			items: [],
		},
	};
	const runtime = createToolPolicyRuntime(fake.pi, () => activeStack);

	// Validate catches preset policy denial
	const err = runtime.validateInstructionModes([{ add: ["bash"], remove: [] }]);
	assert.equal(err, 'Tool "bash" is blocked by prompt stack "deny-bash".');

	// The setter itself is also an admission boundary, not just its preview.
	assert.throws(() => runtime.setInstructionModes([{ add: ["bash"], remove: [] }]), /blocked by prompt stack/);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "edit"]);

	// blockReason returns original stack policy error
	assert.equal(runtime.blockReason("bash"), 'Tool "bash" is blocked by prompt stack "deny-bash".');
});

test("7. registered inactive add: mode activates a registered tool that was inactive in baseline", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash", "grep", "find"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	// Baseline is read, bash. grep is registered but inactive.
	runtime.setInstructionModes([{ add: ["grep"], remove: [] }]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash", "grep"]);

	// Turn off mode: returns to baseline
	runtime.setInstructionModes([]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash"]);
});

test("8. snapshot JSON restore后off复原: snapshot serialize/deserialize restores original baseline, not mode effects", () => {
	const fake1 = createFakePi(["read", "bash", "edit"], ["read", "bash", "edit"]);
	const runtime1 = createToolPolicyRuntime(fake1.pi, () => undefined);

	// Mode removes bash
	runtime1.setInstructionModes([{ add: [], remove: ["bash"] }]);
	runtime1.sync();
	assert.deepEqual(fake1.getActive(), ["read", "edit"]);

	// Capture snapshot and JSON roundtrip
	const snapshot = runtime1.snapshot();
	const serialized: ToolPolicySnapshot = JSON.parse(JSON.stringify(snapshot));
	assert.deepEqual(serialized.baseline, ["read", "bash", "edit"]);
	assert.deepEqual(serialized.lastApplied, ["read", "edit"]);

	// Simulate restored session: fakePi starts with polluted tools ["read", "edit"]
	const fake2 = createFakePi(["read", "edit"], ["read", "bash", "edit"]);
	const runtime2 = createToolPolicyRuntime(fake2.pi, () => undefined);

	// Restore snapshot into existing owner
	runtime2.setInstructionModes([{ add: [], remove: ["bash"] }], serialized);
	runtime2.sync();
	assert.deepEqual(fake2.getActive(), ["read", "edit"]);

	// Turn off mode: bash must restore, not get lost
	runtime2.setInstructionModes([]);
	runtime2.sync();
	assert.deepEqual(fake2.getActive(), ["read", "bash", "edit"]);
});

test("9. policyselectiveallow/wildcard保持: selective allow and wildcard semantics are preserved with modes", () => {
	// 9A: Selective allow
	const fakeA = createFakePi(["read", "bash"], ["read", "bash", "grep", "find", "ls"]);
	const selectiveStack: LoadedPromptStack = {
		filePath: "/tmp/selective.json",
		scope: "project",
		key: { scope: "project", id: "selective" },
		diagnostics: [],
		stack: {
			schemaVersion: 1,
			id: "selective",
			tools: { allow: ["grep", "find", "ls"] },
			items: [],
		},
	};
	const runtimeA = createToolPolicyRuntime(fakeA.pi, () => selectiveStack);

	// Mode removes find
	runtimeA.setInstructionModes([{ add: [], remove: ["find"] }]);
	runtimeA.sync();
	assert.deepEqual(fakeA.getActive(), ["grep", "ls"]);

	// Turn off mode: selective allow produces all 3
	runtimeA.setInstructionModes([]);
	runtimeA.sync();
	assert.deepEqual(fakeA.getActive(), ["grep", "find", "ls"]);

	// 9B: Wildcard allow
	const fakeB = createFakePi(["read", "bash"], ["read", "bash", "grep"]);
	const wildcardStack: LoadedPromptStack = {
		filePath: "/tmp/wildcard.json",
		scope: "project",
		key: { scope: "project", id: "wildcard" },
		diagnostics: [],
		stack: {
			schemaVersion: 1,
			id: "wildcard",
			tools: { allow: ["*", "grep"] },
			items: [],
		},
	};
	const runtimeB = createToolPolicyRuntime(fakeB.pi, () => wildcardStack);

	// Mode adds grep and removes bash
	runtimeB.setInstructionModes([{ add: ["grep"], remove: ["bash"] }]);
	runtimeB.sync();
	assert.deepEqual(fakeB.getActive(), ["read", "grep"]);

	// Turn off mode: returns to wildcard baseline
	runtimeB.setInstructionModes([]);
	runtimeB.sync();
	assert.deepEqual(fakeB.getActive(), ["read", "bash"]);
});

test("10. empty mode/text-only: mode without tool patches preserves active tools and baseline", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	runtime.setInstructionModes([{ add: [], remove: [] }]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash"]);

	const snap = runtime.snapshot();
	assert.deepEqual(snap.baseline, ["read", "bash"]);
	assert.deepEqual(snap.lastApplied, ["read", "bash"]);
});

test("11. setter不立即变工具: setInstructionModes does not mutate active tools until sync", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash", "grep"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	runtime.setInstructionModes([{ add: ["grep"], remove: ["bash"] }]);
	// Immediately after setter, active tools must not have changed
	assert.deepEqual(fake.getActive(), ["read", "bash"]);

	// After sync, changes are applied
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "grep"]);
});

test("12. validateInstructionModes rejects unregistered tool and invalid tool syntax", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	// Unregistered tool
	assert.equal(
		runtime.validateInstructionModes([{ add: ["nonexistent"], remove: [] }]),
		'Tool "nonexistent" is not registered.',
	);

	// Invalid tool names (spaces, wildcards)
	assert.match(
		runtime.validateInstructionModes([{ add: ["tool with space"], remove: [] }]) ?? "",
		/Invalid tool name "tool with space"/,
	);
	assert.match(
		runtime.validateInstructionModes([{ add: [], remove: ["bad*wildcard"] }]) ?? "",
		/Invalid tool name "bad\*wildcard"/,
	);

	// Malformed structure
	assert.match(
		runtime.validateInstructionModes("not an array" as any) ?? "",
		/must be an array/,
	);

	// Valid patch
	assert.equal(
		runtime.validateInstructionModes([{ add: ["read"], remove: ["bash"] }]),
		undefined,
	);
});

test("13. restore with unknown add tool fails closed and throws Error", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	const snapshot: ToolPolicySnapshot = {
		baseline: ["read", "bash"],
		lastApplied: ["read"],
	};

	assert.throws(
		() => runtime.setInstructionModes([{ add: ["unknown_tool"], remove: [] }], snapshot),
		/Tool "unknown_tool" is not registered./,
	);
});

test("14. restore for shutdown clears runtime modes and restores baseline", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);

	runtime.setInstructionModes([{ add: [], remove: ["bash"] }]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read"]);

	// Restore called during shutdown
	runtime.restore();
	assert.deepEqual(fake.getActive(), ["read", "bash"]);

	// Modes were cleared internally; subsequent sync stays at restored baseline
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "bash"]);
});

test("15. previewToolNames matches real active tools under current stack and returns defensive clone", () => {
	const fake = createFakePi(["read", "bash", "edit"], ["read", "bash", "edit", "grep"]);
	const activeStack: LoadedPromptStack = {
		filePath: "/tmp/stack.json",
		scope: "project",
		key: { scope: "project", id: "stack" },
		diagnostics: [],
		stack: {
			schemaVersion: 1,
			id: "stack",
			tools: { allow: ["read", "edit", "grep"] },
			items: [],
		},
	};
	const runtime = createToolPolicyRuntime(fake.pi, () => activeStack);

	runtime.setInstructionModes([{ add: ["grep"], remove: ["bash"] }]);
	runtime.sync();

	const preview = runtime.previewToolNames(activeStack.stack);
	assert.deepEqual(preview, fake.getActive());
	assert.deepEqual(preview, ["read", "edit", "grep"]);

	// Defensive copy check: mutating preview does not change internal state
	preview.push("mutated");
	assert.deepEqual(runtime.previewToolNames(activeStack.stack), ["read", "edit", "grep"]);
});

test("16. previewOptions incorporates instruction mode effects and snippets", () => {
	const fake = createFakePi(["read", "bash"], ["read", "bash", "grep"]);
	const activeStack: LoadedPromptStack = {
		filePath: "/tmp/stack.json",
		scope: "project",
		key: { scope: "project", id: "stack" },
		diagnostics: [],
		stack: {
			schemaVersion: 1,
			id: "stack",
			items: [],
		},
	};
	const runtime = createToolPolicyRuntime(fake.pi, () => activeStack);

	runtime.setInstructionModes([{ add: ["grep"], remove: ["bash"] }]);
	runtime.sync();

	const preview = runtime.previewOptions({
		cwd: "/tmp",
		selectedTools: ["read", "bash"],
		toolSnippets: {},
		promptGuidelines: [],
		contextFiles: [],
		skills: [],
	}, activeStack.stack);

	assert.deepEqual(preview.selectedTools, ["read", "grep"]);
	assert.deepEqual(preview.toolSnippets?.grep, "Description of grep");
	assert.deepEqual(preview.promptGuidelines, ["Guideline for read", "Guideline for grep"]);
});


test("restored mode effects on either side of a crash are not external baseline removals", () => {
	const fake = createFakePi(["read"], ["read", "write"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);
	runtime.setInstructionModes([{ add: [], remove: ["write"] }], { baseline: ["read", "write"], lastApplied: ["read", "write"] });
	runtime.sync();
	runtime.setInstructionModes([]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "write"]);
});

test("off restored before a formerly added tool is removed does not adopt that tool", () => {
	const fake = createFakePi(["read", "write"], ["read", "write"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);
	runtime.setInstructionModes([], { baseline: ["read"], lastApplied: ["read", "write"] });
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read"]);
});

test("plain setters reject malformed patches without resetting the previous overlay", () => {
	const fake = createFakePi(["read", "write"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);
	runtime.setInstructionModes([{ add: [], remove: ["write"] }]);
	assert.throws(() => runtime.setInstructionModes([{ add: ["unknown"], remove: [] }]), /not registered/);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read"]);
});

test("preview ignores captured filtered selections after the last overlay is off", () => {
	const fake = createFakePi(["read", "write"]);
	const runtime = createToolPolicyRuntime(fake.pi, () => undefined);
	const stack = { schemaVersion: 2 as const, type: "pi-forge.prompt-stack" as const, id: "base", items: [] };
	runtime.setInstructionModes([{ add: [], remove: ["write"] }]);
	runtime.sync();
	const captured = { cwd: "/test", selectedTools: ["read"], promptGuidelines: ["Guideline for read"] };
	runtime.setInstructionModes([]);
	runtime.sync();
	assert.deepEqual(fake.getActive(), ["read", "write"]);
	const preview = runtime.previewOptions(captured, stack);
	assert.deepEqual(preview.selectedTools, ["read", "write"]);
	assert.ok(preview.promptGuidelines?.includes("Guideline for write"));
	fake.pi.setActiveTools([]);
	assert.deepEqual(runtime.previewOptions(captured, stack).selectedTools, [],
		"an empty live selection is not permission to reuse stale tools");
});
