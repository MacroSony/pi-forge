import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
	assert.ok(complete("enable ").some((item: { value: string; label: string }) => item.value === "enable review" && item.label.startsWith("project:review")));
	assert.ok(complete("enable project:").some((item: { value: string }) => item.value === "enable project:review"));
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

test("real SDK capability completion tracks bindings, refresh, activations, trust and disposal without inference", async () => {
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
		const direct = await complete("enable list");
		assert.equal(direct.length, 1);
		assert.equal(direct[0].value, "enable listing");
		await h.prompt(`/capability ${direct[0].value}`);
		const event = h.manager.getEntries().find((entry: any) =>
			entry.type === "custom" && entry.customType === "pi-forge-capability-event" && entry.data?.op === "activate",
		) as any;
		assert.deepEqual(event?.data.snapshot.source, { kind: "capability", key: { scope: "project", id: "listing" } });
		const directActive = await complete("disable ");
		assert.equal(directActive.length, 1);
		await h.prompt(`/capability ${directActive[0].value}`);
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

test("capability enable completions follow preset and profile consistency rules", async () => {
	const prevGlobal = process.env.PI_FORGE_GLOBAL_DIR;
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-cli-global-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-cli-project-"));
	process.env.PI_FORGE_GLOBAL_DIR = globalDir;

	try {
		const projCapDir = capabilitiesDir(cwd);
		const globCapDir = join(globalDir, "capabilities");
		mkdirSync(projCapDir, { recursive: true });
		mkdirSync(globCapDir, { recursive: true });

		for (const [directory, id, name] of [
			[projCapDir, "unique-proj", "Project Unique"],
			[globCapDir, "unique-glob", "Global Unique"],
			[projCapDir, "collide-cap", "Collide Local"],
			[globCapDir, "collide-cap", "Collide Global"],
			[globCapDir, "shadowed-cap", "Shadowed Global"],
		]) {
			writeFileSync(join(directory!, `${id}.json`), JSON.stringify({
				schemaVersion: 1, type: "pi-forge.capability", id, name,
				content: "Fixture instruction", tools: { add: [], remove: [] },
			}));
		}
		// Invalid project capability still shadows its usable global counterpart.
		writeFileSync(join(projCapDir, "shadowed-cap.json"), "{ invalid json ");

		const harness = createHarness();
		const context = createContext(cwd);
		const { ctx } = context;
		await startSession(harness, ctx);
		await harness.commands.capability.handler("list", ctx);

		const complete = harness.commands.capability.getArgumentCompletions!;

		const beforeTools = harness.getActiveTools();
		const beforeAppends = harness.appended.length;
		const readFiles = (directory: string) => readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), "utf8")]);
		const beforeProjFiles = readFiles(projCapDir);
		const beforeGlobFiles = readFiles(globCapDir);

		// 1. Unique: bare id if no collision, label qualified with source/name
		const allCompletions = complete("enable ");
		assert.ok(allCompletions.some((item: { value: string; label: string }) =>
			item.value === "enable unique-proj" && item.label === "project:unique-proj — Project Unique"
		));
		assert.ok(allCompletions.some((item: { value: string; label: string }) =>
			item.value === "enable unique-glob" && item.label === "global:unique-glob — Global Unique"
		));
		assert.ok(!allCompletions.some((item: { value: string }) => item.value === "enable project:unique-proj"));
		assert.ok(!allCompletions.some((item: { value: string }) => item.value === "enable global:unique-glob"));

		// 2. Colliding: both qualified if collision, labels qualified
		assert.ok(allCompletions.some((item: { value: string; label: string }) =>
			item.value === "enable project:collide-cap" && item.label === "project:collide-cap — Collide Local"
		));
		assert.ok(allCompletions.some((item: { value: string; label: string }) =>
			item.value === "enable global:collide-cap" && item.label === "global:collide-cap — Collide Global"
		));
		assert.ok(!allCompletions.some((item: { value: string }) => item.value === "enable collide-cap"));

		// 3. Invalid project shadows global:
		// Full snapshot includes invalid project:shadowed-cap and valid global:shadowed-cap.
		// Collision is detected. Only usable resources are offered, so invalid project:shadowed-cap is NOT offered.
		// global:shadowed-cap is offered QUALIFIED, bare completion is NOT exposed.
		assert.ok(allCompletions.some((item: { value: string; label: string }) =>
			item.value === "enable global:shadowed-cap" && item.label === "global:shadowed-cap — Shadowed Global"
		));
		assert.ok(!allCompletions.some((item: { value: string }) => item.value === "enable shadowed-cap"));
		assert.ok(!allCompletions.some((item: { value: string }) => item.value === "enable project:shadowed-cap"));

		// 4. Bare prefix matching (input has no ':')
		const projPrefix = complete("enable unique-p");
		assert.deepEqual(projPrefix.map((x: { value: string }) => x.value), ["enable unique-proj"]);

		const globPrefix = complete("enable unique-g");
		assert.deepEqual(globPrefix.map((x: { value: string }) => x.value), ["enable unique-glob"]);

		// Bare prefix matching "shadow" does NOT match qualified global:shadowed-cap
		const shadowBare = complete("enable shadow");
		assert.deepEqual(shadowBare, []);

		// Bare prefix matching "collide" does NOT match qualified project:collide-cap / global:collide-cap
		const collideBare = complete("enable collide");
		assert.deepEqual(collideBare, []);

		// Prefixes "proj" and "glob" match qualified selectors
		const projScopePrefix = complete("enable proj");
		assert.ok(projScopePrefix.some((x: { value: string }) => x.value === "enable project:collide-cap"));

		const globScopePrefix = complete("enable glob");
		assert.ok(globScopePrefix.some((x: { value: string }) => x.value === "enable global:collide-cap"));
		assert.ok(globScopePrefix.some((x: { value: string }) => x.value === "enable global:shadowed-cap"));

		// 5. Explicit prefixes: input contains ':' offers qualified even without collision
		const explicitProj = complete("enable project:");
		assert.deepEqual(explicitProj.map((x: { value: string }) => x.value), [
			"enable project:collide-cap",
			"enable project:unique-proj",
		]);
		assert.ok(explicitProj.every((x: { label: string }) => x.label.startsWith("project:")));

		const explicitGlob = complete("enable global:");
		assert.deepEqual(explicitGlob.map((x: { value: string }) => x.value), [
			"enable global:collide-cap",
			"enable global:shadowed-cap",
			"enable global:unique-glob",
		]);
		assert.ok(explicitGlob.every((x: { label: string }) => x.label.startsWith("global:")));

		const explicitProjPrefix = complete("enable project:uni");
		assert.deepEqual(explicitProjPrefix.map((x: { value: string }) => x.value), ["enable project:unique-proj"]);

		const explicitGlobPrefix = complete("enable global:uni");
		assert.deepEqual(explicitGlobPrefix.map((x: { value: string }) => x.value), ["enable global:unique-glob"]);

		// 6. Read-only completion; the SDK test above separately asserts zero inference.
		assert.deepEqual(harness.getActiveTools(), beforeTools);
		assert.equal(harness.appended.length, beforeAppends);
		assert.deepEqual(readFiles(projCapDir), beforeProjFiles);
		assert.deepEqual(readFiles(globCapDir), beforeGlobFiles);
	} finally {
		if (prevGlobal === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = prevGlobal;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	}
});
