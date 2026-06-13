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
	const tools: Record<string, any> = {};
	const appended: { type: string; data: unknown }[] = [];

	const pi = {
		on(name: string, handler: Function) {
			events[name] = handler;
		},
		registerCommand(name: string, options: { handler: Function; getArgumentCompletions?: Function }) {
			commands[name] = options;
		},
		registerTool(tool: { name: string; execute?: Function }) {
			tools[tool.name] = tool;
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
		},
	};

	piForge(pi as any);
	return { events, commands, tools, appended };
}

function createContext(cwd: string, entries: unknown[] = [], options: { trusted?: boolean; leafId?: string | null } = {}) {
	const notifications: { message: string; type?: string }[] = [];
	const statuses: Record<string, string | undefined> = {};
	const editors: { title: string; text: string }[] = [];
	let confirmResult = false;
	let leafId = options.leafId;

	function getBranch(fromId?: string): unknown[] {
		const startId = fromId ?? leafId;
		if (startId === null) return [];
		if (startId === undefined) return entries;
		const byId = new Map(entries.map((entry) => [(entry as { id?: unknown }).id, entry]));
		const path: unknown[] = [];
		let current = byId.get(startId);
		while (current) {
			path.unshift(current);
			const parentId = (current as { parentId?: unknown }).parentId;
			current = typeof parentId === "string" ? byId.get(parentId) : undefined;
		}
		return path;
	}

	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		model: undefined,
		signal: undefined,
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => leafId,
			getBranch,
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
		isProjectTrusted: () => options.trusted ?? true,
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
		setLeafId(value: string | null | undefined) {
			leafId = value;
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

test("/preset use, disable, and reload persist selection and update footer", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeStack(cwd, "other.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "other",
		autoActivate: false,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx, statuses } = createContext(cwd);
	await startSession(harness, ctx);

	assert.equal(statuses["pi-forge"], "stack:default");

	await harness.commands.preset.handler("use other", ctx);
	assert.equal(statuses["pi-forge"], "stack:other");
	assert.deepEqual(harness.appended.at(-1), { type: "pi-forge-prompt-stack-state", data: { activeStackId: "other" } });

	await harness.commands.preset.handler("use none", ctx);
	assert.equal(statuses["pi-forge"], undefined);
	assert.deepEqual(harness.appended.at(-1), { type: "pi-forge-prompt-stack-state", data: { activeStackId: "none" } });

	await harness.commands.preset.handler("reload", ctx);
	assert.equal(statuses["pi-forge"], undefined);
});

test("session_start restores active stack and typed variables", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeStack(cwd, "other.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "other",
		autoActivate: false,
		variables: { staticName: "static" },
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { "user.preference": "brief", bad: Number.NaN } } },
		{ type: "custom", customType: "pi-forge-prompt-stack-state", data: { activeStackId: "other" } },
	];
	const harness = createHarness();
	const { ctx, statuses, editors } = createContext(cwd, entries);
	await startSession(harness, ctx);

	assert.equal(statuses["pi-forge"], "stack:other");
	await harness.commands.state.handler("list", ctx);
	assert.match(editors.at(-1)?.text ?? "", /user\.preference = "brief"/);
	assert.doesNotMatch(editors.at(-1)?.text ?? "", /bad/);
	assert.match(editors.at(-1)?.text ?? "", /staticName = "static"/);
});

test("/preset validate shows requested stack diagnostics", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeStack(cwd, "bad.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "bad",
		items: [
			{ kind: "block", id: "dup", role: "system", content: "A" },
			{ kind: "block", id: "dup", role: "system", content: "B" },
		],
	});
	const harness = createHarness();
	const { ctx, editors } = createContext(cwd);
	await startSession(harness, ctx);

	await harness.commands.preset.handler("validate bad", ctx);

	assert.equal(editors.at(-1)?.title, "pi-forge validation: bad");
	assert.match(editors.at(-1)?.text ?? "", /Duplicate item id: dup/);
});

test("forge_state_set validates agent namespace and persists accepted updates", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		state: {
			schemaVersion: 1,
			definitions: {
				"agent.count": { type: "number", scope: "session", agentWritable: true },
			},
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx } = createContext(cwd);
	await startSession(harness, ctx);

	const tool = harness.tools.forge_state_set;
	const rejected = await tool.execute("call-1", { updates: [{ name: "user.preference", value: "brief" }] }, undefined, undefined, ctx);
	assert.match(rejected.content[0].text, /agents may only write agent\.\*/);

	const wrongType = await tool.execute("call-2", { updates: [{ name: "agent.count", value: "two" }] }, undefined, undefined, ctx);
	assert.match(wrongType.content[0].text, /expected number/);

	const accepted = await tool.execute("call-3", { updates: [{ name: "agent.count", value: 2, reason: "test" }] }, undefined, undefined, ctx);
	assert.match(accepted.content[0].text, /State updated: 1 set/);
	assert.equal(harness.appended.at(-1)?.type, "pi-forge-variable-state");
	assert.deepEqual((harness.appended.at(-1)?.data as { variables: unknown }).variables, { "agent.count": 2 });
});

test("context rewrite runs once per user turn and surfaces diagnostics", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [
			{ kind: "block", id: "system", enabled: true, role: "system", content: "Hello {{missing}}" },
			{ kind: "block", id: "before", enabled: true, role: "user", content: "before" },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	});
	const harness = createHarness();
	const { ctx, statuses, editors } = createContext(cwd);
	await startSession(harness, ctx);

	const startResult = await harness.events.before_agent_start({
		type: "before_agent_start",
		prompt: "latest",
		systemPrompt: "base",
		systemPromptOptions: ctx.getSystemPromptOptions(),
	}, ctx);
	assert.equal(startResult.systemPrompt, "Hello {{missing}}");
	assert.equal(statuses["pi-forge-diagnostics"], "forge:0e/1w");

	const firstContext = await harness.events.context({ type: "context", messages: [{ role: "user", content: "latest", timestamp: 1 }] }, ctx);
	assert.equal(firstContext.messages.length, 2);
	assert.equal(firstContext.messages[0].content[0].text, "before");

	const secondContext = await harness.events.context({ type: "context", messages: [{ role: "user", content: "tool follow-up", timestamp: 2 }] }, ctx);
	assert.equal(secondContext, undefined);

	await harness.commands.preset.handler("diagnostics", ctx);
	assert.match(editors.at(-1)?.text ?? "", /Unresolved macro: \{\{missing\}\}/);
});

test("/payload next saves a redacted provider payload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const harness = createHarness();
	const { ctx, statuses, notifications, editors } = createContext(cwd);
	const completions = await harness.commands.payload.getArgumentCompletions?.("next s");
	assert.ok(completions.some((item: { value: string }) => item.value === "next save=.pi/forge/payloads/last.json"));

	await harness.commands.payload.handler("next save=.pi/forge/payloads/last.json", ctx);
	assert.equal(statuses["pi-forge-intercept"], "payload:armed+save");

	await harness.events.before_provider_request({
		type: "before_provider_request",
		payload: {
			Authorization: "Bearer secret",
			messages: [{ content: "hello" }],
			image: "data:image/png;base64," + "a".repeat(100),
		},
	}, ctx);

	const saved = readFileSync(join(cwd, ".pi", "forge", "payloads", "last.json"), "utf8");
	assert.match(saved, /"Authorization": "\[redacted\]"/);
	assert.match(saved, /"image": "\[image data omitted\]"/);
	assert.match(saved, /"content": "hello"/);
	assert.equal(statuses["pi-forge-intercept"], undefined);
	assert.match(notifications.at(-1)?.message ?? "", /saved to/);
	assert.match(editors.at(-1)?.title ?? "", /pi-forge: provider payload \(\d+ chars, ~\d+ tokens\)/);
});

test("turn_start persists default active stack only once", async () => {
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

	await harness.events.turn_start({ type: "turn_start", turnIndex: 1, timestamp: 1 }, ctx);
	await harness.events.turn_start({ type: "turn_start", turnIndex: 2, timestamp: 2 }, ctx);

	assert.deepEqual(harness.appended, [{ type: "pi-forge-prompt-stack-state", data: { activeStackId: "default" } }]);
});

test("/state get and clear respect state write permissions", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		state: {
			schemaVersion: 1,
			definitions: {
				"user.locked": { type: "string", scope: "session", userWritable: false },
				"user.open": { type: "string", scope: "session", userWritable: true },
			},
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { "user.locked": "keep", "user.open": "remove" } } }];
	const harness = createHarness();
	const { ctx, editors, notifications } = createContext(cwd, entries);
	await startSession(harness, ctx);

	await harness.commands.state.handler("get user.locked", ctx);
	assert.match(editors.at(-1)?.text ?? "", /keep/);

	await harness.commands.state.handler("clear user.locked", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /not user-writable/);
	assert.notEqual(harness.appended.at(-1)?.type, "pi-forge-variable-state");

	await harness.commands.state.handler("clear user.open", ctx);
	assert.deepEqual((harness.appended.at(-1)?.data as { variables: unknown }).variables, { "user.locked": "keep" });
});

test("/preset import-silly supports dry-run, overwrite flag, and untrusted write refusal", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const presetPath = writePreset(cwd, "dry.json", {
		prompts: [
			{ identifier: "main", role: "system", content: "Dry content" },
			{ identifier: "chatHistory", marker: true },
		],
		prompt_order: [{ character_id: 1, order: [{ identifier: "main", enabled: true }, { identifier: "chatHistory", enabled: true }] }],
	});
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	await harness.commands.preset.handler(`import-silly ${presetPath} --dry-run`, context.ctx);
	assert.equal(existsSync(join(promptStacksDir(cwd), "dry.json")), false);
	assert.match(context.editors.at(-1)?.text ?? "", /Generated stack JSON/);

	mkdirSync(promptStacksDir(cwd), { recursive: true });
	const stackPath = join(promptStacksDir(cwd), "dry.json");
	writeFileSync(stackPath, "old", "utf8");
	await harness.commands.preset.handler(`import-silly ${presetPath} --overwrite`, context.ctx);
	assert.notEqual(readFileSync(stackPath, "utf8"), "old");

	const untrusted = createContext(cwd, [], { trusted: false });
	await harness.commands.preset.handler(`import-silly ${presetPath} --overwrite`, untrusted.ctx);
	assert.match(untrusted.notifications.at(-1)?.message ?? "", /not trusted/);
});

test("session_tree restores prompt state from the current branch only", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", id: "early-state", parentId: null, data: { variables: { "agent.progress": "early" } } },
		{ type: "message", id: "early-message", parentId: "early-state", message: { role: "user", content: "earlier" } },
		{ type: "custom", customType: "pi-forge-variable-state", id: "later-state", parentId: "early-message", data: { variables: { "agent.progress": "later" } } },
		{ type: "message", id: "later-message", parentId: "later-state", message: { role: "assistant", content: [{ type: "text", text: "later" }] } },
	];
	const harness = createHarness();
	const context = createContext(cwd, entries, { leafId: "later-message" });
	await startSession(harness, context.ctx);

	await harness.commands.state.handler("get agent.progress", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /later/);

	context.setLeafId("early-message");
	await harness.events.session_tree({ type: "session_tree", oldLeafId: "later-message", newLeafId: "early-message" }, context.ctx);
	await harness.commands.state.handler("get agent.progress", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /early/);
	assert.doesNotMatch(context.editors.at(-1)?.text ?? "", /later/);
});

test("session_tree before any state clears restored prompt state", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [
		{ type: "message", id: "first-message", parentId: null, message: { role: "user", content: "before state" } },
		{ type: "custom", customType: "pi-forge-variable-state", id: "state", parentId: "first-message", data: { variables: { "agent.progress": "later" } } },
	];
	const harness = createHarness();
	const context = createContext(cwd, entries, { leafId: "state" });
	await startSession(harness, context.ctx);

	await harness.commands.state.handler("get agent.progress", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /later/);

	context.setLeafId("first-message");
	await harness.events.session_tree({ type: "session_tree", oldLeafId: "state", newLeafId: "first-message" }, context.ctx);
	await harness.commands.state.handler("get agent.progress", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /not set/);
});
