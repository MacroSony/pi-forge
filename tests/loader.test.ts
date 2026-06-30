import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chooseDefaultStack, isUsablePromptStack, legacyPromptStacksDir, loadPromptStacks, promptStacksDir, validatePromptStack } from "../src/loader.ts";

function writeStack(cwd: string, name: string, value: unknown): void {
	mkdirSync(promptStacksDir(cwd), { recursive: true });
	writeFileSync(join(promptStacksDir(cwd), name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function writeLegacyStack(cwd: string, name: string, value: unknown): void {
	mkdirSync(legacyPromptStacksDir(cwd), { recursive: true });
	writeFileSync(join(legacyPromptStacksDir(cwd), name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

test("published example prompt stacks validate", () => {
	const examplesDir = join(process.cwd(), "examples");
	const excluded = new Set(["validation-issues-prompt-stack.json"]);
	const files = readdirSync(examplesDir).filter((name) => name.endsWith(".json") && !excluded.has(name));

	assert.ok(files.length > 0);
	for (const file of files) {
		const stack = JSON.parse(readFileSync(join(examplesDir, file), "utf8"));
		const diagnostics = validatePromptStack(stack);

		assert.deepEqual(diagnostics, [], file);
	}
});

test("chooseDefaultStack skips an invalid default stack", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeStack(cwd, "default.json", "{ invalid json");
	writeStack(cwd, "usable.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "usable",
		autoActivate: true,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const stacks = loadPromptStacks(cwd);
	const invalidDefault = stacks.find((loaded) => loaded.stack.id === "default");
	const chosen = chooseDefaultStack(stacks);

	assert.equal(isUsablePromptStack(invalidDefault!), false);
	assert.equal(chosen?.stack.id, "usable");
});

test("chooseDefaultStack does not restore a preferred stack with errors", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeStack(cwd, "bad.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "bad",
		items: "not an array",
	});
	writeStack(cwd, "good.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "good",
		autoActivate: true,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const stacks = loadPromptStacks(cwd);
	const chosen = chooseDefaultStack(stacks, "bad");

	assert.equal(chosen?.stack.id, "good");
});

test("chooseDefaultStack still prefers a usable default file", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
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
		autoActivate: true,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const chosen = chooseDefaultStack(loadPromptStacks(cwd));

	assert.equal(chosen?.stack.id, "default");
});

test("chooseDefaultStack skips default.json when autoActivate is false", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		autoActivate: false,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeStack(cwd, "other.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "other",
		autoActivate: true,
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const chosen = chooseDefaultStack(loadPromptStacks(cwd));

	assert.equal(chosen?.stack.id, "other");
});

test("chooseDefaultStack honors an explicit disabled selection", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const chosen = chooseDefaultStack(loadPromptStacks(cwd), "none");

	assert.equal(chosen, undefined);
});

test("loadPromptStacks flags duplicate stack ids as errors", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	for (const name of ["a.json", "b.json"]) {
		writeStack(cwd, name, {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "same",
			items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
		});
	}

	const stacks = loadPromptStacks(cwd);

	assert.equal(stacks.length, 2);
	for (const loaded of stacks) {
		assert.equal(isUsablePromptStack(loaded), false);
		assert.match(loaded.diagnostics.find((d) => d.level === "error")?.message ?? "", /Duplicate stack id: same/);
	}
	assert.equal(chooseDefaultStack(stacks), undefined);
});

test("loadPromptStacks reads legacy prompt-stack directory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeLegacyStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const stacks = loadPromptStacks(cwd);

	assert.equal(stacks.length, 1);
	assert.equal(stacks[0]?.stack.id, "default");
	assert.equal(stacks[0]?.filePath, join(legacyPromptStacksDir(cwd), "default.json"));
	assert.equal(chooseDefaultStack(stacks)?.stack.id, "default");
});

test("loadPromptStacks prefers forge storage over same-named legacy files", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeLegacyStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "legacy",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "primary",
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const stacks = loadPromptStacks(cwd);

	assert.deepEqual(stacks.map((loaded) => loaded.stack.id), ["primary"]);
	assert.equal(stacks[0]?.filePath, join(promptStacksDir(cwd), "default.json"));
});

test("loadPromptStacks validates regex config", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		regex: {
			rules: [
				{ id: "bad", stage: "compiled", pattern: "(", flags: "z" },
				{ id: "bad", stage: "compiled", effect: "display", pattern: "x" },
			],
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const loaded = loadPromptStacks(cwd)[0]!;
	const messages = loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

	assert.match(messages, /Duplicate regex rule id: bad/);
	assert.match(messages, /unsupported regex flag: z/);
	assert.match(messages, /effect "display".*ignored/);
	assert.equal(isUsablePromptStack(loaded), false);
});

test("loadPromptStacks validates tool and skill policies", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		mode: "append",
		tools: {
			allow: ["read", "read"],
			deny: ["bash"],
		},
		skills: {
			allow: "review",
			deny: ["browser-*"],
		},
		items: [{ kind: "slot", id: "history", enabled: true, slot: "chat-history" }],
	});

	const loaded = loadPromptStacks(cwd)[0]!;
	const messages = loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

	assert.match(messages, /tools policy must use either allow or deny, not both/);
	assert.match(messages, /Duplicate tools\.allow pattern: read/);
	assert.match(messages, /skills\.allow must be an array of strings/);
	assert.match(messages, /skills policy only filters pi-forge skills slots/);
	assert.equal(isUsablePromptStack(loaded), false);
});
