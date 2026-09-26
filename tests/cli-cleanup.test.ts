import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilitiesDir } from "../src/repositories/capability.ts";
import { createContext, createHarness, startSession, writeProfile, writeStack } from "./helpers/index-command-harness.ts";

test("capability command works and its unpublished alias is unregistered", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-cli-cleanup-"));
	mkdirSync(capabilitiesDir(cwd), { recursive: true });
	writeFileSync(join(capabilitiesDir(cwd), "review.json"), JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.capability",
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
		capabilities: [{ ref: "review", id: "human-review", modelCallable: false }],
	});
	const harness = createHarness();
	const context = createContext(cwd);
	const { ctx } = context;
	await startSession(harness, ctx);

	await harness.commands.capability.handler("list", ctx);
	const complete = harness.commands.capability.getArgumentCompletions!;
	const beforeTools = harness.getActiveTools();
	const beforeAppends = harness.appended.length;
	assert.deepEqual(complete("e"), complete("enable"));
	assert.ok(complete("enable ").some((item: { value: string }) => item.value === "enable project:review"));
	assert.ok(complete("enable-bound ").some((item: { value: string; label: string }) => item.value === "enable-bound human-review" && /human-only/.test(item.label)));
	assert.deepEqual(harness.getActiveTools(), beforeTools);
	assert.equal(harness.appended.length, beforeAppends); // completion itself is read-only.

	assert.ok(harness.commands.capability);
	assert.equal(harness.commands.instruction, undefined, "legacy /instruction command must not be registered");
	assert.equal(harness.commands["system-update"], undefined);
	assert.equal(harness.tools.forge_system_update, undefined, "legacy forge_system_update tool must not be registered");
	assert.equal(harness.getAllTools().some((tool: { name: string }) => tool.name === "forge_system_update"), false);
	await harness.commands.capability.handler("help", ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /\/capability\b/);
	assert.doesNotMatch(context.editors.at(-1)?.text ?? "", /system-update|legacy alias/);
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
	const { createCapabilityAgentControlHarness } = await import("./helpers/capability-agent-control-harness.ts");
	const { initTheme } = await import("@earendil-works/pi-coding-agent"); initTheme();
	const { rmSync } = await import("node:fs");
	const cwd = mkdtempSync(join(tmpdir(), "forge-cli-sdk-"));
	let h: Awaited<ReturnType<typeof createCapabilityAgentControlHarness>> | undefined;
	try {
		mkdirSync(capabilitiesDir(cwd), { recursive: true });
		const mode = { schemaVersion: 1, type: "pi-forge.capability", id: "listing", content: "", tools: { add: ["ls"], remove: [] } };
		writeFileSync(join(capabilitiesDir(cwd), "listing.json"), JSON.stringify(mode));
		for (const id of ["a", "b"]) writeStack(cwd, `${id}.json`, {
			schemaVersion: 2, type: "pi-forge.prompt-stack", id, autoActivate: false,
			tools: { allow: ["read", "forge_capability", "ls"], initial: ["read", "forge_capability"] },
			items: [{ kind: "slot", id: "history", slot: "chat-history" }],
			capabilities: [{ id: `human-${id}`, ref: "project:listing", modelCallable: false }],
		});
		h = await createCapabilityAgentControlHarness({ cwd, native: true, initialTools: [], allowedTools: ["read", "forge_capability", "ls"] });
		const command = h.extensionsResult.extensions.flatMap((e: any) => [...e.commands.entries()]).find(([name]: any) => name === "capability")![1];
		const complete = command.getArgumentCompletions;
		await h.prompt("/preset use project:a");
		assert.deepEqual((await complete("enable-bound ")).map((x: any) => x.value), ["enable-bound human-a"]);
		const before = JSON.stringify(h.manager.getEntries());
		for (let i = 0; i < 20; i++) await complete("enable project:");
		assert.equal(JSON.stringify(h.manager.getEntries()), before);
		await h.prompt("/capability enable-bound human-a");
		const active = await complete("disable "); assert.equal(active.length, 1);
		assert.match(active[0].value, /^disable [a-f0-9-]{36}$/); assert.match(active[0].label, /listing/);
		await h.prompt(`/capability ${active[0].value}`); assert.deepEqual(await complete("disable "), []);
		writeFileSync(join(capabilitiesDir(cwd), "new.json"), JSON.stringify({ ...mode, id: "new" }));
		assert.deepEqual(await complete("enable project:new"), []);
		await h.prompt("/capability list"); assert.equal((await complete("enable project:new")).length, 1);
		await h.prompt("/preset use project:b");
		assert.deepEqual((await complete("enable-bound ")).map((x: any) => x.value), ["enable-bound human-b"]);
		h.settingsManager.setProjectTrusted(false);
		assert.deepEqual(await complete("enable "), []); assert.deepEqual(await complete("enable-bound "), []);
		assert.equal(h.streamContexts.length, 0); assert.equal(h.fetchAttempts, 0);
		await h.dispose(); h = undefined;
		assert.deepEqual(await complete("enable "), []);
	} finally { await h?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
