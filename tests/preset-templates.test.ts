import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compileMessages, compileSystemPrompt } from "../src/compiler.ts";
import { validatePromptStack } from "../src/codecs/prompt-stack.ts";
import { createPresetFromTemplate } from "../src/web-editor/client/preset-templates.ts";

test("empty creation template preserves the compiler's base prompt and implicit history", () => {
	const stack = createPresetFromTemplate("empty", "blank", "Blank", { autoActivate: true });
	const runtime = { options: { cwd: "/fixture", selectedTools: ["read"] }, now: new Date(0) };
	const history: AgentMessage[] = [{ role: "user", content: "Keep this conversation", timestamp: 1 }];
	assert.equal(validatePromptStack(stack).some(d => d.level === "error"), false);
	assert.deepEqual(stack.items, []);
	assert.equal(stack.tools, undefined);
	assert.equal(stack.skills, undefined);
	assert.equal(compileSystemPrompt(stack, runtime, "Original Pi system prompt").systemPrompt, "Original Pi system prompt");
	assert.deepEqual(compileMessages(stack, runtime, history).messages, history);
	assert.equal(stack.autoActivate, true);
});

test("creation templates return independent drafts without persisting template metadata", () => {
	for (const template of ["default", "empty", "minimal"] as const) {
		const first = createPresetFromTemplate(template, "first", "First");
		const second = createPresetFromTemplate(template, "second", "Second");
		assert.equal(validatePromptStack(first).some(d => d.level === "error"), false);
		assert.equal(Object.hasOwn(first, "template"), false);
		assert.equal(first.autoActivate, false);
		const expected = structuredClone(second);
		first.items.push({ kind: "block", id: "extra", role: "system", content: "Only this draft" });
		first.tools?.allow?.push("test_extra_tool");
		assert.deepEqual(second, expected);
	}
});
