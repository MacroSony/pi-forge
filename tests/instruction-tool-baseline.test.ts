import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInstructionRuntime } from "../src/runtime/instruction-runtime.ts";
import { createToolPolicyRuntime } from "../src/runtime/tool-policy-runtime.ts";
import { ForgeWorkspace } from "../src/workspace.ts";

function setupHermeticProject(toolsInitial: string[] = ["read"]) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-tool-baseline-"));
	mkdirSync(join(cwd, ".pi", "forge", "prompt-stacks"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "forge", "instruction-modes"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify({ autoActivate: true }, null, 2));
	writeFileSync(join(cwd, ".pi", "forge", "prompt-stacks", "initial-only.json"), JSON.stringify({
		schemaVersion: 2,
		type: "pi-forge.prompt-stack",
		id: "initial-only",
		name: "Initial Only Preset",
		autoActivate: true,
		tools: { initial: toolsInitial },
		items: [{ kind: "block", id: "b1", role: "system", content: "Base system content" }],
	}, null, 2));
	return {
		cwd,
		cleanup() {
			try {
				rmSync(cwd, { recursive: true, force: true });
			} catch {}
		},
	};
}

test("rememberTools persists baseline for tools.initial-only and restores read/write after runtime reconstruction from filtered set", () => {
	const env = setupHermeticProject(["read"]);
	try {
		const workspace = new ForgeWorkspace();
		workspace.reload(env.cwd, { trusted: true });

		const branchEntries: any[] = [];
		let currentActive = ["read", "write"];
		const fakePi: any = {
			getActiveTools: () => [...currentActive],
			getAllTools: () => [{ name: "read" }, { name: "write" }],
			setActiveTools: (tools: string[]) => {
				currentActive = [...tools];
			},
			appendEntry: (customType: string, data: any) => {
				branchEntries.push({ type: "custom", customType, data });
			},
			events: { on: () => () => {}, emit: () => {} },
		};

		const fakeContext: any = {
			cwd: env.cwd,
			isProjectTrusted: () => true,
			isIdle: () => true,
			ui: {
				setStatus: () => {},
				notify: () => {},
				theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
			},
			sessionManager: {
				getBranch: () => branchEntries,
				appendCustomEntry: (entry: any) => branchEntries.push(entry),
				getSessionId: () => "session-test",
				getLeafId: () => "leaf-test",
			},
		};

		// 1. Initial runtime setup with active preset having tools.initial: ["read"]
		const toolPolicy1 = createToolPolicyRuntime(fakePi, () => workspace.snapshotKnown ? workspace.snapshot().active : undefined);
		const runtime1 = createInstructionRuntime(fakePi, workspace, toolPolicy1);
		runtime1.restore(fakeContext);

		// Active tools should now be filtered to ["read"]
		assert.deepEqual(fakePi.getActiveTools(), ["read"]);

		// Baseline should be persisted in session entries even without allow/deny policy
		const toolEntries = branchEntries.filter((e) => e.customType === "pi-forge-instruction-tools");
		assert.equal(toolEntries.length, 1);
		assert.deepEqual(toolEntries[0].data.baseline, ["read", "write"]);
		assert.deepEqual(toolEntries[0].data.lastApplied, ["read"]);

		// 2. Reconstruct runtime where the host's active tools are already the filtered set ["read"]
		const toolPolicy2 = createToolPolicyRuntime(fakePi, () => workspace.snapshotKnown ? workspace.snapshot().active : undefined);
		const runtime2 = createInstructionRuntime(fakePi, workspace, toolPolicy2);

		runtime2.prepareRestore(fakeContext);
		runtime2.restore(fakeContext);

		// While preset is still active, active tools remain ["read"]
		assert.deepEqual(fakePi.getActiveTools(), ["read"]);

		// 3. Disable preset
		workspace.reload(env.cwd, { activeStackId: "none" });
		runtime2.sync(fakeContext);

		// Both "read" and "write" must be restored from the persisted baseline
		assert.deepEqual(fakePi.getActiveTools(), ["read", "write"]);

		runtime1.dispose();
		runtime2.dispose();
		workspace.dispose();
	} finally {
		env.cleanup();
	}
});
