import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chooseDefaultStack, isUsablePromptStack, loadPromptStacks, promptStacksDir } from "../src/loader.ts";

function writeStack(cwd: string, name: string, value: unknown): void {
	mkdirSync(promptStacksDir(cwd), { recursive: true });
	writeFileSync(join(promptStacksDir(cwd), name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

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
