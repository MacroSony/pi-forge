import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piForge from "../src/index.ts";
import { promptStacksDir } from "../src/loader.ts";

function writeStack(cwd: string, name: string, value: unknown): void {
	mkdirSync(promptStacksDir(cwd), { recursive: true });
	writeFileSync(join(promptStacksDir(cwd), name), JSON.stringify(value, null, 2));
}

function writePreset(cwd: string, name: string, value: unknown): string {
	const dir = join(cwd, "st");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(value, null, 2));
	return path;
}

function createHarness() {
	const events: Record<string, Function> = {};
	const commands: Record<string, { handler: Function; getArgumentCompletions?: Function }> = {};
	const tools: Record<string, unknown> = {};
	const appended: { type: string; data: unknown }[] = [];

	const pi = {
		on(name: string, handler: Function) {
			events[name] = handler;
		},
		registerCommand(name: string, options: { handler: Function; getArgumentCompletions?: Function }) {
			commands[name] = options;
		},
		registerTool(tool: { name: string }) {
			tools[tool.name] = tool;
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
		},
	};

	piForge(pi as any);
	return { events, commands, tools, appended };
}

function createContext(cwd: string, entries: unknown[] = []) {
	const notifications: { message: string; type?: string }[] = [];
	const statuses: Record<string, string | undefined> = {};
	const editors: { title: string; text: string }[] = [];
	let confirmResult = false;

	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: undefined,
		signal: undefined,
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => undefined,
		},
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => {
				statuses[key] = text;
			},
			editor: async (title: string, text = "") => {
				editors.push({ title, text });
				return text;
			},
			confirm: async () => confirmResult,
		},
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "base system",
		getSystemPromptOptions: () => ({ cwd, selectedTools: [], toolSnippets: {}, promptGuidelines: [], contextFiles: [], skills: [] }),
		waitForIdle: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
	};

	return {
		ctx: ctx as any,
		notifications,
		statuses,
		editors,
		setConfirmResult(value: boolean) {
			confirmResult = value;
		},
	};
}

async function startSession(harness: ReturnType<typeof createHarness>, ctx: any): Promise<void> {
	await harness.events.session_start?.({ type: "session_start", reason: "startup" }, ctx);
}

test("/preset completions preserve second-level subcommand text", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx } = createContext(cwd);
	await startSession(harness, ctx);

	const completions = await harness.commands.preset.getArgumentCompletions?.("use d");

	assert.ok(Array.isArray(completions));
	assert.ok(completions.some((item: { value: string }) => item.value === "use default"));
});

test("legacy /preset vars uses typed state validation", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		state: {
			schemaVersion: 1,
			definitions: {
				"user.count": { type: "number", scope: "session", userWritable: true },
			},
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx, notifications } = createContext(cwd);
	await startSession(harness, ctx);

	await harness.commands.preset.handler("vars set user.count nope", ctx);
	assert.equal(harness.appended.length, 0);
	assert.match(notifications.at(-1)?.message ?? "", /expected number/);

	await harness.commands.state.handler("set user.count 2", ctx);
	assert.equal(harness.appended.at(-1)?.type, "pi-forge-variable-state");
	assert.deepEqual((harness.appended.at(-1)?.data as { variables: unknown }).variables, { "user.count": 2 });
});

test("/preset import-silly protects existing generated files unless confirmed", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const presetPath = writePreset(cwd, "preset.json", {
		prompts: [
			{ identifier: "main", role: "system", content: "New content" },
			{ identifier: "chatHistory", marker: true },
		],
		prompt_order: [{ character_id: 1, order: [{ identifier: "main", enabled: true }, { identifier: "chatHistory", enabled: true }] }],
	});
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const existingStackPath = join(promptStacksDir(cwd), "preset.json");
	writeFileSync(existingStackPath, "old stack", "utf8");

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	await harness.commands.preset.handler(`import-silly ${presetPath}`, context.ctx);
	assert.equal(readFileSync(existingStackPath, "utf8"), "old stack");
	assert.match(context.notifications.at(-1)?.message ?? "", /cancelled/);

	context.setConfirmResult(true);
	await harness.commands.preset.handler(`import-silly ${presetPath}`, context.ctx);
	assert.notEqual(readFileSync(existingStackPath, "utf8"), "old stack");
	assert.ok(existsSync(join(cwd, ".pi", "forge", "import-reports", "preset.md")));
});
