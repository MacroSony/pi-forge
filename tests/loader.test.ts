import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chooseAutoActivateStack, chooseDefaultStack, isUsablePromptStack, legacyPromptStacksDir, loadPromptStacks, loadPromptStacksScoped, promptStacksDir, validatePromptStack } from "../src/loader.ts";
import { registerSlot } from "../src/index.ts";
import type { PromptStack } from "../src/types.ts";

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

test("chooseDefaultStack no longer prefers default.json by filename", () => {
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

	const stacks = loadPromptStacks(cwd);
	const chosen = chooseDefaultStack(stacks);

	assert.equal(chosen?.stack.id, "other");
	const legacyDefault = stacks.find((loaded) => loaded.stack.id === "default");
	assert.match(
		legacyDefault?.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ?? "",
		/default\.json no longer auto-activates by filename/,
	);
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
		assert.match(loaded.diagnostics.find((d) => d.level === "error")?.message ?? "", /Duplicate project stack id: same/);
	}
	assert.equal(chooseDefaultStack(stacks), undefined);
});

test("loadPromptStacks reads legacy prompt-stack directory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeLegacyStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		autoActivate: true,
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
	assert.match(messages, /effect must be "outgoing" or "finalize"/);
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
	assert.match(messages, /does not disable explicit skill invocation.*not a security boundary/);
	assert.match(messages, /skills policy only filters pi-forge skills slots/);
	assert.equal(isUsablePromptStack(loaded), false);
});

test("loadPromptStacks preserves strict errors for malformed fields before normalization", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeStack(cwd, "malformed.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "malformed",
		autoActivate: "false",
		mode: "replace-ish",
		defaults: {
			syntheticMessagesVisible: "false",
			unresolvedMacroPolicy: "ignore",
		},
		context: { allowDuplicateChatHistory: "false" },
		variables: { valid: "yes", invalid: 1 },
		items: [{
			kind: "sloot",
			id: "bad-item",
			enabled: "false",
			role: "sysstem",
			content: "must not become usable",
			tags: ["valid", 1],
			source: "inline",
		}],
	});

	const loaded = loadPromptStacks(cwd)[0]!;
	const messages = loaded.diagnostics.map((diagnostic) => diagnostic.message).join("\n");

	assert.equal(isUsablePromptStack(loaded), false);
	assert.match(messages, /autoActivate must be a boolean/);
	assert.match(messages, /mode must be/);
	assert.match(messages, /syntheticMessagesVisible must be a boolean/);
	assert.match(messages, /unresolvedMacroPolicy must be/);
	assert.match(messages, /allowDuplicateChatHistory must be a boolean/);
	assert.match(messages, /Stack variable invalid must be a string/);
	assert.match(messages, /kind must be "block" or "slot"/);
	assert.match(messages, /enabled must be a boolean/);
	assert.match(messages, /Invalid role: sysstem/);
	assert.match(messages, /tags must be an array of strings/);
	assert.match(messages, /source must be an object/);
	assert.equal(loaded.stack.items[0]?.kind, "block");
});

test("loadPromptStacks accepts registered custom slots", () => {
	const unregister = registerSlot({
		name: "test-loader-slot",
		description: "Test-only loader slot.",
		render: () => "",
	});
	const stack: PromptStack = {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "custom",
		items: [
			{ kind: "slot", id: "custom-slot", enabled: true, role: "system", slot: "test-loader-slot" },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	};
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-"));
	writeStack(cwd, "custom.json", stack);

	try {
		const loaded = loadPromptStacks(cwd)[0]!;

		assert.deepEqual(loaded.diagnostics, []);
	} finally {
		unregister();
	}

	const diagnostics = validatePromptStack(stack);
	assert.match(diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /Unsupported slot: test-loader-slot/);
});

test("loadPromptStacksScoped loads global and project stacks with scope labels", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-scoped-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-loader-global-"));
	writeStack(cwd, "project.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "only-project", items: [] });
	writeFileSync(join(globalDir, "global.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "only-global", items: [] }));

	const stacks = loadPromptStacksScoped(cwd, globalDir);

	assert.deepEqual(
		stacks.map((loaded) => [loaded.scope, loaded.stack.id]).sort(),
		[["global", "only-global"], ["project", "only-project"]],
	);
	for (const loaded of stacks) {
		assert.deepEqual(loaded.key, { scope: loaded.scope, id: loaded.stack.id });
	}
});

test("same-ID project and global stacks form a valid shadow pair", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-scoped-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-loader-global-"));
	writeStack(cwd, "reviewer.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "reviewer", items: [] });
	writeFileSync(join(globalDir, "reviewer.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "reviewer", items: [] }));

	const stacks = loadPromptStacksScoped(cwd, globalDir);

	assert.equal(stacks.length, 2);
	assert.equal(stacks.some((loaded) => loaded.diagnostics.some((diagnostic) => diagnostic.level === "error")), false);
});

test("duplicate stack IDs within one scope remain errors", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-scoped-"));
	writeStack(cwd, "a.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "same", items: [] });
	writeStack(cwd, "b.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "same", items: [] });

	const stacks = loadPromptStacksScoped(cwd, mkdtempSync(join(tmpdir(), "pi-forge-loader-global-")));

	const project = stacks.filter((loaded) => loaded.scope === "project");
	assert.equal(project.length, 2);
	for (const loaded of project) {
		assert.match(loaded.diagnostics.map((d) => d.message).join("\\n"), /Duplicate project stack id: same/);
	}
});

test("chooseAutoActivateStack applies project precedence and fails closed on ambiguity", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-scoped-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-loader-global-"));
	writeStack(cwd, "p.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "p", autoActivate: true, items: [] });
	writeFileSync(join(globalDir, "g.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "g", autoActivate: true, items: [] }));

	assert.equal(chooseAutoActivateStack(loadPromptStacksScoped(cwd, globalDir))?.stack.id, "p");

	// Two project autoActivate candidates fail closed, never falling back to global.
	const cwd2 = mkdtempSync(join(tmpdir(), "pi-forge-loader-scoped-"));
	writeStack(cwd2, "p1.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "p1", autoActivate: true, items: [] });
	writeStack(cwd2, "p2.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "p2", autoActivate: true, items: [] });
	writeFileSync(join(globalDir, "g.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "g", autoActivate: true, items: [] }));

	assert.equal(chooseAutoActivateStack(loadPromptStacksScoped(cwd2, globalDir)), undefined);
});

test("an invalid project autoActivate candidate blocks global fallback", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-loader-scoped-"));
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-loader-global-"));
	writeStack(cwd, "broken.json", { schemaVersion: 1, type: "pi-forge.prompt-stack", id: "broken", autoActivate: true, items: "not-an-array" });
	writeFileSync(join(globalDir, "g.json"), JSON.stringify({ schemaVersion: 1, type: "pi-forge.prompt-stack", id: "g", autoActivate: true, items: [] }));

	assert.equal(chooseAutoActivateStack(loadPromptStacksScoped(cwd, globalDir)), undefined);
});
