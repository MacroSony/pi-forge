import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importSillyTavernPreset } from "../src/sillytavern-importer.ts";

function writePreset(cwd: string, name: string, value: unknown): string {
	const dir = join(cwd, "st");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
	return path;
}

test("imports a basic preset with one character_id", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "basic.json", {
		prompts: [
			{ identifier: "main", name: "Main", role: "system", content: "You are helpful." },
			{ identifier: "chatHistory", name: "Chat History", marker: true },
			{ identifier: "jailbreak", name: "Post", role: "system", content: "Finish the task." },
		],
		prompt_order: [
			{
				character_id: 100001,
				order: [
					{ identifier: "main", enabled: true },
					{ identifier: "chatHistory", enabled: true },
					{ identifier: "jailbreak", enabled: true },
				],
			},
		],
	});

	const result = importSillyTavernPreset(path);

	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	assert.equal(result.stack.items.length, 3);
	assert.equal(result.stack.items[0].kind, "block");
	assert.equal(result.stack.items[0].content, "You are helpful.");
	assert.equal(result.stack.items[0].role, "system");
	assert.equal(result.stack.items[1].kind, "slot");
	assert.equal(result.stack.items[1].slot, "chat-history");
	assert.equal(result.stack.items[2].kind, "block");
	assert.equal(result.stack.items[2].content, "Finish the task.");
});

test("imports with a specific character_id when multiple exist", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "multi.json", {
		prompts: [
			{ identifier: "a", role: "system", content: "A" },
			{ identifier: "b", role: "user", content: "B" },
		],
		prompt_order: [
			{
				character_id: 1,
				order: [{ identifier: "a", enabled: true }],
			},
			{
				character_id: 2,
				order: [{ identifier: "a", enabled: true }, { identifier: "b", enabled: true }],
			},
		],
	});

	const r1 = importSillyTavernPreset(path, 1);
	assert.ok("stack" in r1);
	if ("stack" in r1) assert.equal(r1.stack.items.length, 1);

	const r2 = importSillyTavernPreset(path, 2);
	assert.ok("stack" in r2);
	if ("stack" in r2) assert.equal(r2.stack.items.length, 2);

	// Without character_id, should error
	const r3 = importSillyTavernPreset(path);
	assert.ok("error" in r3);
	if ("error" in r3) assert.match(r3.error, /Multiple character configs/);
});

test("errors on invalid JSON", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "bad.json", "not json {");

	const result = importSillyTavernPreset(path);
	assert.ok("error" in result);
	if ("error" in result) assert.match(result.error, /Failed to read or parse/);
});

test("errors on missing file", () => {
	const result = importSillyTavernPreset("/tmp/nonexistent-preset-12345.json");
	assert.ok("error" in result);
	if ("error" in result) assert.match(result.error, /Failed to read or parse/);
});

test("errors when no prompts exist", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "empty.json", { prompt_order: [] });

	const result = importSillyTavernPreset(path);
	assert.ok("error" in result);
	if ("error" in result) assert.match(result.error, /no prompts/);
});

test("skips marker items except chatHistory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "markers.json", {
		prompts: [
			{ identifier: "main", role: "system", content: "Hello" },
			{ identifier: "chatHistory", name: "Chat History", marker: true },
			{ identifier: "worldInfoBefore", name: "World Info", marker: true },
			{ identifier: "charDescription", name: "Char Desc", marker: true },
			{ identifier: "scenario", name: "Scenario", marker: true },
		],
		prompt_order: [
			{
				character_id: 1,
				order: [
					{ identifier: "main", enabled: true },
					{ identifier: "worldInfoBefore", enabled: true },
					{ identifier: "chatHistory", enabled: true },
					{ identifier: "charDescription", enabled: true },
					{ identifier: "scenario", enabled: true },
				],
			},
		],
	});

	const result = importSillyTavernPreset(path);
	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	// Only main (block) + chatHistory (slot) should remain
	assert.equal(result.stack.items.length, 2);
	assert.equal(result.stack.items[0].kind, "block");
	assert.equal(result.stack.items[0].content, "Hello");
	assert.equal(result.stack.items[1].kind, "slot");
	assert.equal(result.stack.items[1].slot, "chat-history");
});

test("respects enabled state from prompt_order", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "enabled.json", {
		prompts: [
			{ identifier: "a", role: "system", content: "A" },
			{ identifier: "b", role: "user", content: "B" },
			{ identifier: "c", role: "system", content: "C" },
		],
		prompt_order: [
			{
				character_id: 1,
				order: [
					{ identifier: "a", enabled: true },
					{ identifier: "b", enabled: false },
					{ identifier: "c", enabled: true },
				],
			},
		],
	});

	const result = importSillyTavernPreset(path);
	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	assert.equal(result.stack.items.length, 3);
	assert.equal(result.stack.items[0].enabled, true);
	assert.equal(result.stack.items[1].enabled, false);
	assert.equal(result.stack.items[2].enabled, true);
});

test("detects {{lastUserMessage}} and sets includeLastUserMessage false", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "lastuser.json", {
		prompts: [
			{ identifier: "main", role: "system", content: "Role" },
			{ identifier: "chatHistory", name: "History", marker: true },
			{ identifier: "post", role: "user", content: "Respond to: {{lastUserMessage}}" },
		],
		prompt_order: [
			{
				character_id: 1,
				order: [
					{ identifier: "main", enabled: true },
					{ identifier: "chatHistory", enabled: true },
					{ identifier: "post", enabled: true },
				],
			},
		],
	});

	const result = importSillyTavernPreset(path);
	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	const chatHistory = result.stack.items.find(
		(i: { kind: string; slot?: string }) => i.kind === "slot" && i.slot === "chat-history",
	);
	assert.ok(chatHistory);
	if (chatHistory?.kind === "slot") {
		assert.equal(chatHistory.options?.includeLastUserMessage, false);
	}
});

test("skips empty content items", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "empty-content.json", {
		prompts: [
			{ identifier: "a", role: "system", content: "Real content" },
			{ identifier: "b", role: "user", content: "" },
			{ identifier: "c", role: "assistant", content: "  " },
			{ identifier: "d", role: "system", content: "More content" },
		],
		prompt_order: [
			{
				character_id: 1,
				order: [
					{ identifier: "a", enabled: true },
					{ identifier: "b", enabled: true },
					{ identifier: "c", enabled: true },
					{ identifier: "d", enabled: true },
				],
			},
		],
	});

	const result = importSillyTavernPreset(path);
	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	assert.equal(result.stack.items.length, 2);
	const item0 = result.stack.items[0];
	const item1 = result.stack.items[1];
	assert.ok(item0.kind === "block");
	assert.ok(item1.kind === "block");
	if (item0.kind === "block") assert.equal(item0.content, "Real content");
	if (item1.kind === "block") assert.equal(item1.content, "More content");
});

test("generates an import report with item mapping table", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "report.json", {
		prompts: [
			{ identifier: "main", name: "Main Prompt", role: "system", content: "You are helpful." },
			{ identifier: "chatHistory", name: "Chat History", marker: true },
		],
		prompt_order: [
			{
				character_id: 1,
				order: [
					{ identifier: "main", enabled: true },
					{ identifier: "chatHistory", enabled: true },
				],
			},
		],
	});

	const result = importSillyTavernPreset(path);
	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	assert.match(result.report, /Import Report/);
	assert.match(result.report, /Character ID.*1/);
	assert.match(result.report, /Item mapping/);
	assert.match(result.report, /chatHistory/);
});
