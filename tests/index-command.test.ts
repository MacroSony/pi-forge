import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { legacyPromptStacksDir, promptStacksDir } from "../src/loader.ts";
import {
	bindAvailablePort,
	createContext,
	createHarness,
	getFreePort,
	latestEditorUrl,
	startSession,
	writeForgeConfig,
	writeForgeExtension,
	writeGlobalForgeExtension,
	writeLegacyStack,
	writePreset,
	writeStack,
} from "./helpers/index-command-harness.ts";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pi-forge-home-"));
process.env.HOME = TEST_HOME;

test("extension composition registers the foreground subagent tool and commands", () => {
	const harness = createHarness();
	assert.equal(harness.tools.forge_subagent?.name, "forge_subagent");
	assert.equal(harness.tools.forge_subagent_profiles?.name, "forge_subagent_profiles");
	assert.ok(harness.commands["forge-agent"]);
});

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

test("active stack tool policy filters and restores active tools", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		tools: {
			allow: ["read", "bash"],
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx, statuses } = createContext(cwd);
	await startSession(harness, ctx);

	assert.deepEqual(harness.getActiveTools(), ["read", "bash"]);
	assert.equal(statuses["pi-forge-tools"], "tools:2");

	await harness.commands.preset.handler("use none", ctx);

	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
	assert.equal(statuses["pi-forge-tools"], undefined);
});

test("session_shutdown restores tool policy baseline before reload", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		tools: {
			allow: ["read"],
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const baselineTools = [
		"read",
		"bash",
		"edit",
		"write",
		"paint_list_workflows",
		"paint_get_details",
		"paint_validate_workflow",
	];
	const harness = createHarness({ activeTools: baselineTools });
	const { ctx } = createContext(cwd);
	await startSession(harness, ctx);

	assert.deepEqual(harness.getActiveTools(), ["read"]);

	await harness.events.session_shutdown({ type: "session_shutdown", reason: "reload" }, ctx);

	assert.deepEqual(harness.getActiveTools(), baselineTools);

	await harness.events.session_start({ type: "session_start", reason: "reload" }, ctx);
	assert.deepEqual(harness.getActiveTools(), baselineTools);

	await harness.events.resources_discover({ type: "resources_discover", cwd, reason: "reload" }, ctx);
	assert.deepEqual(harness.getActiveTools(), ["read"]);

	await harness.commands.preset.handler("use none", ctx);
	assert.deepEqual(harness.getActiveTools(), baselineTools);
});

test("late extension tool configuration is filtered after reload and preserved as the baseline", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		tools: {
			allow: ["read"],
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const configuredTools = ["read", "bash", "edit", "write", "web_search", "web_image"];
	const registryTools = [...configuredTools, "web_fetch"];
	const harness = createHarness({ activeTools: configuredTools, allTools: registryTools });
	const { ctx } = createContext(cwd);
	await startSession(harness, ctx);

	assert.deepEqual(harness.getActiveTools(), ["read"]);

	await harness.events.session_shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
	assert.deepEqual(harness.getActiveTools(), configuredTools);

	// Pi rebuilds with all extension tools active before session_start. A later
	// extension then applies its config, enabling search/image and disabling fetch.
	harness.setActiveTools(registryTools);
	await harness.events.session_start({ type: "session_start", reason: "reload" }, ctx);
	assert.deepEqual(harness.getActiveTools(), registryTools);

	harness.setActiveTools(configuredTools);
	await harness.events.resources_discover({ type: "resources_discover", cwd, reason: "reload" }, ctx);
	assert.deepEqual(harness.getActiveTools(), ["read"]);

	await harness.commands.preset.handler("use none", ctx);
	assert.deepEqual(harness.getActiveTools(), configuredTools);
});

test("tool policy reasserts before input and blocks disallowed tool calls", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		tools: {
			allow: ["read"],
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const baselineTools = ["read", "bash", "edit", "write", "web_search"];
	const harness = createHarness({ activeTools: baselineTools });
	const { ctx } = createContext(cwd);
	await startSession(harness, ctx);

	const callsAfterStartup = harness.setActiveToolsCalls.length;
	await harness.events.input({ type: "input", text: "hello", source: "interactive" }, ctx);
	assert.equal(harness.setActiveToolsCalls.length, callsAfterStartup);
	await harness.events.turn_start({ type: "turn_start", turnIndex: 0, timestamp: 1 }, ctx);
	assert.equal(harness.setActiveToolsCalls.length, callsAfterStartup);

	harness.registerTool({ name: "late_extension_tool" });
	harness.setActiveTools(["read", "web_search", "late_extension_tool"]);
	const blocked = await harness.events.tool_call({
		type: "tool_call",
		toolName: "web_search",
		toolCallId: "call-web",
		input: {},
	}, ctx);
	assert.deepEqual(blocked, {
		block: true,
		reason: 'Tool "web_search" is blocked by prompt stack "default".',
	});
	assert.equal(await harness.events.tool_call({
		type: "tool_call",
		toolName: "read",
		toolCallId: "call-read",
		input: {},
	}, ctx), undefined);

	await harness.events.input({ type: "input", text: "hello", source: "interactive" }, ctx);
	assert.deepEqual(harness.getActiveTools(), ["read"]);

	await harness.commands.preset.handler("use none", ctx);
	assert.deepEqual(harness.getActiveTools(), [...baselineTools, "late_extension_tool"]);
	assert.equal(await harness.events.tool_call({
		type: "tool_call",
		toolName: "web_search",
		toolCallId: "call-web-unrestricted",
		input: {},
	}, ctx), undefined);
});

test("trusted pi-forge extension modules register custom macros and slots before validation", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeForgeExtension(cwd, "system-status.ts", `
export default function register(api: any) {
  api.registerMacro({ name: "forgeCustomMacro", render: () => "macro-v1" });
  api.registerSlot({ name: "forge-custom-slot", render: () => "slot-v1" });
}
`);
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [
			{ kind: "block", id: "macro", enabled: true, role: "system", content: "Macro {{forgeCustomMacro}}" },
			{ kind: "slot", id: "slot", enabled: true, role: "system", slot: "forge-custom-slot" },
			{ kind: "slot", id: "history", enabled: true, role: "user", slot: "chat-history" },
		],
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	await harness.commands.preset.handler("validate", context.ctx);
	assert.doesNotMatch(context.editors.at(-1)?.text ?? "", /Unsupported slot: forge-custom-slot/);

	const first = await harness.events.before_agent_start({
		type: "before_agent_start",
		systemPromptOptions: context.ctx.getSystemPromptOptions(),
		systemPrompt: "base system",
		prompt: "hello",
	}, context.ctx);
	assert.equal(first.systemPrompt, "Macro macro-v1\n\nslot-v1");

	writeForgeExtension(cwd, "system-status.ts", `
export default function register(api: any) {
  api.registerMacro({ name: "forgeCustomMacro", render: () => "macro-v2" });
  api.registerSlot({ name: "forge-custom-slot", render: () => "slot-v2" });
}
`);
	await harness.commands.preset.handler("reload", context.ctx);

	const second = await harness.events.before_agent_start({
		type: "before_agent_start",
		systemPromptOptions: context.ctx.getSystemPromptOptions(),
		systemPrompt: "base system",
		prompt: "hello",
	}, context.ctx);
	assert.equal(second.systemPrompt, "Macro macro-v2\n\nslot-v2");

	await harness.events.session_shutdown({ type: "session_shutdown", reason: "reload" }, context.ctx);
	writeForgeExtension(cwd, "system-status.ts", `
export default function register(api: any) {
  api.registerMacro({ name: "forgeCustomMacro", render: () => "macro-v3" });
  api.registerSlot({ name: "forge-custom-slot", render: () => "slot-v3" });
}
`);
	const replacementHarness = createHarness();
	const replacementContext = createContext(cwd);
	await startSession(replacementHarness, replacementContext.ctx);
	const third = await replacementHarness.events.before_agent_start({
		type: "before_agent_start",
		systemPromptOptions: replacementContext.ctx.getSystemPromptOptions(),
		systemPrompt: "base system",
		prompt: "hello",
	}, replacementContext.ctx);
	assert.equal(third.systemPrompt, "Macro macro-v3\n\nslot-v3");
	assert.doesNotMatch(replacementContext.notifications.map((notification) => notification.message).join("\n"), /already registered/);

	const untrusted = createContext(cwd, [], { trusted: false });
	await startSession(replacementHarness, untrusted.ctx);
});

test("global and project pi-forge extension modules load before validation", async () => {
	rmSync(join(TEST_HOME, ".pi", "forge"), { recursive: true, force: true });
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const globalPath = writeGlobalForgeExtension("global-status.ts", `
export default function register(api: any) {
  api.registerMacro({ name: "globalForgeMacro", render: () => "global-macro" });
  api.registerSlot({ name: "global-forge-slot", render: () => "global-slot" });
}
`);
	const projectPath = writeForgeExtension(cwd, "project-status.ts", `
export default function register(api: any) {
  api.registerMacro({ name: "projectForgeMacro", render: () => "project-macro" });
  api.registerSlot({ name: "project-forge-slot", render: () => "project-slot" });
}
`);
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [
			{ kind: "block", id: "global-macro", enabled: true, role: "system", content: "Global {{globalForgeMacro}}" },
			{ kind: "slot", id: "global-slot", enabled: true, role: "system", slot: "global-forge-slot" },
			{ kind: "block", id: "project-macro", enabled: true, role: "system", content: "Project {{projectForgeMacro}}" },
			{ kind: "slot", id: "project-slot", enabled: true, role: "system", slot: "project-forge-slot" },
			{ kind: "slot", id: "history", enabled: true, role: "user", slot: "chat-history" },
		],
	});

	const harness = createHarness();
	const context = createContext(cwd);
	try {
		await startSession(harness, context.ctx);

		await harness.commands.preset.handler("validate", context.ctx);
		const validation = context.editors.at(-1)?.text ?? "";
		assert.doesNotMatch(validation, /Unsupported slot: (global-forge-slot|project-forge-slot)/);

		const result = await harness.events.before_agent_start({
			type: "before_agent_start",
			systemPromptOptions: context.ctx.getSystemPromptOptions(),
			systemPrompt: "base system",
			prompt: "hello",
		}, context.ctx);
		assert.equal(result.systemPrompt, "Global global-macro\n\nglobal-slot\n\nProject project-macro\n\nproject-slot");

		await harness.commands.preset.handler("diagnostics", context.ctx);
		const diagnostics = context.editors.at(-1)?.text ?? "";
		assert.match(diagnostics, new RegExp(escapeRegExp(globalPath)));
		assert.match(diagnostics, new RegExp(escapeRegExp(projectPath)));
	} finally {
		const untrusted = createContext(cwd, [], { trusted: false });
		await startSession(harness, untrusted.ctx);
		rmSync(join(TEST_HOME, ".pi", "forge"), { recursive: true, force: true });
	}
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
		items: [
			{ kind: "slot", id: "vars", enabled: true, role: "user", slot: "variables" },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { "user.preference": "brief", bad: Number.NaN } } },
		{ type: "custom", customType: "pi-forge-prompt-stack-state", data: { activeStackId: "other" } },
	];
	const harness = createHarness();
	const { ctx, statuses, editors } = createContext(cwd, entries);
	await startSession(harness, ctx);

	assert.equal(statuses["pi-forge"], "stack:other");
	await harness.commands.preset.handler("preview", ctx);
	assert.match(editors.at(-1)?.text ?? "", /name="user\.preference">brief/);
	assert.doesNotMatch(editors.at(-1)?.text ?? "", /bad/);
	assert.match(editors.at(-1)?.text ?? "", /name="staticName">static/);
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

test("message_end applies destructive finalize regex to assistant messages", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		regex: {
			rules: [{
				id: "final-ooc",
				stage: "compiled",
				effect: "finalize",
				targets: ["messages"],
				roles: ["assistant"],
				pattern: "\\s*\\(OOC:[^)]+\\)",
				flags: "g",
				replace: "",
			}],
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx, statuses } = createContext(cwd);
	await startSession(harness, ctx);
	const assistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Plan (OOC: hidden)" }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};

	const result = await harness.events.message_end({ type: "message_end", message: assistantMessage }, ctx);
	const userResult = await harness.events.message_end({ type: "message_end", message: { role: "user", content: "Plan (OOC: keep)", timestamp: 2 } }, ctx);

	assert.equal(result.message.content[0].text, "Plan");
	assert.equal(result.message.role, "assistant");
	assert.equal(result.message.model, "test-model");
	assert.equal(result.message.usage, assistantMessage.usage);
	assert.equal(statuses["pi-forge-diagnostics"], "forge:0e/1w");
	assert.equal(userResult, undefined);
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
			max_tokens: 4096,
			input_tokens: 12,
			messages: [{ content: "hello" }],
			image: "data:image/png;base64," + "a".repeat(100),
		},
	}, ctx);

	const saved = readFileSync(join(cwd, ".pi", "forge", "payloads", "last.json"), "utf8");
	assert.match(saved, /"Authorization": "\[redacted\]"/);
	assert.match(saved, /"max_tokens": 4096/);
	assert.match(saved, /"input_tokens": 12/);
	assert.match(saved, /"image": "\[image data omitted\]"/);
	assert.match(saved, /"content": "hello"/);
	assert.equal(statuses["pi-forge-intercept"], undefined);
	assert.match(notifications.at(-1)?.message ?? "", /saved to/);
	assert.match(editors.at(-1)?.title ?? "", /pi-forge: provider payload \(\d+ chars, ~\d+ tokens\)/);
});

test("web editor resources and preview survive lifecycle-only host refreshes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	harness.tools.read = { name: "read", description: "Read files.", promptSnippet: "Read files." };
	const context = createContext(cwd);
	context.ctx.getSystemPromptOptions = () => ({
		cwd,
		selectedTools: ["read"],
		toolSnippets: { read: "Read files." },
		promptGuidelines: [],
		contextFiles: [],
		skills: [{ name: "review", description: "Review code.", filePath: "/skills/review/SKILL.md" }],
	});
	await startSession(harness, context.ctx);

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		const editorUrl = latestEditorUrl(context.editors);
		const token = editorUrl.searchParams.get("token")!;
		const headers = { "content-type": "application/json", "x-pi-forge-token": token };
		const lifecycleCtx = lifecycleOnlyContext(context.ctx);
		const refreshes: Array<[string, Record<string, unknown>]> = [
			["session_tree", { type: "session_tree" }],
			["session_compact", { type: "session_compact" }],
			["session_start", { type: "session_start", reason: "reload" }],
		];

		for (const [eventName, event] of refreshes) {
			await harness.events[eventName](event, lifecycleCtx);
			const resourcesResponse = await fetch(new URL("/api/resources", editorUrl), { headers });
			assert.equal(resourcesResponse.status, 200, eventName);
			const resources = await resourcesResponse.json() as { tools: Array<{ name: string }>; skills: Array<{ name: string }> };
			assert.ok(resources.tools.some((tool) => tool.name === "read"), eventName);
			assert.ok(resources.skills.some((skill) => skill.name === "review"), eventName);

			const stackResponse = await fetch(new URL("/api/stacks/default", editorUrl), { headers });
			assert.equal(stackResponse.status, 200, eventName);
			const loaded = await stackResponse.json() as { stack: unknown };
			const previewResponse = await fetch(new URL("/api/stacks/default/preview", editorUrl), {
				method: "POST",
				headers,
				body: JSON.stringify({ stack: loaded.stack }),
			});
			assert.equal(previewResponse.status, 200, eventName);
		}
	} finally {
		await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

test("/preset ui serves and saves through the local stack editor API", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		name: "Original",
		variables: { char: "Konata" },
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	harness.tools.read = {
		name: "read",
		description: "Read files.",
		promptSnippet: "Read files.",
		promptGuidelines: ["Use read before editing files."],
	};
	harness.tools.bash = {
		name: "bash",
		description: "Run shell commands.",
		promptSnippet: "Run shell commands.",
		promptGuidelines: ["Use bash deliberately."],
	};
	const { ctx, editors, statuses } = createContext(cwd);
	ctx.getSystemPromptOptions = () => ({
		cwd,
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read files.", bash: "Run shell commands." },
		promptGuidelines: ["Use read before editing files.", "Use bash deliberately."],
		contextFiles: [],
		skills: [
			{ name: "review", description: "Review code.", filePath: "/skills/review/SKILL.md" },
			{ name: "browser-danger", description: "Dangerous browser.", filePath: "/skills/browser-danger/SKILL.md", disableModelInvocation: true },
		],
	});
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
		for (const id of [
			"sidebarToggleBtn", "status", "dirtyBadge", "themeBtn", "reloadBtn", "disableBtn",
			"shell", "stackList", "newStackBtn", "activateBtn", "saveBtn", "validateBtn",
			"previewBtn", "payloadBtn", "forkBtn", "importBtn", "exportBtn", "deleteStackBtn",
			"metadataToggleBtn", "itemsTabBtn", "regexTabBtn", "policyTabBtn", "stackTabBtn",
			"addItemBtn", "addSlotBtn", "deleteItemBtn", "preview", "stackModal",
		]) {
			assert.match(pageHtml, new RegExp(`id="${id}"`), `expected static editor element #${id}`);
		}
		assert.match(pageHtml, /Ctrl\/Cmd\+S/);
		const deleteItemIndex = pageHtml.indexOf('id="deleteItemBtn"');
		assert.ok(deleteItemIndex > pageHtml.indexOf('<div class="item-tools">'));
		assert.ok(deleteItemIndex < pageHtml.indexOf('<div id="itemList"'));
		const previewIndex = pageHtml.indexOf('id="preview"');
		const stackModalIndex = pageHtml.indexOf('id="stackModal"');
		assert.ok(previewIndex > pageHtml.indexOf("</main>"));
		assert.ok(previewIndex < stackModalIndex);
		assert.doesNotMatch(pageHtml, /<script[^>]+src=/);
		const scripts = [...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
		assert.equal(scripts.length, 1);
		assert.ok(scripts[0]?.[1]);
		assert.doesNotThrow(() => new Function(scripts[0]![1]));

		const rejected = await fetch(apiUrl);
		assert.equal(rejected.status, 403);

		const listResponse = await fetch(apiUrl, { headers: { "x-pi-forge-token": token } });
		assert.equal(listResponse.status, 200);
		const list = await listResponse.json() as { stacks: Array<{ id: string; active: boolean }> };
		assert.deepEqual(list.stacks.map((stack) => stack.id), ["default"]);
		assert.equal(list.stacks[0]?.active, true);

		const resourcesResponse = await fetch(new URL("/api/resources", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(resourcesResponse.status, 200);
		const resources = await resourcesResponse.json() as {
			tools: Array<{ name: string; active?: boolean; description?: string }>;
			skills: Array<{ name: string; hidden?: boolean; description?: string }>;
		};
		assert.ok(resources.tools.some((tool) => tool.name === "read" && tool.active && /Read files/.test(tool.description ?? "")));
		assert.ok(resources.skills.some((skill) => skill.name === "review" && /Review code/.test(skill.description ?? "")));
		assert.ok(resources.skills.some((skill) => skill.name === "browser-danger" && skill.hidden));

		const stackResponse = await fetch(new URL("/api/stacks/default", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(stackResponse.status, 200);
		const loaded = await stackResponse.json() as { stack: any };
		const renameAttempt = structuredClone(loaded.stack);
		renameAttempt.id = "renamed";
		const renameResponse = await fetch(new URL("/api/stacks/default", editorUrl), {
			method: "PUT",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ stack: renameAttempt }),
		});
		assert.equal(renameResponse.status, 400);
		assert.match(await renameResponse.text(), /immutable during save/);
		const afterRenameResponse = await fetch(apiUrl, { headers: { "x-pi-forge-token": token } });
		const afterRename = await afterRenameResponse.json() as { stacks: Array<{ id: string; active: boolean }> };
		assert.deepEqual(afterRename.stacks.map((stack) => stack.id), ["default"]);
		assert.equal(afterRename.stacks[0]?.active, true);
		assert.match(readFileSync(join(promptStacksDir(cwd), "default.json"), "utf8"), /"id": "default"/);
		loaded.stack.name = "Edited in UI";
		loaded.stack.regex = {
			schemaVersion: 1,
			rules: [{
				id: "final-ui-ooc",
				stage: "compiled",
				effect: "finalize",
				targets: ["messages"],
				roles: ["assistant"],
				pattern: "\\s*\\(OOC:[^)]+\\)",
				flags: "gi",
				replace: "",
			}],
		};
		loaded.stack.tools = { allow: ["read", "bash"] };
		loaded.stack.skills = { deny: ["browser-danger"] };
		const longPreviewContent = "After history " + "x".repeat(9000);
		loaded.stack.items.push({ kind: "block", id: "after", enabled: true, role: "user", content: longPreviewContent });

		const regexValidateResponse = await fetch(new URL("/api/stacks/default/validate", editorUrl), {
			method: "POST",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ stack: loaded.stack }),
		});
		assert.equal(regexValidateResponse.status, 200);
		const regexValidateResult = await regexValidateResponse.json() as { diagnostics: Array<{ level: string; message: string }> };
		assert.ok(regexValidateResult.diagnostics.some((diagnostic) => diagnostic.level === "warning" && /effect "finalize"/.test(diagnostic.message)));

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
		assert.match(saved, /final-ui-ooc/);
		assert.match(saved, /"tools"/);
		assert.match(saved, /"skills"/);
		assert.match(saved, /"browser-danger"/);

		const previewStack = structuredClone(loaded.stack);
		previewStack.mode = "append";
		previewStack.tools = { allow: ["read"] };
		previewStack.items.unshift(
			{ kind: "slot", id: "preview-tools", enabled: true, role: "system", slot: "tools", options: { format: "plain", onlyWithSnippets: true } },
			{ kind: "slot", id: "preview-guidelines", enabled: true, role: "system", slot: "tool-guidelines", options: { format: "plain" } },
		);
		const previewResponse = await fetch(new URL("/api/stacks/default/preview", editorUrl), {
			method: "POST",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ stack: previewStack }),
		});
		assert.equal(previewResponse.status, 200);
		const previewResult = await previewResponse.json() as {
			text: string;
			preview?: { system: { title: string; content: string }; messages: Array<{ title: string; role: string; content: string; chars: number }> };
		};
		assert.ok(previewResult.preview);
		assert.equal(previewResult.preview?.system.title, "System prompt");
		assert.match(previewResult.preview?.system.content ?? "", /base system/);
		assert.match(previewResult.preview?.system.content ?? "", /Available tools:\n- read: Read files\./);
		assert.match(previewResult.preview?.system.content ?? "", /Use read before editing files\./);
		assert.doesNotMatch(previewResult.preview?.system.content ?? "", /Use bash deliberately\./);
		const longMessage = previewResult.preview?.messages.find((message) => message.content.includes("After history"));
		assert.ok(longMessage);
		assert.equal(longMessage?.title, "after");
		assert.equal(longMessage?.content.length, longPreviewContent.length);
		assert.ok((longMessage?.chars ?? 0) > 9000);
		assert.match(previewResult.text, /--- after \(user\) ---/);
		assert.match(previewResult.text, /preview truncated/);

		const stateResponse = await fetch(new URL("/api/state", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(stateResponse.status, 404);

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

function lifecycleOnlyContext(ctx: Record<string, unknown>): Record<string, unknown> {
	const lifecycle = { ...ctx };
	for (const key of ["getSystemPromptOptions", "waitForIdle", "newSession", "fork"]) delete lifecycle[key];
	return lifecycle;
}

test("/preset ui can create the first stack in an empty project", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const harness = createHarness();
	const { ctx, editors, statuses } = createContext(cwd);
	await startSession(harness, ctx);

	try {
		await harness.commands.preset.handler("ui", ctx);
		const editorUrl = latestEditorUrl(editors);
		const token = editorUrl.searchParams.get("token")!;
		const headers = { "content-type": "application/json", "x-pi-forge-token": token };

		const emptyListResponse = await fetch(new URL("/api/stacks", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(emptyListResponse.status, 200);
		const emptyList = await emptyListResponse.json() as { stacks: Array<{ id: string }> };
		assert.deepEqual(emptyList.stacks, []);

		const stack = {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "first",
			name: "First Stack",
			mode: "replace",
			items: [
				{ kind: "block", id: "system", enabled: true, role: "system", content: "First system prompt." },
				{ kind: "slot", id: "chat-history", enabled: true, slot: "chat-history" },
			],
		};
		const createResponse = await fetch(new URL("/api/stacks", editorUrl), {
			method: "POST",
			headers,
			body: JSON.stringify({ stack, activate: true }),
		});
		assert.equal(createResponse.status, 200);
		const createResult = await createResponse.json() as { stack: { id: string; active: boolean }; stacks: Array<{ id: string; active: boolean }> };
		assert.equal(createResult.stack.id, "first");
		assert.equal(createResult.stack.active, true);
		assert.deepEqual(createResult.stacks.map((item) => item.id), ["first"]);
		assert.match(readFileSync(join(promptStacksDir(cwd), "first.json"), "utf8"), /First system prompt/);
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

test("/preset ui reuses an existing server after extension reinitialization", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const firstHarness = createHarness();
	const firstContext = createContext(cwd);
	await startSession(firstHarness, firstContext.ctx);

	const secondHarness = createHarness();
	const secondContext = createContext(cwd);

	try {
		await firstHarness.commands.preset.handler("ui", firstContext.ctx);
		const editorUrl = latestEditorUrl(firstContext.editors);
		const token = editorUrl.searchParams.get("token")!;

		await startSession(secondHarness, secondContext.ctx);
		assert.equal(secondContext.statuses["pi-forge-editor"], `editor:${editorUrl.port}`);

		const stacksResponse = await fetch(new URL("/api/stacks", editorUrl), { headers: { "x-pi-forge-token": token } });
		assert.equal(stacksResponse.status, 200);
		const stacks = await stacksResponse.json() as { stacks: Array<{ id: string }> };
		assert.deepEqual(stacks.stacks.map((stack) => stack.id), ["default"]);

		await secondHarness.commands.preset.handler("ui", secondContext.ctx);
		assert.equal(latestEditorUrl(secondContext.editors).href, editorUrl.href);
	} finally {
		await secondHarness.commands.preset.handler("ui stop", secondContext.ctx);
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

test("session_tree restores macro session variables from the current branch only", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [
			{ kind: "slot", id: "vars", enabled: true, role: "user", slot: "variables", options: { includeStatic: false, includeTurn: false } },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", id: "early-state", parentId: null, data: { variables: { progress: "early" } } },
		{ type: "message", id: "early-message", parentId: "early-state", message: { role: "user", content: "earlier" } },
		{ type: "custom", customType: "pi-forge-variable-state", id: "later-state", parentId: "early-message", data: { variables: { progress: "later" } } },
		{ type: "message", id: "later-message", parentId: "later-state", message: { role: "assistant", content: [{ type: "text", text: "later" }] } },
	];
	const harness = createHarness();
	const context = createContext(cwd, entries, { leafId: "later-message" });
	await startSession(harness, context.ctx);

	await harness.commands.preset.handler("preview", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /name="progress">later/);

	context.setLeafId("early-message");
	await harness.events.session_tree({ type: "session_tree", oldLeafId: "later-message", newLeafId: "early-message" }, context.ctx);
	await harness.commands.preset.handler("preview", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /name="progress">early/);
	assert.doesNotMatch(context.editors.at(-1)?.text ?? "", /name="progress">later/);
});

test("session_tree before any variable entry clears restored macro variables", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [
			{ kind: "slot", id: "vars", enabled: true, role: "user", slot: "variables", options: { includeStatic: false, includeTurn: false } },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	});
	const entries = [
		{ type: "message", id: "first-message", parentId: null, message: { role: "user", content: "before variables" } },
		{ type: "custom", customType: "pi-forge-variable-state", id: "vars", parentId: "first-message", data: { variables: { progress: "later" } } },
	];
	const harness = createHarness();
	const context = createContext(cwd, entries, { leafId: "vars" });
	await startSession(harness, context.ctx);

	await harness.commands.preset.handler("preview", context.ctx);
	assert.match(context.editors.at(-1)?.text ?? "", /name="progress">later/);

	context.setLeafId("first-message");
	await harness.events.session_tree({ type: "session_tree", oldLeafId: "vars", newLeafId: "first-message" }, context.ctx);
	await harness.commands.preset.handler("preview", context.ctx);
	assert.doesNotMatch(context.editors.at(-1)?.text ?? "", /name="progress">later/);
});

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
