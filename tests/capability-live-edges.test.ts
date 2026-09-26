import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityAgentHarness } from "./helpers/capability-agent-harness.ts";
const { getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

test("live tools and base prompts track an off performed in a run that started with a capability active", async (suite) => {
	for (const capability of ["replace", "append"] as const) await suite.test(capability, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "forge-live-edges-"));
		const root = join(cwd, ".pi", "forge");
		mkdirSync(join(root, "capabilities"), { recursive: true });
		mkdirSync(join(root, "prompt-stacks"), { recursive: true });
		writeFileSync(join(root, "config.json"), JSON.stringify({ autoActivate: true }));
		writeFileSync(join(root, "prompt-stacks", "base.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "base", autoActivate: true, mode: capability,
			items: [{ id: "system", kind: "block", role: "system", content: capability === "replace" ? "Tools: {{tools}}" : "APPENDED_FORGE_BODY" }] }));
		writeFileSync(join(root, "capabilities", "review.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.capability", id: "review", content: "REVIEW", tools: { add: [], remove: ["fake_write"] } }));
		const h = await createCapabilityAgentHarness({ cwd, native: true });
		try {
			await h.prompt("/capability enable review");
			h.setOnDriver(async () => { await h.prompt("/capability disable review"); });
			h.setResponses([{ toolCalls: [{ name: "fake_driver" }] }, "done"]);
			await h.prompt("stop the review capability mid-run");
			assert.equal(h.streamContexts.length, 2);
			assert.ok(!getCurrentSystemPrompt(h.streamContexts[0]!.messages).includes("fake_write"));
			assert.ok(getCurrentTools(h.streamContexts[1]!.messages).some((tool) => tool.name === "fake_write"));
			assert.ok(getCurrentSystemPrompt(h.streamContexts[1]!.messages).includes("fake_write"), "restored tools must also restore their prompt description");

			const branch = h.manager.getBranch();
			assert.equal(
				branch.some((e: any) => e.type === "custom_message" && e.customType === "pi-forge-capability-delivery"),
				false,
				"no custom_message delivery entries",
			);
			const anchors = branch.filter((e: any) => e.type === "custom" && e.customType === "pi-forge-capability-delivery");
			assert.equal(anchors.length, 2, "both on and off transitions produce plain metadata anchors");

			assert.equal(h.fetchAttempts, 0);
		} finally { await h.dispose(); rmSync(cwd, { recursive: true, force: true }); }
	});
});
