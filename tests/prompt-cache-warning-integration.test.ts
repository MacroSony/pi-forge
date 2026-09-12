import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createContext, createHarness, startSession, writeStack } from "./helpers/index-command-harness.ts";

test("preset switching warns from the saved compile and latest provider usage", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-cache-warning-"));
	writeStack(cwd, "current.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "current",
		autoActivate: true,
		items: [{ kind: "block", id: "system", role: "system", content: "abcdefghijklmnopqrst" }],
	});
	writeStack(cwd, "next.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "next",
		autoActivate: false,
		items: [{ kind: "block", id: "system", role: "system", content: "abcdefghijDIFFERENT" }],
	});
	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);

	await harness.events.before_agent_start({
		type: "before_agent_start",
		systemPromptOptions: context.ctx.getSystemPromptOptions(),
		systemPrompt: "base system",
		prompt: "hello",
	}, context.ctx);
	await harness.events.before_provider_request({
		type: "before_provider_request",
		payload: { model: "test-model", messages: [{ role: "user", content: "hello" }] },
	}, context.ctx);
	await harness.events.message_end({
		type: "message_end",
		message: {
			role: "assistant",
			provider: "test-provider",
			model: "test-model",
			usage: { input: 10, output: 2, cacheRead: 42, cacheWrite: 0, totalTokens: 54 },
			stopReason: "stop",
		},
	}, context.ctx);
	await harness.events.agent_end({ type: "agent_end" }, context.ctx);

	await harness.commands.preset.handler("use next", context.ctx);
	const warning = context.notifications.find((item) => item.message.includes("Common prefix with current prompt"));
	assert.ok(warning);
	assert.equal(warning.type, "warning");
	assert.match(warning.message, /~3 tokens \(50%\)/);
	assert.match(warning.message, /Last request read ~42 tokens from cache/);
});
