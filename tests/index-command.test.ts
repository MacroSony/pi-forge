import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GLOBAL_FORGE_CONFIG_PATH_ENV } from "../src/forge-config.ts";
import { legacyPromptStacksDir, promptStacksDir } from "../src/loader.ts";
import { GLOBAL_FORGE_DIR_ENV, globalPromptStacksDir } from "../src/storage.ts";
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
	writeProfile,
	writeStack,
} from "./helpers/index-command-harness.ts";

const TEST_HOME = mkdtempSync(join(tmpdir(), "pi-forge-home-"));
process.env.HOME = TEST_HOME;

test("extension composition no longer registers subagent execution tools or commands", () => {
	// Delegation moved to the optional pi-forge-subagents package behind the
	// versioned /subagent host port; the main extension must not ship them.
	const harness = createHarness();
	assert.equal(harness.tools.forge_subagent, undefined);
	assert.equal(harness.tools.forge_subagent_profiles, undefined);
	assert.equal(harness.commands["forge-agent"], undefined);
});

test("/preset completions preserve second-level subcommand text", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
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

test("/preset use, disable, and reload persist selection and update footer", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
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
	assert.deepEqual(harness.appended.at(-1), { type: "pi-forge-prompt-stack-state", data: { activeStackId: "project:other" } });

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
		autoActivate: true,
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
		autoActivate: true,
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
		autoActivate: true,
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
		autoActivate: true,
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
		autoActivate: true,
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
		autoActivate: true,
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

test("session_start restores active stack and static variables", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
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
			{ kind: "block", id: "vars", enabled: true, role: "user", content: "Static={{staticName}}" },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-prompt-stack-state", data: { activeStackId: "other" } },
	];
	const harness = createHarness();
	const { ctx, statuses, editors } = createContext(cwd, entries);
	await startSession(harness, ctx);

	assert.equal(statuses["pi-forge"], "stack:other");
	await harness.commands.preset.handler("preview", ctx);
	assert.match(editors.at(-1)?.text ?? "", /Static=static/);
});

test("session_start emits one bounded diagnostic for legacy variable-state entries", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const entries = [
		{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { x: "1" } } },
		{ type: "custom", customType: "pi-forge-variable-state", data: { variables: { y: "2" } } },
	];
	const harness = createHarness();
	const context = createContext(cwd, entries);
	await startSession(harness, context.ctx);

	await harness.commands.preset.handler("diagnostics", context.ctx);
	const text = context.editors.at(-1)?.text ?? "";
	const matches = text.match(/Legacy pi-forge-variable-state entries are ignored/g) ?? [];
	assert.equal(matches.length, 1);
	assert.doesNotMatch(text, /pi-forge-variable-state.*restor/i);
});

test("/preset validate shows requested stack diagnostics", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
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
		autoActivate: true,
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
	assert.equal(startResult.systemPrompt, "base");
	assert.equal(statuses["pi-forge-diagnostics"], "forge:1e/1w");

	const firstContext = await harness.events.context({ type: "context", messages: [{ role: "user", content: "latest", timestamp: 1 }] }, ctx);
	assert.equal(firstContext.messages.length, 2);
	assert.equal(firstContext.messages[0].content[0].text, "before");

	const secondContext = await harness.events.context({ type: "context", messages: [{ role: "user", content: "tool follow-up", timestamp: 2 }] }, ctx);
	assert.equal(secondContext, undefined);

	await harness.commands.preset.handler("diagnostics", ctx);
	assert.match(editors.at(-1)?.text ?? "", /Undefined forge-v1 path: \{\{missing\}\}/);
});

test("message_end applies destructive finalize regex to assistant messages", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
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

test("ordinary provider requests populate context-diff history without arming capture", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		const editorUrl = latestEditorUrl(context.editors);
		const token = editorUrl.searchParams.get("token")!;
		const headers = { "x-pi-forge-token": token };

		await harness.events.before_provider_request({
			type: "before_provider_request",
			payload: {
				Authorization: "Bearer normal-secret",
				model: "test-model",
				messages: [{ role: "user", content: "first normal turn" }],
			},
		}, context.ctx);
		await harness.events.before_provider_request({
			type: "before_provider_request",
			payload: {
				Authorization: "Bearer normal-secret",
				model: "test-model",
				messages: [{ role: "user", content: "second normal turn" }],
			},
		}, context.ctx);

		const response = await fetch(new URL("/api/context-diff", editorUrl), { headers });
		assert.equal(response.status, 200);
		const view = await response.json() as {
			turns: Array<{ blockCount: number }>;
			latest?: { turn: { blocks: Array<{ text: string }> } } | null;
		};
		assert.equal(view.turns.length, 2);
		assert.ok(view.turns.every((turn) => turn.blockCount > 0));
		assert.ok(view.latest);
		assert.doesNotMatch(JSON.stringify(view.latest), /normal-secret/);
		assert.match(JSON.stringify(view.latest), /\[redacted\]/);
	} finally {
		await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

test("provider request captures correlate with authoritative assistant usage", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-usage-"));
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		const editorUrl = latestEditorUrl(context.editors);
		const headers = { "x-pi-forge-token": editorUrl.searchParams.get("token")! };
		await harness.events.before_provider_request({
			type: "before_provider_request",
			payload: { model: "test-model", messages: [{ role: "user", content: "first usage" }] },
		}, context.ctx);
		await harness.events.before_provider_request({
			type: "before_provider_request",
			payload: { model: "test-model", messages: [{ role: "user", content: "second usage" }] },
		}, context.ctx);
		await harness.events.message_end({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "test",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 20,
					output: 5,
					cacheRead: 80,
					cacheWrite: 0,
					totalTokens: 105,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		}, context.ctx);
		await harness.events.message_end({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "aborted after usage" }],
				api: "test",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 90,
					output: 2,
					cacheRead: 10,
					cacheWrite: 0,
					totalTokens: 102,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				timestamp: 2,
			},
		}, context.ctx);

		const response = await fetch(new URL("/api/context-diff", editorUrl), { headers });
		const view = await response.json() as {
			turns: Array<{ usage?: { cacheHitRatio: number | null } }>;
			latest: { usage?: { provider: string; promptTokens: number; cacheHitRatio: number | null; stopReason: string } } | null;
		};
		assert.equal(response.status, 200);
		assert.equal(view.turns[0]!.usage?.cacheHitRatio, 0.8);
		assert.equal(view.turns[1]!.usage?.cacheHitRatio, 0.1);
		assert.equal(view.latest?.usage?.provider, "test-provider");
		assert.equal(view.latest?.usage?.promptTokens, 100);
		assert.equal(view.latest?.usage?.cacheHitRatio, 0.1);
		assert.equal(view.latest?.usage?.stopReason, "aborted");

		await harness.events.before_provider_request({
			type: "before_provider_request",
			payload: { model: "test-model", messages: [{ role: "user", content: "cleared pending usage" }] },
		}, context.ctx);
		const cleared = await fetch(new URL("/api/payload", editorUrl), { method: "DELETE", headers });
		assert.equal(cleared.status, 200);
		await harness.events.message_end({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				api: "test",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 50,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 50,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				timestamp: 3,
			},
		}, context.ctx);
		const afterClear = await fetch(new URL("/api/context-diff", editorUrl), { headers });
		assert.deepEqual((await afterClear.json() as { turns: unknown[] }).turns, []);
	} finally {
		await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

test("web editor resources and preview survive lifecycle-only host refreshes", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		autoActivate: true,
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
		autoActivate: true,
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
		assert.match(pageHtml, /<div id="app"><\/div>/);
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
			preview?: { system: { title: string; content: string; diffKey?: string }; messages: Array<{ title: string; role: string; content: string; chars: number; diffKey?: string }> };
		};
		assert.ok(previewResult.preview);
		assert.equal(previewResult.preview?.system.title, "System prompt");
		assert.equal(previewResult.preview?.system.diffKey, "system");
		assert.match(previewResult.preview?.system.content ?? "", /base system/);
		assert.match(previewResult.preview?.system.content ?? "", /Available tools:\n- read: Read files\./);
		assert.match(previewResult.preview?.system.content ?? "", /Use read before editing files\./);
		assert.doesNotMatch(previewResult.preview?.system.content ?? "", /Use bash deliberately\./);
		const longMessage = previewResult.preview?.messages.find((message) => message.content.includes("After history"));
		assert.ok(longMessage);
		assert.equal(longMessage?.title, "after");
		assert.equal(longMessage?.diffKey, "stack-item:after:1");
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

test("/preset ui profile mutations remain token-gated and fail closed for untrusted projects", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const harness = createHarness();
	const context = createContext(cwd, [], { trusted: false });
	const profile = {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "blocked",
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		promptStack: null,
	};
	await startSession(harness, context.ctx);

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		const editorUrl = latestEditorUrl(context.editors);
		const token = editorUrl.searchParams.get("token")!;
		const profilesUrl = new URL("/api/profiles", editorUrl);

		const missingToken = await fetch(profilesUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ profile }),
		});
		assert.equal(missingToken.status, 403);

		const createResponse = await fetch(profilesUrl, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pi-forge-token": token },
			body: JSON.stringify({ profile }),
		});
		assert.equal(createResponse.status, 403);
		assert.match(await createResponse.text(), /not trusted/i);

		const reloadResponse = await fetch(new URL("/api/profiles/reload", editorUrl), {
			method: "POST",
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(reloadResponse.status, 200);
		assert.match(await reloadResponse.text(), /"trusted":false/);

		const applyResponse = await fetch(new URL("/api/profiles/blocked/apply", editorUrl), {
			method: "POST",
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(applyResponse.status, 403);

		const deleteResponse = await fetch(new URL("/api/profiles/blocked", editorUrl), {
			method: "DELETE",
			headers: { "x-pi-forge-token": token },
		});
		assert.equal(deleteResponse.status, 403);
		assert.equal(existsSync(join(cwd, ".pi", "forge", "agent-profiles", "blocked.json")), false);
	} finally {
		await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

test("/preset ui refuses profile application while the agent is busy", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	writeProfile(cwd, "busy.json", {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "busy",
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		promptStack: null,
	});
	const harness = createHarness();
	const context = createContext(cwd, [], { idle: false });
	await startSession(harness, context.ctx);

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		const editorUrl = latestEditorUrl(context.editors);
		const response = await fetch(new URL("/api/profiles/busy/apply", editorUrl), {
			method: "POST",
			headers: { "x-pi-forge-token": editorUrl.searchParams.get("token")! },
		});
		assert.equal(response.status, 409);
		assert.match(await response.text(), /current agent operation/);
		assert.equal(harness.setModelCalls.length, 0);
	} finally {
		await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

test("/preset ui accepts at most one auto-activation profile", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const profile = (id: string, autoActivate?: boolean) => ({
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id,
		autoActivate,
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		promptStack: null,
	});
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		const editorUrl = latestEditorUrl(context.editors);
		const token = editorUrl.searchParams.get("token")!;
		const headers = { "content-type": "application/json", "x-pi-forge-token": token };
		const profilesUrl = new URL("/api/profiles", editorUrl);

		const first = await fetch(profilesUrl, { method: "POST", headers, body: JSON.stringify({ profile: profile("first", true) }) });
		assert.equal(first.status, 200);

		const second = await fetch(profilesUrl, { method: "POST", headers, body: JSON.stringify({ profile: profile("second", true) }) });
		assert.equal(second.status, 409);
		assert.match(await second.text(), /Multiple project profiles request auto-activation/);
		assert.equal(existsSync(join(cwd, ".pi", "forge", "agent-profiles", "second.json")), false);

		const plain = await fetch(profilesUrl, { method: "POST", headers, body: JSON.stringify({ profile: profile("second") }) });
		assert.equal(plain.status, 200);

		const enable = await fetch(new URL("/api/profiles/second", editorUrl), {
			method: "PUT",
			headers,
			body: JSON.stringify({ profile: profile("second", true) }),
		});
		assert.equal(enable.status, 409);
		assert.match(await enable.text(), /already requested by first/);

		const keep = await fetch(new URL("/api/profiles/first", editorUrl), {
			method: "PUT",
			headers,
			body: JSON.stringify({ profile: { ...profile("first", true), name: "First updated" } }),
		});
		assert.equal(keep.status, 200);
	} finally {
		await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

test("/preset ui can create a user-global stack through an explicit scope", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-global-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		const harness = createHarness();
		const context = createContext(cwd);
		await startSession(harness, context.ctx);

		try {
			await harness.commands.preset.handler("ui", context.ctx);
			const editorUrl = latestEditorUrl(context.editors);
			const token = editorUrl.searchParams.get("token")!;
			const headers = { "content-type": "application/json", "x-pi-forge-token": token };
			const stack = {
				schemaVersion: 1,
				type: "pi-forge.prompt-stack",
				id: "shared",
				name: "User-Global Shared",
				items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
			};

			const createResponse = await fetch(new URL("/api/stacks", editorUrl), {
				method: "POST",
				headers,
				body: JSON.stringify({ stack, scope: "global" }),
			});
			assert.equal(createResponse.status, 200);
			const created = await createResponse.json() as { stack: { id: string; scope: string; selector: string; name?: string } };
			assert.equal(created.stack.id, "shared");
			assert.equal(created.stack.scope, "global");
			assert.equal(created.stack.selector, "global:shared");
			assert.equal(created.stack.name, "User-Global Shared");
			assert.equal(existsSync(join(globalDir, "prompt-stacks", "shared.json")), true);
		} finally {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
	} finally {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
	}
});

test("/preset ui can create a user-global profile through an explicit scope", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-global-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		const harness = createHarness();
		const context = createContext(cwd);
		await startSession(harness, context.ctx);

		try {
			await harness.commands.preset.handler("ui", context.ctx);
			const editorUrl = latestEditorUrl(context.editors);
			const token = editorUrl.searchParams.get("token")!;
			const headers = { "content-type": "application/json", "x-pi-forge-token": token };
			const profile = {
				schemaVersion: 1,
				type: "pi-forge.agent-profile",
				id: "global-reviewer",
				model: { provider: "test", id: "model" },
				thinkingLevel: "off",
				promptStack: null,
			};

			const createResponse = await fetch(new URL("/api/profiles", editorUrl), {
				method: "POST",
				headers,
				body: JSON.stringify({ profile, scope: "global" }),
			});
			assert.equal(createResponse.status, 200);
			const created = await createResponse.json() as {
				collection: { profiles: Array<{ profile: { id: string }; scope: string; selector: string }> };
			};
			const saved = created.collection.profiles.find((entry) => entry.profile.id === "global-reviewer");
			assert.equal(saved?.scope, "global");
			assert.equal(saved?.selector, "global:global-reviewer");
			assert.equal(existsSync(join(globalDir, "agent-profiles", "global-reviewer.json")), true);
		} finally {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
	} finally {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
	}
});

test("/preset ui validates new global profiles against global scope", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-global-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		// Same-ID project profile plus a global stack: the global draft must not
		// collide with the project file and must resolve the global stack.
		writeProfile(cwd, "worker.json", {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "worker",
			model: { provider: "test", id: "model" },
			thinkingLevel: "off",
			promptStack: null,
		});
		const globalStacksDir = join(globalDir, "prompt-stacks");
		mkdirSync(globalStacksDir, { recursive: true });
		writeFileSync(join(globalStacksDir, "shared.json"), JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "shared",
			items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
		}));

		const harness = createHarness();
		const context = createContext(cwd);
		await startSession(harness, context.ctx);

		try {
			await harness.commands.preset.handler("ui", context.ctx);
			const editorUrl = latestEditorUrl(context.editors);
			const token = editorUrl.searchParams.get("token")!;
			const headers = { "content-type": "application/json", "x-pi-forge-token": token };
			const profile = {
				schemaVersion: 1,
				type: "pi-forge.agent-profile",
				id: "worker",
				model: { provider: "test", id: "model" },
				thinkingLevel: "off",
				promptStack: "shared",
			};

			const validateResponse = await fetch(new URL("/api/profiles/validate", editorUrl), {
				method: "POST",
				headers,
				body: JSON.stringify({ profile, scope: "global" }),
			});
			assert.equal(validateResponse.status, 200);
			const validation = await validateResponse.json() as { diagnostics: Array<{ message: string }> };
			assert.equal(validation.diagnostics.some((diagnostic) => /Profile file already exists/.test(diagnostic.message)), false);
			assert.equal(validation.diagnostics.some((diagnostic) => /Unknown prompt stack/.test(diagnostic.message)), false);

			const createResponse = await fetch(new URL("/api/profiles", editorUrl), {
				method: "POST",
				headers,
				body: JSON.stringify({ profile, scope: "global" }),
			});
			assert.equal(createResponse.status, 200);
			const created = await createResponse.json() as {
				collection: {
					profiles: Array<{
						profile: { id: string; promptStack: string | null };
						scope: string;
						selector: string;
						preview: { diagnostics: Array<{ message: string }> };
					}>;
				};
			};
			const createdGlobal = created.collection.profiles.find((entry) => entry.selector === "global:worker");
			assert.equal(createdGlobal?.scope, "global");
			assert.equal(createdGlobal?.profile.promptStack, "shared");
			assert.equal(createdGlobal?.preview.diagnostics.some((diagnostic) => /Unknown prompt stack/.test(diagnostic.message)), false);
			assert.equal(existsSync(join(globalDir, "agent-profiles", "worker.json")), true);
		} finally {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
	} finally {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
	}
});

test("/preset ui rejects malformed API scope values with 400", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		const editorUrl = latestEditorUrl(context.editors);
		const token = editorUrl.searchParams.get("token")!;
		const headers = { "content-type": "application/json", "x-pi-forge-token": token };
		const stack = {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "bad-scope-stack",
			items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
		};
		const profile = {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "bad-scope-profile",
			model: { provider: "test", id: "model" },
			thinkingLevel: "off",
			promptStack: null,
		};

		const badStack = await fetch(new URL("/api/stacks", editorUrl), {
			method: "POST",
			headers,
			body: JSON.stringify({ stack, scope: "bogus" }),
		});
		assert.equal(badStack.status, 400);

		const badProfile = await fetch(new URL("/api/profiles/validate", editorUrl), {
			method: "POST",
			headers,
			body: JSON.stringify({ profile, scope: "bogus" }),
		});
		assert.equal(badProfile.status, 400);

		const badProfileCreate = await fetch(new URL("/api/profiles", editorUrl), {
			method: "POST",
			headers,
			body: JSON.stringify({ profile, scope: "bogus" }),
		});
		assert.equal(badProfileCreate.status, 400);
	} finally {
		await harness.commands.preset.handler("ui stop", context.ctx);
	}
});

test("/preset ui returns the project shadow after stack create and save", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-index-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-global-"));
	const previousGlobalDir = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		const globalStacksDir = join(globalDir, "prompt-stacks");
		mkdirSync(globalStacksDir, { recursive: true });
		writeFileSync(join(globalStacksDir, "same.json"), JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "same",
			name: "Global Same",
			items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
		}, null, 2));

		const harness = createHarness();
		const context = createContext(cwd);
		await startSession(harness, context.ctx);

		try {
			await harness.commands.preset.handler("ui", context.ctx);
			const editorUrl = latestEditorUrl(context.editors);
			const token = editorUrl.searchParams.get("token")!;
			const headers = { "content-type": "application/json", "x-pi-forge-token": token };
			const projectStack = {
				schemaVersion: 1,
				type: "pi-forge.prompt-stack",
				id: "same",
				name: "Project Same",
				items: [{ kind: "block", id: "system", role: "system", content: "Project shadow." }],
			};

			const createResponse = await fetch(new URL("/api/stacks", editorUrl), {
				method: "POST",
				headers,
				body: JSON.stringify({ stack: projectStack }),
			});
			assert.equal(createResponse.status, 200);
			const created = await createResponse.json() as { stack: { id: string; scope: string; selector: string; name?: string } };
			assert.equal(created.stack.id, "same");
			assert.equal(created.stack.scope, "project");
			assert.equal(created.stack.selector, "project:same");
			assert.equal(created.stack.name, "Project Same");

			const saveResponse = await fetch(new URL("/api/stacks/same", editorUrl), {
				method: "PUT",
				headers,
				body: JSON.stringify({ stack: { ...projectStack, name: "Project Same Saved" } }),
			});
			assert.equal(saveResponse.status, 200);
			const saved = await saveResponse.json() as { stack: { id: string; scope: string; selector: string; name?: string } };
			assert.equal(saved.stack.id, "same");
			assert.equal(saved.stack.scope, "project");
			assert.equal(saved.stack.selector, "project:same");
			assert.equal(saved.stack.name, "Project Same Saved");
		} finally {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
	} finally {
		if (previousGlobalDir === undefined) delete process.env[GLOBAL_FORGE_DIR_ENV];
		else process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobalDir;
	}
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
		autoActivate: true,
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
		autoActivate: true,
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
		autoActivate: true,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	const harness = createHarness();
	const { ctx } = createContext(cwd);
	await startSession(harness, ctx);

	await harness.events.turn_start({ type: "turn_start", turnIndex: 1, timestamp: 1 }, ctx);
	await harness.events.turn_start({ type: "turn_start", turnIndex: 2, timestamp: 2 }, ctx);

	assert.deepEqual(harness.appended, [{ type: "pi-forge-prompt-stack-state", data: { activeStackId: "project:default" } }]);
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("/preset use persists qualified scope and restores legacy bare IDs", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-scoped-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-global-"));
	const previousGlobal = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		const globalStacks = join(globalDir, "prompt-stacks");
		mkdirSync(globalStacks, { recursive: true });
		writeFileSync(join(globalStacks, "reviewer.json"), JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "reviewer",
			items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
		}));

		const harness = createHarness();
		const { ctx, statuses } = createContext(cwd);
		await startSession(harness, ctx);

		// Global stack is selectable through an exact qualified selector.
		await harness.commands.preset.handler("use global:reviewer", ctx);
		assert.equal(statuses["pi-forge"], "stack:reviewer");
		assert.deepEqual(harness.appended.at(-1), { type: "pi-forge-prompt-stack-state", data: { activeStackId: "global:reviewer" } });

		// A bare legacy ID restores through effective lookup.
		const harness2 = createHarness();
		const { ctx: ctx2, statuses: statuses2 } = createContext(cwd, [
			{ type: "custom", customType: "pi-forge-prompt-stack-state", data: { activeStackId: "reviewer" } },
		]);
		await startSession(harness2, ctx2);
		assert.equal(statuses2["pi-forge"], "stack:reviewer");
	} finally {
		process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobal;
	}
});

test("untrusted projects browse global stacks but cannot activate them", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-untrusted-scope-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-untrusted-global-"));
	const previousGlobal = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		mkdirSync(join(globalDir, "prompt-stacks"), { recursive: true });
		writeFileSync(join(globalDir, "prompt-stacks", "reviewer.json"), JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "reviewer",
			items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
		}));
		const harness = createHarness();
		const { ctx, editors, notifications, statuses } = createContext(cwd, [], { trusted: false });
		await startSession(harness, ctx);

		await harness.commands.preset.handler("list", ctx);
		assert.match(editors.at(-1)?.text ?? "", /reviewer/);

		await harness.commands.preset.handler("use global:reviewer", ctx);
		assert.equal(statuses["pi-forge"], undefined);
		assert.match(notifications.at(-1)?.message ?? "", /not trusted/);
	} finally {
		process.env[GLOBAL_FORGE_DIR_ENV] = previousGlobal;
	}
});
