import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piForge from "../src/index.ts";
import { legacyPromptStacksDir, promptStacksDir } from "../src/loader.ts";

function writeStack(cwd: string, name: string, value: unknown): void {
	mkdirSync(promptStacksDir(cwd), { recursive: true });
	writeFileSync(join(promptStacksDir(cwd), name), JSON.stringify(value, null, 2));
}

function writeLegacyStack(cwd: string, name: string, value: unknown): void {
	mkdirSync(legacyPromptStacksDir(cwd), { recursive: true });
	writeFileSync(join(legacyPromptStacksDir(cwd), name), JSON.stringify(value, null, 2));
}

function writePreset(cwd: string, name: string, value: unknown): string {
	const dir = join(cwd, "st");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(value, null, 2));
	return path;
}

async function getFreePort(): Promise<number> {
	const blocker = await bindAvailablePort();
	await blocker.close();
	return blocker.port;
}

async function bindAvailablePort(): Promise<{ port: number; close(): Promise<void> }> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return {
		port: address.port,
		close: () => closeNetServer(server),
	};
}

function closeNetServer(server: NetServer): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function writeForgeConfig(cwd: string, value: unknown): void {
	const dir = join(cwd, ".pi", "forge");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify(value, null, 2));
}

function latestEditorUrl(editors: { title: string; text: string }[]): URL {
	const editorText = editors.at(-1)?.text ?? "";
	const urlMatch = editorText.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
	assert.ok(urlMatch);
	return new URL(urlMatch[0]);
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

test("/preset ui serves and saves through the local stack editor API", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		name: "Original",
		variables: { char: "Konata" },
		state: {
			schemaVersion: 1,
			definitions: {
				"user.preference": { type: "string", scope: "session", userWritable: true },
				"user.locked": { type: "string", scope: "session", userWritable: false },
			},
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx, editors, statuses } = createContext(cwd);
	await startSession(harness, ctx);

	try {
		await harness.commands.preset.handler("ui", ctx);
		assert.match(statuses["pi-forge-editor"] ?? "", /editor:\d+/);
		const editorText = editors.at(-1)?.text ?? "";
		const urlMatch = editorText.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
		assert.ok(urlMatch);
		const editorUrl = new URL(urlMatch[0]);
		assert.ok(Number(editorUrl.port) > 0);
		const token = editorUrl.searchParams.get("token")!;
		const apiUrl = new URL("/api/stacks", editorUrl);

		await harness.commands.preset.handler("ui", ctx);
		const reusedText = editors.at(-1)?.text ?? "";
		const reusedMatch = reusedText.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
		assert.ok(reusedMatch);
		assert.equal(reusedMatch[0], editorUrl.href);

		const pageResponse = await fetch(editorUrl);
		assert.equal(pageResponse.status, 200);
		const pageHtml = await pageResponse.text();
		assert.match(pageHtml, /sidebarToggleBtn/);
		assert.match(pageHtml, /slotOptionsFormBtn/);
		assert.match(pageHtml, /forkBtn/);
		assert.match(pageHtml, /importBtn/);
		assert.match(pageHtml, /exportBtn/);
		assert.match(pageHtml, /deleteStackBtn/);
		const deleteItemIndex = pageHtml.indexOf('id="deleteItemBtn"');
		assert.ok(deleteItemIndex > pageHtml.indexOf('<div class="item-tools">'));
		assert.ok(deleteItemIndex < pageHtml.indexOf('<div id="itemList"'));
		assert.match(pageHtml, /variablesBtn/);
		assert.match(pageHtml, /stateSchemaBtn/);
		assert.match(pageHtml, /sessionStateBtn/);
		assert.match(pageHtml, /payloadBtn/);
		assert.match(pageHtml, /themeBtn/);
		assert.match(pageHtml, /contextBtn/);
		assert.match(pageHtml, /stackJsonBtn/);
		assert.match(pageHtml, /dirtyBadge/);
		assert.match(pageHtml, /copyImportReportBtn/);
		assert.match(pageHtml, /data-icon/);
		assert.match(pageHtml, /validateRawStackJson/);
		assert.match(pageHtml, /\["xml", "json", "plain"\]/);
		assert.match(pageHtml, /\["xml", "plain"\]/);
		const scriptMatch = pageHtml.match(/<script>([\s\S]*)<\/script>/);
		assert.ok(scriptMatch?.[1]);
		assert.doesNotThrow(() => new Function(scriptMatch[1]!));

		const rejected = await fetch(apiUrl);
		assert.equal(rejected.status, 403);

		const listResponse = await fetch(apiUrl, { headers: { "x-pi-forge-token": token } });
		assert.equal(listResponse.status, 200);
		const list = await listResponse.json() as { stacks: Array<{ id: string; active: boolean }> };
		assert.deepEqual(list.stacks.map((stack) => stack.id), ["default"]);
		assert.equal(list.stacks[0]?.active, true);

		const stackResponse = await fetch(new URL("/api/stacks/default", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(stackResponse.status, 200);
		const loaded = await stackResponse.json() as { stack: any };
		loaded.stack.name = "Edited in UI";
		const longPreviewContent = "After history " + "x".repeat(9000);
		loaded.stack.items.push({ kind: "block", id: "after", enabled: true, role: "user", content: longPreviewContent });

		const saveResponse = await fetch(new URL("/api/stacks/default", editorUrl), {
			method: "PUT",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ stack: loaded.stack }),
		});
		assert.equal(saveResponse.status, 200);
		const saveResult = await saveResponse.json() as { stack: { id: string; itemCount: number }; stacks: unknown[] };
		assert.equal(saveResult.stack.id, "default");
		assert.equal(saveResult.stack.itemCount, 2);

		const saved = readFileSync(join(promptStacksDir(cwd), "default.json"), "utf8");
		assert.match(saved, /Edited in UI/);
		assert.match(saved, /After history/);

		const previewResponse = await fetch(new URL("/api/stacks/default/preview", editorUrl), {
			method: "POST",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ stack: loaded.stack }),
		});
		assert.equal(previewResponse.status, 200);
		const previewResult = await previewResponse.json() as {
			text: string;
			preview?: { system: { content: string }; messages: Array<{ role: string; content: string; chars: number }> };
		};
		assert.ok(previewResult.preview);
		assert.match(previewResult.preview?.system.content ?? "", /base system/);
		const longMessage = previewResult.preview?.messages.find((message) => message.content.includes("After history"));
		assert.ok(longMessage);
		assert.equal(longMessage?.content.length, longPreviewContent.length);
		assert.ok((longMessage?.chars ?? 0) > 9000);
		assert.match(previewResult.text, /preview truncated/);

		const stateResponse = await fetch(new URL("/api/state", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(stateResponse.status, 200);
		const stateSnapshot = await stateResponse.json() as {
			activeStackId?: string;
			session: Record<string, unknown>;
			definitions: Record<string, { type?: string; userWritable?: boolean }>;
		};
		assert.equal(stateSnapshot.activeStackId, "default");
		assert.deepEqual(stateSnapshot.session, {});
		assert.equal(stateSnapshot.definitions["user.preference"]?.type, "string");

		const stateSetResponse = await fetch(new URL("/api/state/user.preference", editorUrl), {
			method: "PUT",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ value: "brief" }),
		});
		assert.equal(stateSetResponse.status, 200);
		const stateSet = await stateSetResponse.json() as { session: Record<string, unknown> };
		assert.equal(stateSet.session["user.preference"], "brief");
		assert.equal(harness.appended.at(-1)?.type, "pi-forge-variable-state");
		assert.deepEqual((harness.appended.at(-1)?.data as { variables: unknown }).variables, { "user.preference": "brief" });

		const stateBlockedResponse = await fetch(new URL("/api/state/user.locked", editorUrl), {
			method: "PUT",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ value: "blocked" }),
		});
		assert.equal(stateBlockedResponse.status, 400);

		const stateClearResponse = await fetch(new URL("/api/state/user.preference", editorUrl), {
			method: "DELETE",
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(stateClearResponse.status, 200);
		const stateClear = await stateClearResponse.json() as { session: Record<string, unknown> };
		assert.deepEqual(stateClear.session, {});

		const payloadIdleResponse = await fetch(new URL("/api/payload", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(payloadIdleResponse.status, 200);
		const payloadIdle = await payloadIdleResponse.json() as { status: string };
		assert.equal(payloadIdle.status, "idle");

		const payloadArmResponse = await fetch(new URL("/api/payload/arm", editorUrl), {
			method: "POST",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({}),
		});
		assert.equal(payloadArmResponse.status, 200);
		const payloadArmed = await payloadArmResponse.json() as { status: string; armedAt?: string };
		assert.equal(payloadArmed.status, "armed");
		assert.ok(payloadArmed.armedAt);
		assert.equal(statuses["pi-forge-intercept"], "payload:armed");

		const editorCountBeforePayload = editors.length;
		await harness.events.before_provider_request({
			type: "before_provider_request",
			payload: {
				Authorization: "Bearer web-secret",
				model: "test-model",
				messages: [{ role: "user", content: "web capture" }],
			},
		}, ctx);
		assert.equal(editors.length, editorCountBeforePayload);

		const payloadCapturedResponse = await fetch(new URL("/api/payload", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(payloadCapturedResponse.status, 200);
		const payloadCaptured = await payloadCapturedResponse.json() as {
			status: string;
			capture?: { stackId?: string; text: string; payload?: Record<string, unknown>; chars: number; approxTokens: number };
		};
		assert.equal(payloadCaptured.status, "captured");
		assert.equal(payloadCaptured.capture?.stackId, "default");
		assert.match(payloadCaptured.capture?.text ?? "", /"Authorization": "\[redacted\]"/);
		assert.equal((payloadCaptured.capture?.payload as { Authorization?: string } | undefined)?.Authorization, "[redacted]");
		assert.ok((payloadCaptured.capture?.chars ?? 0) > 0);
		assert.ok((payloadCaptured.capture?.approxTokens ?? 0) > 0);
		assert.equal(statuses["pi-forge-intercept"], undefined);

		const payloadClearResponse = await fetch(new URL("/api/payload", editorUrl), {
			method: "DELETE",
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(payloadClearResponse.status, 200);
		const payloadCleared = await payloadClearResponse.json() as { status: string };
		assert.equal(payloadCleared.status, "idle");

		const fork = { ...loaded.stack, id: "forked", name: "Forked Stack", autoActivate: false };
		const createResponse = await fetch(apiUrl, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ stack: fork, activate: true }),
		});
		assert.equal(createResponse.status, 200);
		const createResult = await createResponse.json() as { stack: { id: string; active: boolean }; stacks: Array<{ id: string; active: boolean }> };
		assert.equal(createResult.stack.id, "forked");
		assert.equal(createResult.stack.active, true);
		assert.ok(createResult.stacks.some((stack) => stack.id === "forked" && stack.active));
		assert.match(readFileSync(join(promptStacksDir(cwd), "forked.json"), "utf8"), /Forked Stack/);

		const collisionResponse = await fetch(apiUrl, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ stack: fork }),
		});
		assert.equal(collisionResponse.status, 409);

		const deleteResponse = await fetch(new URL("/api/stacks/forked", editorUrl), {
			method: "DELETE",
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(deleteResponse.status, 200);
		const deleteResult = await deleteResponse.json() as { activeId?: string; stacks: Array<{ id: string; active: boolean }> };
		assert.equal(deleteResult.activeId, undefined);
		assert.deepEqual(deleteResult.stacks.map((stack) => stack.id), ["default"]);
		assert.equal(existsSync(join(promptStacksDir(cwd), "forked.json")), false);

		const sillyPreset = {
			preset_name: "UI Silly Import",
			prompts: [
				{ identifier: "main", name: "Main", role: "system", content: "You are {{char}}." },
				{ identifier: "chatHistory", name: "Chat History", marker: true },
				{ identifier: "post", name: "Post", role: "user", content: "Latest: {{lastUserMessage}}" },
			],
			prompt_order: [
				{ character_id: 1, order: [{ identifier: "main", enabled: true }] },
				{
					character_id: 2,
					order: [
						{ identifier: "main", enabled: true },
						{ identifier: "chatHistory", enabled: true },
						{ identifier: "post", enabled: true },
					],
				},
			],
		};
		const sillyResponse = await fetch(apiUrl, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ stack: sillyPreset, sourceName: "UI Silly Import.json", characterId: 2 }),
		});
		assert.equal(sillyResponse.status, 200);
		const sillyResult = await sillyResponse.json() as {
			stack: { id: string; itemCount: number };
			importFormat?: string;
			importReport?: string;
			stacks: Array<{ id: string }>;
		};
		assert.equal(sillyResult.stack.id, "ui-silly-import");
		assert.equal(sillyResult.stack.itemCount, 3);
		assert.equal(sillyResult.importFormat, "sillytavern");
		assert.match(sillyResult.importReport ?? "", /Character ID.*2/);
		assert.ok(sillyResult.stacks.some((stack) => stack.id === "ui-silly-import"));
		const sillySaved = readFileSync(join(promptStacksDir(cwd), "ui-silly-import.json"), "utf8");
		assert.match(sillySaved, /"source": "sillytavern"/);
		assert.match(sillySaved, /"includeLastUserMessage": false/);

		const sillyDeleteResponse = await fetch(new URL("/api/stacks/ui-silly-import", editorUrl), {
			method: "DELETE",
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(sillyDeleteResponse.status, 200);
		assert.equal(existsSync(join(promptStacksDir(cwd), "ui-silly-import.json")), false);

		await harness.commands.preset.handler("ui stop", ctx);
		assert.equal(statuses["pi-forge-editor"], undefined);
		await harness.commands.preset.handler("ui", ctx);
		const reopenedText = editors.at(-1)?.text ?? "";
		const reopenedMatch = reopenedText.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/);
		assert.ok(reopenedMatch);
		const reopenedUrl = new URL(reopenedMatch[0]);
		assert.ok(Number(reopenedUrl.port) > 0);
		const reopenedPage = await fetch(reopenedUrl);
		assert.equal(reopenedPage.status, 200);
	} finally {
		await harness.commands.preset.handler("ui stop", ctx);
	}
	assert.equal(statuses["pi-forge-editor"], undefined);
});

test("/preset ui honors preferred port and falls back when it is occupied", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx, editors, notifications } = createContext(cwd);
	await startSession(harness, ctx);
	let blocker: { port: number; close(): Promise<void> } | undefined;

	try {
		const preferredPort = await getFreePort();
		writeForgeConfig(cwd, { webEditor: { port: preferredPort } });
		await harness.commands.preset.handler("ui", ctx);
		assert.equal(latestEditorUrl(editors).port, String(preferredPort));
		await harness.commands.preset.handler("ui stop", ctx);

		blocker = await bindAvailablePort();
		writeForgeConfig(cwd, { webEditor: { port: blocker.port } });
		await harness.commands.preset.handler("ui", ctx);
		const fallbackUrl = latestEditorUrl(editors);
		assert.ok(Number(fallbackUrl.port) > 0);
		assert.notEqual(fallbackUrl.port, String(blocker.port));
		assert.ok(notifications.some((notification) => /preferred editor port/.test(notification.message)));
	} finally {
		await harness.commands.preset.handler("ui stop", ctx);
		if (blocker) await blocker.close();
	}
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

test("/preset migrate-stacks copies legacy stacks with overwrite and delete options", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeLegacyStack(cwd, "legacy.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "legacy",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeLegacyStack(cwd, "collision.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "legacy-collision",
		name: "Legacy Collision",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeStack(cwd, "collision.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "primary-collision",
		name: "Primary Collision",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	await harness.commands.preset.handler("migrate-stacks --dry-run", context.ctx);
	assert.equal(existsSync(join(promptStacksDir(cwd), "legacy.json")), false);
	assert.match(context.editors.at(-1)?.text ?? "", /dry run/);

	await harness.commands.preset.handler("migrate-stacks", context.ctx);
	assert.match(readFileSync(join(promptStacksDir(cwd), "legacy.json"), "utf8"), /"id": "legacy"/);
	assert.match(readFileSync(join(promptStacksDir(cwd), "collision.json"), "utf8"), /Primary Collision/);
	assert.ok(existsSync(join(legacyPromptStacksDir(cwd), "legacy.json")));
	assert.match(context.editors.at(-1)?.text ?? "", /skip: collision\.json/);

	await harness.commands.preset.handler("migrate-stacks --overwrite --delete-legacy", context.ctx);
	assert.match(readFileSync(join(promptStacksDir(cwd), "collision.json"), "utf8"), /Legacy Collision/);
	assert.equal(existsSync(join(legacyPromptStacksDir(cwd), "legacy.json")), false);
	assert.equal(existsSync(join(legacyPromptStacksDir(cwd), "collision.json")), false);
	assert.match(context.editors.at(-1)?.text ?? "", /Deleted legacy files: 2/);

	const untrusted = createContext(cwd, [], { trusted: false });
	await harness.commands.preset.handler("migrate-stacks", untrusted.ctx);
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

test("/preset vars get shows existing and missing values", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { mood: "happy", count: 3 } } },
	];
	const harness = createHarness();
	const { ctx, editors } = createContext(cwd, entries);
	await startSession(harness, ctx);

	await harness.commands.preset.handler("vars get mood", ctx);
	assert.equal(editors.at(-1)?.title, "pi-forge variable: mood");
	assert.match(editors.at(-1)?.text ?? "", /happy/);

	await harness.commands.preset.handler("vars get count", ctx);
	assert.match(editors.at(-1)?.text ?? "", /3/);

	await harness.commands.preset.handler("vars get missing", ctx);
	assert.match(editors.at(-1)?.text ?? "", /\(not set\)/);
});

test("/preset vars clear removes single and all session variables", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { a: "keep", b: "remove", c: "also-keep" } } },
	];
	const harness = createHarness();
	const { ctx, editors, notifications } = createContext(cwd, entries);
	await startSession(harness, ctx);

	await harness.commands.preset.handler("vars clear b", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /cleared session variable b/);
	const afterSingle = (harness.appended.at(-1)?.data as { variables: Record<string, unknown> }).variables;
	assert.deepEqual(Object.keys(afterSingle).sort(), ["a", "c"]);
	assert.equal(afterSingle.a, "keep");
	assert.equal(afterSingle.c, "also-keep");

	await harness.commands.preset.handler("vars clear", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /cleared all session variables/);
	const afterAll = (harness.appended.at(-1)?.data as { variables: Record<string, unknown> }).variables;
	assert.deepEqual(afterAll, {});

	await harness.commands.preset.handler("vars get a", ctx);
	assert.match(editors.at(-1)?.text ?? "", /\(not set\)/);
});

test("/state get shows existing and missing values", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { "agent.progress": "step 5", flags: ["a", "b"] } } },
	];
	const harness = createHarness();
	const { ctx, editors } = createContext(cwd, entries);
	await startSession(harness, ctx);

	await harness.commands.state.handler("get agent.progress", ctx);
	assert.equal(editors.at(-1)?.title, "pi-forge state: agent.progress");
	assert.match(editors.at(-1)?.text ?? "", /step 5/);

	await harness.commands.state.handler("get flags", ctx);
	assert.match(editors.at(-1)?.text ?? "", /"a"/);
	assert.match(editors.at(-1)?.text ?? "", /"b"/);

	await harness.commands.state.handler("get missing", ctx);
	assert.match(editors.at(-1)?.text ?? "", /\(not set\)/);
});

test("/state clear without a name removes all session state", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { x: "1", y: "2", z: "3" } } },
	];
	const harness = createHarness();
	const { ctx, editors, notifications } = createContext(cwd, entries);
	await startSession(harness, ctx);

	await harness.commands.state.handler("clear", ctx);
	assert.match(notifications.at(-1)?.message ?? "", /cleared all session state/);
	const cleared = (harness.appended.at(-1)?.data as { variables: Record<string, unknown> }).variables;
	assert.deepEqual(cleared, {});

	await harness.commands.state.handler("get x", ctx);
	assert.match(editors.at(-1)?.text ?? "", /\(not set\)/);
});
