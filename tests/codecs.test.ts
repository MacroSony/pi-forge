import assert from "node:assert/strict";
import test from "node:test";
import {
	parsePromptStack,
	serializePromptStack,
	validatePromptStack,
} from "../src/codecs/prompt-stack.ts";
import {
	parseAgentProfile,
	serializeAgentProfile,
	validateAgentProfile,
} from "../src/codecs/agent-profile.ts";

test("prompt-stack codec parses, validates, and serializes as the single source", () => {
	const source = JSON.stringify({
		schemaVersion: 2,
		type: "pi-forge.prompt-stack",
		id: "codec-stack",
		parameters: { x: 1 },
		items: [{ id: "role", kind: "block", role: "system", content: "Hello {{ parameters.x }}" }],
	});
	const loaded = parsePromptStack(source, "/proj/.pi/forge/prompt-stacks/codec-stack.json", "project");
	assert.equal(loaded.stack.id, "codec-stack");
	assert.equal(loaded.stack.schemaVersion, 2);
	assert.equal(loaded.diagnostics.some((d) => d.level === "error"), false);
	assert.equal(validatePromptStack(loaded.stack).some((d) => d.level === "error"), false);
	assert.equal(serializePromptStack(loaded.stack), `${JSON.stringify(loaded.stack, null, 2)}\n`);
});

test("prompt-stack codec returns fail-closed result on invalid JSON", () => {
	const loaded = parsePromptStack("{not json", "/proj/.pi/forge/prompt-stacks/broken.json", "project");
	assert.equal(loaded.stack.id, "broken");
	assert.equal(loaded.diagnostics.some((d) => d.level === "error" && /Failed to parse JSON/.test(d.message)), true);
});

test("agent-profile codec parses, validates, and serializes as the single source", () => {
	const source = JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "codec-profile",
		name: "Codec",
		model: { provider: "test", id: "m" },
		thinkingLevel: "high",
		promptStack: null,
	});
	const loaded = parseAgentProfile(source, "/proj/.pi/forge/agent-profiles/codec-profile.json", "project");
	assert.equal(loaded.profile.id, "codec-profile");
	assert.equal(loaded.profile.thinkingLevel, "high");
	assert.deepEqual(loaded.diagnostics, []);
	assert.deepEqual(validateAgentProfile(loaded.profile), []);
	assert.equal(serializeAgentProfile(loaded.profile), `${JSON.stringify(loaded.profile, null, 2)}\n`);
});

test("agent-profile codec rejects unknown fields", () => {
	const source = JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "bad",
		model: { provider: "test", id: "m" },
		thinkingLevel: "high",
		promptStack: null,
		extraField: true,
	});
	const loaded = parseAgentProfile(source, "/proj/.pi/forge/agent-profiles/bad.json", "project");
	assert.equal(loaded.diagnostics.some((d) => d.level === "error" && /Unsupported profile field/.test(d.message)), true);
});

test("prompt-stack codec collapses duplicate shape diagnostics for defaults/context", () => {
	const source = JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "dup",
		defaults: { syntheticMessagesVisible: "false", unresolvedMacroPolicy: "ignore" },
		context: { allowDuplicateChatHistory: "false" },
		items: [],
	});
	const loaded = parsePromptStack(source, "/proj/.pi/forge/prompt-stacks/dup.json", "project");
	const errors = loaded.diagnostics.filter((d) => d.level === "error");
	assert.equal(errors.filter((d) => d.message.includes("syntheticMessagesVisible")).length, 1);
	assert.equal(errors.filter((d) => d.message.includes("unresolvedMacroPolicy")).length, 1);
	assert.equal(errors.filter((d) => d.message.includes("allowDuplicateChatHistory")).length, 1);
});

test("prompt-stack codec parse->serialize->parse is idempotent", () => {
	const source = JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "idem",
		mode: "replace",
		items: [{ id: "role", kind: "block", role: "system", content: "Hello" }],
	});
	const first = parsePromptStack(source, "/proj/.pi/forge/prompt-stacks/idem.json", "project");
	const second = parsePromptStack(serializePromptStack(first.stack), "/proj/.pi/forge/prompt-stacks/idem.json", "project");
	assert.equal(serializePromptStack(second.stack), serializePromptStack(first.stack));
	assert.equal(second.stack.id, first.stack.id);
});
