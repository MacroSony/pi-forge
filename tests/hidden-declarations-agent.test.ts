import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

import { createCapabilityAgentHarness } from "./helpers/capability-agent-harness.ts";
import { resolveHostFamilyVersion } from "../scripts/packed-versions.ts";

const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();
const { getCurrentSystemPrompt } = await import("@earendil-works/pi-ai");
const [major, minor, patch] = resolveHostFamilyVersion(process.cwd()).split(".").map(Number);
// Pi 1.0.4 first passes BuildSystemPromptOptions.hiddenTools. Older hosts list hidden
// declarations in their own default prompt too (0.87 has no prepareLoadout at all), and
// Forge matches the host there.
const hostReportsHiddenTools = major > 1 || (major === 1 && (minor > 0 || patch >= 4));

test("stock tool slots follow prepareLoadout hiddenDeclarations in a real session", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-hidden-declarations-"));
	const forgeDir = join(cwd, ".pi", "forge");
	mkdirSync(join(forgeDir, "prompt-stacks"), { recursive: true });
	writeFileSync(join(forgeDir, "config.json"), JSON.stringify({ autoActivate: true }));
	writeFileSync(join(forgeDir, "prompt-stacks", "base.json"), JSON.stringify({
		schemaVersion: 1, type: "pi-forge.prompt-stack", id: "base", autoActivate: true,
		tools: { initial: ["fake_read", "fake_write", "orchestrator"], allow: ["fake_read", "fake_write", "orchestrator"] },
		items: [
			{ kind: "slot", id: "tools", role: "system", slot: "tools", options: { format: "plain" } },
			{ kind: "slot", id: "guidelines", role: "system", slot: "tool-guidelines", options: { format: "plain" } },
		],
	}));
	const h = await createCapabilityAgentHarness({
		cwd,
		allowedTools: ["fake_write", "fake_read", "fake_driver", "orchestrator"],
		extensionFactories: [(pi: any) => {
			pi.registerTool({
				name: "orchestrator", label: "Orchestrator", description: "Runs hidden tools.", promptSnippet: "Run hidden tools",
				parameters: Type.Object({}),
				prepareLoadout: () => ({ hiddenDeclarations: ["fake_write"] }),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		}],
	});
	try {
		h.setResponses(["ok"]);
		await h.prompt("hello");
		const system = getCurrentSystemPrompt(h.streamContexts.at(-1)!.messages) ?? "";
		assert.match(system, /- orchestrator: Run hidden tools/);
		assert.match(system, /- fake_read:/);
		if (hostReportsHiddenTools) assert.doesNotMatch(system, /- fake_write:/, system);
		else assert.match(system, /- fake_write:/, system);
		assert.ok(h.getActiveToolNames().includes("fake_write"), "the hidden tool stays active and callable");
	} finally {
		await h.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
