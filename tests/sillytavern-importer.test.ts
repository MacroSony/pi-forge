import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertSillyTavernPreset, importSillyTavernPreset } from "../src/sillytavern-importer.ts";

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

test("converts an uploaded preset object with source name", () => {
	const result = convertSillyTavernPreset(
		{
			preset_name: "Uploaded Writer",
			prompts: [
				{ identifier: "main", name: "Main", role: "system", content: "You are {{char}}." },
				{ identifier: "chatHistory", name: "Chat History", marker: true },
			],
			prompt_order: [
				{
					character_id: 7,
					order: [
						{ identifier: "main", enabled: true },
						{ identifier: "chatHistory", enabled: true },
					],
				},
			],
		},
		{ sourceName: "Uploaded Writer.json" },
	);

	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	assert.equal(result.stack.id, "uploaded-writer");
	assert.equal(result.stack.name, "Uploaded Writer");
	assert.equal(result.stack.import?.source, "sillytavern");
	assert.equal(result.stack.import?.sourceFile, "Uploaded Writer");
	assert.match(result.report, /Source file.*Uploaded Writer\.json/);
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
			{ identifier: "main", name: "Main Prompt", role: "system", content: "You are {{char}}." },
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
	assert.match(result.report, /\/state set <name> <value>/);
	assert.doesNotMatch(result.report, /\$\{key\}/);
});

test("detects camelCase SillyTavern macros after normalization", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "camel.json", {
		prompts: [
			{ identifier: "chatHistory", name: "History", marker: true },
			{ identifier: "post", role: "user", content: "Latest: {{lastUserMessage}} {{charPrompt}} {{mesExamplesRaw}}" },
		],
		prompt_order: [
			{
				character_id: 1,
				order: [
					{ identifier: "chatHistory", enabled: true },
					{ identifier: "post", enabled: true },
				],
			},
		],
	});

	const result = importSillyTavernPreset(path);
	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	const history = result.stack.items.find((item) => item.kind === "slot" && item.slot === "chat-history");
	assert.ok(history?.kind === "slot");
	if (history?.kind === "slot") assert.equal(history.options?.includeLastUserMessage, false);
	assert.match(result.report, /\{\{lastUserMessage\}\}/);
	assert.match(result.report, /\{\{charPrompt\}\}/);
	assert.match(result.report, /\{\{mesExamplesRaw\}\}/);
});

test("reports supported variable macros as handled instead of migration-needed", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-st-import-"));
	const path = writePreset(cwd, "vars.json", {
		prompts: [
			{ identifier: "main", role: "system", content: "{{setvar::mood::bright}}{{getvar::mood}}{{setsessionvar::scene::office}}{{getsessionvar::scene}}" },
			{ identifier: "chatHistory", marker: true },
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

	assert.doesNotMatch(result.report, /Macros needing manual migration/);
	assert.match(result.report, /Handled macros/);
	assert.match(result.report, /\{\{setvar\}\}.*turn variable/);
	assert.match(result.report, /\{\{getvar\}\}.*turn -> session -> static lookup/);
	assert.match(result.report, /\{\{setsessionvar\}\}.*session variable/);
	assert.match(result.report, /\{\{getsessionvar\}\}.*session-only lookup/);
});

test("reports SillyTavern regex script classification", () => {
	const result = convertSillyTavernPreset(
		{
			preset_name: "Regex Preset",
			prompts: [
				{ identifier: "main", role: "system", content: "Main" },
				{ identifier: "chatHistory", marker: true },
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
			extensions: {
				regex_scripts: [
					{ script_name: "Prompt Cleaner", promptOnly: true, markdownOnly: false, disabled: false, findRegex: "foo", replaceString: "bar" },
					{ scriptName: "Display Decorator", promptOnly: false, markdownOnly: true, disabled: false, findRegex: "<tag>(.*)</tag>", replaceString: "<div>$1</div>" },
					{ name: "Mixed Rewrite", promptOnly: true, markdownOnly: true, disabled: false, findRegex: "a|b", replaceString: "c" },
					{ script_name: "Disabled Script", promptOnly: true, markdownOnly: false, disabled: true, findRegex: "x", replaceString: "y" },
					{ script_name: "Unspecified Script", disabled: false, findRegex: "m", replaceString: "n" },
				],
			},
		},
		{ sourceName: "Regex Preset.json" },
	);

	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	assert.match(result.report, /SillyTavern regex scripts/);
	assert.match(result.report, /Total scripts\*\*: 5/);
	assert.match(result.report, /Enabled scripts\*\*: 4/);
	assert.match(result.report, /Disabled scripts\*\*: 1/);
	assert.match(result.report, /Prompt-only\*\*: 1/);
	assert.match(result.report, /Markdown-only \/ display-only\*\*: 1/);
	assert.match(result.report, /Prompt \+ markdown mixed\*\*: 1/);
	assert.match(result.report, /Enabled with unspecified mode\*\*: 1/);
	assert.match(result.report, /Converted to pi-forge rules\*\*: 2/);
	assert.match(result.report, /Prompt Cleaner/);
	assert.match(result.report, /Display Decorator/);
	assert.match(result.report, /Mixed Rewrite/);
	assert.match(result.report, /Disabled Script/);
	assert.match(result.report, /Unspecified Script/);
	assert.match(result.report, /DOM\/browser automation/);
	assert.match(result.report, /stage: "compiled"/);
	assert.equal(result.stack.regex?.rules?.length, 2);
	assert.deepEqual(result.stack.regex?.rules?.[0], {
		id: "st-prompt-cleaner",
		name: "Prompt Cleaner",
		enabled: true,
		stage: "compiled",
		effect: "outgoing",
		targets: ["system", "messages"],
		pattern: "foo",
		replace: "bar",
	});
	assert.equal(result.stack.regex?.rules?.[1]?.id, "st-disabled-script");
	assert.equal(result.stack.regex?.rules?.[1]?.enabled, false);
});

test("skips unsupported SillyTavern regex scripts during conversion", () => {
	const result = convertSillyTavernPreset(
		{
			preset_name: "Unsupported Regex",
			prompts: [
				{ identifier: "main", role: "system", content: "Main" },
				{ identifier: "chatHistory", marker: true },
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
			extensions: {
				regex_scripts: [
					{ script_name: "Sticky", promptOnly: true, markdownOnly: false, disabled: false, findRegex: "/foo/y", replaceString: "bar" },
					{ script_name: "Broken", promptOnly: true, markdownOnly: false, disabled: false, findRegex: "/(/g", replaceString: "" },
					{ script_name: "Display", promptOnly: false, markdownOnly: true, disabled: false, findRegex: "/x/g", replaceString: "y" },
				],
			},
		},
		{ sourceName: "Unsupported Regex.json" },
	);

	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	assert.equal(result.stack.regex, undefined);
	assert.match(result.report, /Converted to pi-forge rules\*\*: 0/);
	assert.match(result.report, /unsupported regex flag: y/);
	assert.match(result.report, /regex failed to compile/);
	assert.match(result.report, /not prompt-only/);
});

const tgbreakFixturePath = join(process.cwd(), ".pi", "TGbreak😺V3.1.1.json");

test("classifies TGbreak regex fixture", { skip: !existsSync(tgbreakFixturePath) }, () => {
	const raw = JSON.parse(readFileSync(tgbreakFixturePath, "utf8")) as {
		prompt_order?: Array<{ character_id?: unknown }>;
	};
	const characterId = raw.prompt_order?.find((entry) => typeof entry.character_id === "number")?.character_id;
	if (typeof characterId !== "number") throw new Error("TGbreak fixture has no numeric character_id.");
	const result = convertSillyTavernPreset(raw, { sourceName: "TGbreak😺V3.1.1.json", characterId });

	assert.ok("stack" in result);
	if (!("stack" in result)) return;

	assert.match(result.report, /SillyTavern regex scripts/);
	assert.match(result.report, /Total scripts\*\*: 13/);
	assert.match(result.report, /Enabled scripts\*\*: 13/);
	assert.match(result.report, /Disabled scripts\*\*: 0/);
	assert.match(result.report, /Prompt-only\*\*: 5/);
	assert.match(result.report, /Markdown-only \/ display-only\*\*: 6/);
	assert.match(result.report, /Prompt \+ markdown mixed\*\*: 2/);
});
