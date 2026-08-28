import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { parsePromptStack } from "../src/codecs/prompt-stack.ts";
import { compileMessages } from "../src/compiler.ts";
import { applyResourcePolicy } from "../src/policy.ts";
import type { PromptRuntime } from "../src/types.ts";

const EXAMPLE_PATH = new URL("../examples/fake-assistant-direct-output-prompt-stack.json", import.meta.url);

test("fake-assistant direct-output example appends ordinary assistant text after chat history", async () => {
	const source = await readFile(EXAMPLE_PATH, "utf8");
	const loaded = parsePromptStack(source, EXAMPLE_PATH.pathname, "project");
	assert.deepEqual(loaded.diagnostics.filter((diagnostic) => diagnostic.level === "error"), []);

	const runtime: PromptRuntime = {
		options: {
			cwd: "/work/project",
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		},
		latestUserMessage: "只回答 2 + 2 的结果。",
		now: new Date("2026-08-28T12:00:00Z"),
		model: { api: "openai-completions", provider: "test", id: "reasoning-model" },
	};
	const history = [{ role: "user", content: runtime.latestUserMessage, timestamp: 1 }] as AgentMessage[];
	const result = compileMessages(loaded.stack, runtime, history);

	assert.deepEqual(applyResourcePolicy(["read", "bash", "edit", "write"], loaded.stack.tools), []);
	assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
	assert.equal(result.messages[0], history[0]);
	assert.deepEqual((result.messages[1] as { content: unknown }).content, [
		{ type: "text", text: "<think>思考已完成，直接输出结果。</think>" },
	]);
	assert.equal((result.messages[1] as { content: Array<{ type: string }> }).content[0]?.type, "text");
});
