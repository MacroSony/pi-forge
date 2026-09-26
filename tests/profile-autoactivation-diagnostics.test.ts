import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GLOBAL_FORGE_DIR_ENV } from "../src/storage.ts";
import {
	createContext,
	createHarness,
	startSession,
	writeProfile,
	writeStack,
} from "./helpers/index-command-harness.ts";

function writeGlobalProfile(globalDir: string, name: string, value: unknown): void {
	const dir = join(globalDir, "agent-profiles");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

test("single invalid autoActivate profile reports preflight failure with diagnostics, not multiple profiles", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-test-invalid-profile-"));
	const globalDir = mkdtempSync(join(tmpdir(), "forge-test-invalid-global-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	t.after(() => {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	});

	writeStack(cwd, "fallback.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "fallback",
		autoActivate: true,
		items: [],
	});

	writeProfile(cwd, "broken.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "broken",
		autoActivate: true,
		model: { provider: "", id: "" },
		thinkingLevel: "off",
		promptStack: null,
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	const preflightNotification = context.notifications.find((n) => n.message.includes("failed preflight"));
	assert.ok(preflightNotification, `Expected preflight failure notification, got: ${JSON.stringify(context.notifications)}`);
	assert.ok(preflightNotification.message.includes("broken"), "Notification should mention broken profile ID");
	assert.ok(preflightNotification.message.includes("model.provider must not be empty"), "Notification should explain model.provider error");
	assert.ok(preflightNotification.message.includes("model.id must not be empty"), "Notification should explain model.id error");

	assert.ok(
		!context.notifications.some((n) => n.message.includes("multiple agent profiles")),
		"Must NOT misdiagnose single invalid profile as multiple profiles",
	);

	// Fail closed: neither profile nor fallback preset should be active
	assert.equal(context.statuses["pi-forge"], undefined);
	await harness.events.session_shutdown?.({}, context.ctx);
});

test("genuinely multiple autoActivate profiles report multiple-profile notification and fail closed", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-test-multiple-profiles-"));
	const globalDir = mkdtempSync(join(tmpdir(), "forge-test-multiple-global-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	t.after(() => {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	});

	writeProfile(cwd, "one.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "one",
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	writeProfile(cwd, "two.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "two",
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	assert.ok(
		context.notifications.some((n) => n.message.includes("multiple agent profiles request auto-activation")),
		"Must report multiple agent profiles",
	);
	assert.equal(context.statuses["pi-forge"], undefined);
	await harness.events.session_shutdown?.({}, context.ctx);
});

test("project-over-global shadow: non-autoactivating project profile shadows global auto-activation", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-test-shadow-proj-"));
	const globalDir = mkdtempSync(join(tmpdir(), "forge-test-shadow-glob-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	t.after(() => {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	});

	writeGlobalProfile(globalDir, "reviewer.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "reviewer",
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	writeProfile(cwd, "reviewer.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "reviewer",
		autoActivate: false,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	writeStack(cwd, "fallback.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "fallback",
		autoActivate: true,
		items: [],
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	// Shadowed global autoActivate profile does not activate; fallback preset should activate
	assert.ok(!context.notifications.some((n) => n.message.includes("reviewer")));
	assert.ok(!context.notifications.some((n) => n.message.includes("multiple agent profiles")));
	assert.equal(context.statuses["pi-forge"], "stack:fallback");
	await harness.events.session_shutdown?.({}, context.ctx);
});

test("project-over-global precedence: valid project candidate wins over global candidate without ambiguity", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-test-proj-win-"));
	const globalDir = mkdtempSync(join(tmpdir(), "forge-test-proj-win-glob-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	t.after(() => {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	});

	writeGlobalProfile(globalDir, "global-bot.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "global-bot",
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	writeProfile(cwd, "proj-bot.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "proj-bot",
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	const testModel = { provider: "test-provider", id: "test-model", reasoning: false, input: ["text"] };
	const harness = createHarness({
		currentModel: testModel,
		models: [testModel],
		availableModels: [testModel],
	});
	const context = createContext(cwd, [], { modelRuntime: harness });
	await startSession(harness, context.ctx);

	assert.ok(
		context.notifications.some((n) => n.message.includes("auto-activated profile proj-bot")),
		"Project candidate should auto-activate",
	);
	assert.ok(
		!context.notifications.some((n) => n.message.includes("multiple agent profiles")),
		"Must not report multiple profiles when project precedence resolves the single project candidate",
	);
	await harness.events.session_shutdown?.({}, context.ctx);
});

test("project-over-global precedence: invalid project candidate fails closed without falling back to global", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-test-proj-failclosed-"));
	const globalDir = mkdtempSync(join(tmpdir(), "forge-test-proj-failclosed-glob-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	t.after(() => {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	});

	writeGlobalProfile(globalDir, "global-bot.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "global-bot",
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	writeProfile(cwd, "broken-proj.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "broken-proj",
		autoActivate: true,
		model: { provider: "", id: "" },
		thinkingLevel: "off",
		promptStack: null,
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	const preflightNotification = context.notifications.find((n) => n.message.includes("failed preflight"));
	assert.ok(preflightNotification, "Project candidate failure must be reported");
	assert.ok(preflightNotification.message.includes("broken-proj"));
	assert.ok(
		!context.notifications.some((n) => n.message.includes("global-bot")),
		"Must NOT fall back to global candidate",
	);
	assert.ok(
		!context.notifications.some((n) => n.message.includes("multiple agent profiles")),
		"Must NOT report multiple profiles",
	);
	assert.equal(context.statuses["pi-forge"], undefined);
	await harness.events.session_shutdown?.({}, context.ctx);
});

test("multiple global autoActivate profiles report multiple-profile notification and fail closed", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-test-multi-glob-"));
	const globalDir = mkdtempSync(join(tmpdir(), "forge-test-multi-glob-dir-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	t.after(() => {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
	});

	writeGlobalProfile(globalDir, "glob-one.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "glob-one",
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	writeGlobalProfile(globalDir, "glob-two.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "glob-two",
		autoActivate: true,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "off",
		promptStack: null,
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	assert.ok(
		context.notifications.some((n) => n.message.includes("multiple agent profiles request auto-activation")),
		"Must report multiple profiles for multiple global candidates",
	);
	assert.equal(context.statuses["pi-forge"], undefined);
	await harness.events.session_shutdown?.({}, context.ctx);
});
