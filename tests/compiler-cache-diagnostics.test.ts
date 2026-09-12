import assert from "node:assert/strict";
import test from "node:test";
import { compileMessages, compileSystemPrompt } from "../src/compiler.ts";
import type { PromptRuntime, PromptStack, PromptStackDiagnostic } from "../src/types.ts";

function runtime(): PromptRuntime {
	return {
		options: { cwd: "/work/project", selectedTools: [], contextFiles: [], skills: [] },
		latestUserMessage: "hello",
		now: new Date("2026-06-13T12:00:00Z"),
	};
}

function cacheDiagnostics(diagnostics: PromptStackDiagnostic[]): PromptStackDiagnostic[] {
	return diagnostics.filter((diagnostic) => /prompt-prefix cache|includeTime/.test(diagnostic.message));
}

test("{{time}} in a system block produces a cache warning on both compile paths", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "time",
		items: [{ kind: "block", id: "system-time", role: "system", content: "Generated at {{time}}" }],
	};

	for (const diagnostics of [
		compileSystemPrompt(stack, runtime(), "base").diagnostics,
		compileMessages(stack, runtime(), []).diagnostics,
	]) {
		const matches = cacheDiagnostics(diagnostics);
		assert.equal(matches.length, 1);
		assert.equal(matches[0]?.level, "warning");
		assert.equal(matches[0]?.itemId, "system-time");
		assert.match(matches[0]?.message ?? "", /changes every turn/);
		assert.match(matches[0]?.message ?? "", /from this item onward/);
		assert.match(matches[0]?.message ?? "", /\{\{date\}\}/);
	}
});

test("includeTime on date slots produces a cache warning", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "date-time-slot",
		items: [{ kind: "slot", id: "date-slot", role: "system", slot: "date-cwd", options: { includeTime: true } }],
	};

	const diagnostics = compileSystemPrompt(stack, runtime(), "base").diagnostics;
	const matches = cacheDiagnostics(diagnostics);
	assert.equal(matches.length, 1);
	assert.equal(matches[0]?.level, "warning");
	assert.equal(matches[0]?.itemId, "date-slot");
	assert.match(matches[0]?.message ?? "", /has includeTime enabled/);
});

test("{{date}} in a template produces an informational cache diagnostic", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "date",
		items: [{ kind: "block", id: "system-date", role: "system", content: "Today is {{runtime.date}}" }],
	};

	const diagnostics = compileSystemPrompt(stack, runtime(), "base").diagnostics;
	const matches = cacheDiagnostics(diagnostics);
	assert.equal(matches.length, 1);
	assert.equal(matches[0]?.level, "info");
	assert.equal(matches[0]?.itemId, "system-date");
	assert.match(matches[0]?.message ?? "", /once per day/);
	assert.match(matches[0]?.message ?? "", /stable within the day/);
});

test("disabled cache-sensitive items produce no cache diagnostic", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "disabled",
		items: [
			{ kind: "block", id: "time", enabled: false, role: "system", content: "{{time}}" },
			{ kind: "slot", id: "date", enabled: false, role: "system", slot: "date", options: { includeTime: true } },
		],
	};

	assert.deepEqual(cacheDiagnostics(compileSystemPrompt(stack, runtime(), "base").diagnostics), []);
	assert.deepEqual(cacheDiagnostics(compileMessages(stack, runtime(), []).diagnostics), []);
});

test("a clean stack produces no new cache diagnostic", () => {
	const stack: PromptStack = {
		schemaVersion: 1,
		id: "clean",
		items: [{ kind: "block", id: "system", role: "system", content: "Stable instructions" }],
	};

	assert.deepEqual(cacheDiagnostics(compileSystemPrompt(stack, runtime(), "base").diagnostics), []);
	assert.deepEqual(cacheDiagnostics(compileMessages(stack, runtime(), []).diagnostics), []);
});
