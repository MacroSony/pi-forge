import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { instructionModesDir } from "../src/repositories/instruction-mode.ts";
import { createContext, createHarness, startSession, writeProfile, writeStack } from "./helpers/index-command-harness.ts";

test("instruction aliases share help and read-only completion projections", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-cli-cleanup-"));
	mkdirSync(instructionModesDir(cwd), { recursive: true });
	writeFileSync(join(instructionModesDir(cwd), "review.json"), JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.instruction-mode",
		id: "review",
		name: "Review Mode",
		content: "Review changes",
		tools: { add: [], remove: [] },
	}));
	writeStack(cwd, "base.json", {
		schemaVersion: 2,
		type: "pi-forge.prompt-stack",
		id: "base",
		autoActivate: true,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
		instructionModes: [{ ref: "review", id: "human-review", modelCallable: false }],
	});
	const harness = createHarness();
	const context = createContext(cwd);
	const { ctx } = context;
	await startSession(harness, ctx);

	await harness.commands.instruction.handler("list", ctx);
	const complete = harness.commands.instruction.getArgumentCompletions!;
	const beforeTools = harness.getActiveTools();
	const beforeAppends = harness.appended.length;
	assert.deepEqual(complete("u"), complete("use"));
	assert.ok(complete("use ").some((item: { value: string }) => item.value === "use project:review"));
	assert.ok(complete("use-bound ").some((item: { value: string; label: string }) => item.value === "use-bound human-review" && /human-only/.test(item.label)));
	assert.deepEqual(harness.getActiveTools(), beforeTools);
	assert.equal(harness.appended.length, beforeAppends); // completion itself is read-only.

	await harness.commands["system-update"].handler("help", ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /legacy alias/);
});

 test("preset completion scopes and strict argument validation avoid sentinel leakage", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-cli-cleanup-"));
	writeStack(cwd, "base.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "base",
		autoActivate: true,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const context = createContext(cwd);
	const { ctx } = context;
	await startSession(harness, ctx);
	const complete = harness.commands.preset.getArgumentCompletions!;
	assert.ok(complete("use ").some((item: { value: string }) => item.value === "use none"));
	assert.ok(complete("use project:").some((item: { value: string }) => item.value === "use project:base"));
	assert.equal(complete("preview ").some((item: { value: string }) => /none|off/.test(item.value)), false);
	assert.deepEqual(complete("use base stray"), []);

	await harness.commands.preset.handler("ui typo", ctx);
	assert.match(context.notifications.at(-1)?.message ?? "", /Usage: \/preset ui/);
});

test("profile completion accepts explicit scope prefixes and rejects extra selector tokens", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-cli-cleanup-"));
	writeProfile(cwd, "worker.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "worker",
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		promptStack: null,
	});
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);
	const complete = harness.commands.profile.getArgumentCompletions!;
	assert.ok(complete("use project:").some((item: { value: string }) => item.value === "use project:worker"));
	assert.ok(complete("save project:").some((item: { value: string }) => item.value === "save project:worker"));
	assert.deepEqual(complete("validate worker stray"), []);
});

test("real SDK instruction completion tracks bindings, refresh, activations, trust and disposal without inference", async () => {
	const { createInstructionAgentControlHarness } = await import("./helpers/instruction-agent-control-harness.ts");
	const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
	const { rmSync } = await import("node:fs");
	const cwd = mkdtempSync(join(tmpdir(), "forge-cli-sdk-"));
	let h: Awaited<ReturnType<typeof createInstructionAgentControlHarness>> | undefined;
	try {
		mkdirSync(instructionModesDir(cwd), { recursive: true });
		const mode = { schemaVersion: 1, type: "pi-forge.instruction-mode", id: "listing", content: "", tools: { add: ["ls"], remove: [] } };
		writeFileSync(join(instructionModesDir(cwd), "listing.json"), JSON.stringify(mode));
		for (const id of ["a", "b"]) writeStack(cwd, `${id}.json`, {
			schemaVersion: 2, type: "pi-forge.prompt-stack", id, autoActivate: false,
			tools: { allow: ["read", "forge_system_update", "ls"], initial: ["read", "forge_system_update"] },
			items: [{ kind: "slot", id: "history", slot: "chat-history" }],
			instructionModes: [{ id: `human-${id}`, ref: "project:listing", modelCallable: false }],
		});
		h = await createInstructionAgentControlHarness({ cwd, native: true, initialTools: [], allowedTools: ["read", "forge_system_update", "ls"] });
		const command = h.extensionsResult.extensions.flatMap((e: any) => [...e.commands.entries()]).find(([name]: any) => name === "instruction")[1];
		const complete = command.getArgumentCompletions;
		await h.prompt("/preset use project:a");
		assert.deepEqual((await complete("use-bound ")).map((x: any) => x.value), ["use-bound human-a"]);
		const before = JSON.stringify(h.manager.getEntries());
		for (let i = 0; i < 20; i++) await complete("use project:");
		assert.equal(JSON.stringify(h.manager.getEntries()), before);
		await h.prompt("/instruction use-bound human-a");
		const active = await complete("off "); assert.equal(active.length, 1);
		assert.match(active[0].value, /^off [a-f0-9-]{36}$/); assert.match(active[0].label, /listing/);
		await h.prompt(`/system-update ${active[0].value}`); assert.deepEqual(await complete("off "), []);
		writeFileSync(join(instructionModesDir(cwd), "new.json"), JSON.stringify({ ...mode, id: "new" }));
		assert.deepEqual(await complete("use project:new"), []);
		await h.prompt("/instruction list"); assert.equal((await complete("use project:new")).length, 1);
		await h.prompt("/preset use project:b");
		assert.deepEqual((await complete("use-bound ")).map((x: any) => x.value), ["use-bound human-b"]);
		h.settingsManager.setProjectTrusted(false);
		assert.deepEqual(await complete("use "), []); assert.deepEqual(await complete("use-bound "), []);
		assert.equal(h.streamContexts.length, 0); assert.equal(h.fetchAttempts, 0);
		await h.dispose(); h = undefined;
		assert.deepEqual(await complete("use "), []);
	} finally { await h?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
