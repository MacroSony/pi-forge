import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInstructionAgentHarness } from "./helpers/instruction-agent-harness.ts";
const { getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

test("live tools and base prompts track an off performed in a run that started with a mode active", async (suite) => {
	for (const mode of ["replace", "append"] as const) await suite.test(mode, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "forge-live-edges-"));
		const root = join(cwd, ".pi", "forge");
		mkdirSync(join(root, "instruction-modes"), { recursive: true });
		mkdirSync(join(root, "prompt-stacks"), { recursive: true });
		writeFileSync(join(root, "config.json"), JSON.stringify({ autoActivate: true }));
		writeFileSync(join(root, "prompt-stacks", "base.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "base", autoActivate: true, mode,
			items: [{ id: "system", kind: "block", role: "system", content: mode === "replace" ? "Tools: {{tools}}" : "APPENDED_FORGE_BODY" }] }));
		writeFileSync(join(root, "instruction-modes", "review.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.instruction-mode", id: "review", content: "REVIEW", tools: { add: [], remove: ["fake_write"] } }));
		const h = await createInstructionAgentHarness({ cwd, native: true });
		try {
			await h.prompt("/system-update use review");
			h.setOnDriver(async () => { await h.prompt("/system-update off review"); });
			h.setResponses([{ toolCalls: [{ name: "fake_driver" }] }, "done"]);
			await h.prompt("stop the review mode mid-run");
			assert.equal(h.streamContexts.length, 2);
			assert.ok(!getCurrentSystemPrompt(h.streamContexts[0]!.messages).includes("fake_write"));
			assert.ok(getCurrentTools(h.streamContexts[1]!.messages).some((tool) => tool.name === "fake_write"));
			assert.ok(getCurrentSystemPrompt(h.streamContexts[1]!.messages).includes("fake_write"), "restored tools must also restore their prompt description");

			const branch = h.manager.getBranch();
			assert.equal(
				branch.some((e: any) => e.type === "custom_message" && e.customType === "pi-forge-instruction-delivery"),
				false,
				"no custom_message delivery entries",
			);
			const anchors = branch.filter((e: any) => e.type === "custom" && e.customType === "pi-forge-instruction-delivery");
			assert.equal(anchors.length, 2, "both on and off transitions produce plain metadata anchors");

			assert.equal(h.fetchAttempts, 0);
		} finally { await h.dispose(); rmSync(cwd, { recursive: true, force: true }); }
	});
});
