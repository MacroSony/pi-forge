import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { parsePromptStack } from "../src/codecs/prompt-stack.ts";
import { compileMessages, compileSystemPrompt } from "../src/compiler.ts";
import { applyResourcePolicy } from "../src/policy.ts";
import type { PromptRuntime } from "../src/types.ts";

const EXAMPLE_PATH = new URL("../examples/minimal-prompt-stack.json", import.meta.url);
const PERSONA = "You are a helpful software engineer assistant.";

test("minimal example approximates the DeepSeek Harness Minimal shape with stock Pi tools", async () => {
	const source = await readFile(EXAMPLE_PATH, "utf8");
	const loaded = parsePromptStack(source, EXAMPLE_PATH.pathname, "project");
	assert.deepEqual(loaded.diagnostics.filter((diagnostic) => diagnostic.level === "error"), []);

	const runtime: PromptRuntime = {
		options: {
			cwd: "/work/project",
			selectedTools: ["read", "bash", "edit", "write"],
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		},
		latestUserMessage: "Fix the failing test.",
		now: new Date("2026-08-28T12:00:00Z"),
		model: { api: "openai-completions", provider: "test", id: "deepseek" },
	};
	const summary = { role: "compactionSummary", summary: "old summary", timestamp: 1 } as AgentMessage;
	const user = { role: "user", content: runtime.latestUserMessage, timestamp: 2 } as AgentMessage;

	assert.equal(compileSystemPrompt(loaded.stack, runtime, "Pi base prompt").systemPrompt, PERSONA);
	assert.deepEqual(applyResourcePolicy([...(runtime.options.selectedTools ?? [])], loaded.stack.tools), ["bash", "edit"]);
	assert.deepEqual(compileMessages(loaded.stack, runtime, [summary, user]).messages, [user]);
});
