import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const SCRIPT = join(process.cwd(), "scripts", "migrate-stack-v2.mjs");

function writeV1(dir: string, content: unknown): string {
	const file = join(dir, "stack.json");
	writeFileSync(file, JSON.stringify(content));
	return file;
}

test("migration script converts mechanical v1 stacks and writes with --write", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-forge-migrate-ok-"));
	const file = writeV1(dir, {
		schemaVersion: 1,
		id: "sample",
		variables: { char: "Konata", date: "2026-01-01", tools: "static-tools" },
		items: [
			{ kind: "block", id: "a", role: "system", content: "Hi {{char}} {{lastUserMessage}} {{ upper::char }} {{date}} {{ tools | upper }} {% if runtime.tool.read %}r{% else %}n{% endif %}" },
		],
	});
	const { stdout } = await run("node", [SCRIPT, file, "--write"]);
	assert.match(stdout, /Wrote migrated stack/);
	const migrated = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(migrated.schemaVersion, 2);
	assert.deepEqual(migrated.parameters, { char: "Konata", date: "2026-01-01", tools: "static-tools" });
	assert.equal(
		migrated.items[0].content,
		"Hi {{ parameters.char }} {{ runtime.lastUserMessage }} {{ parameters.char | upper }} {{ parameters.date }} {{ parameters.tools | upper }} {% if runtime.tool.read %}r{% else %}n{% endif %}",
	);
});

test("migration script dry run does not write", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-forge-migrate-dry-"));
	const file = writeV1(dir, {
		schemaVersion: 1,
		id: "sample",
		variables: { char: "Konata" },
		items: [{ kind: "block", id: "a", content: "Hi {{char}}" }],
	});
	const original = readFileSync(file, "utf8");
	const { stdout } = await run("node", [SCRIPT, file]);
	assert.match(stdout, /Dry run/);
	assert.equal(readFileSync(file, "utf8"), original);
});

test("migration script refuses non-mechanical constructs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-forge-migrate-refuse-"));
	const file = writeV1(dir, {
		schemaVersion: 1,
		id: "sample",
		variables: { char: "Konata" },
		items: [
			{ kind: "block", id: "a", content: "{{myMacro}}" },
			{ kind: "block", id: "b", content: "{{iftools::bash::A::B}}" },
		],
	});
	const original = readFileSync(file, "utf8");
	await assert.rejects(
		run("node", [SCRIPT, file, "--write"]),
		/Non-mechanical constructs remain/,
	);
	assert.equal(readFileSync(file, "utf8"), original);
});
