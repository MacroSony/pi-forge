import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROFILE_TYPE } from "../src/agent-profile.ts";
import { serializePromptStack } from "../src/codecs/prompt-stack.ts";
import { serializeAgentProfile } from "../src/codecs/agent-profile.ts";
import {
	deletePromptStackFile,
	promptStackTargetPath,
	writePromptStackFile,
} from "../src/repositories/prompt-stack.ts";
import {
	deleteAgentProfileFile,
	agentProfileTargetPath,
	writeAgentProfileFile,
} from "../src/repositories/agent-profile.ts";
import { parsePromptStack } from "../src/codecs/prompt-stack.ts";
import { parseAgentProfile } from "../src/codecs/agent-profile.ts";
import { GLOBAL_FORGE_DIR_ENV } from "../src/storage.ts";
import { migrateLegacyPromptStacks } from "../src/stack-migration.ts";
import { stackMutationStatus } from "../src/web-host.ts";
import type { AgentProfile } from "../src/agent-profile.ts";
import type { PromptStack } from "../src/types.ts";

function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-forge-repo-"));
	mkdirSync(join(dir, ".pi", "forge", "prompt-stacks"), { recursive: true });
	mkdirSync(join(dir, ".pi", "forge", "agent-profiles"), { recursive: true });
	return dir;
}

function stack(id: string): PromptStack {
	return { schemaVersion: 1, type: "pi-forge.prompt-stack", id, items: [] };
}

function profile(id: string): AgentProfile {
	return { schemaVersion: 1, type: AGENT_PROFILE_TYPE, id, name: id, model: { provider: "test", id: "m" }, thinkingLevel: "high", promptStack: null };
}

test("prompt-stack repository write/overwrite/delete replacement semantics", () => {
	const cwd = tempCwd();
	try {
		const target = promptStackTargetPath(cwd, "project", "alpha");
		const first = writePromptStackFile(cwd, "project", target, stack("alpha"), { overwrite: false });
		assert.equal(first.ok, true);
		assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(stack("alpha"), null, 2)}\n`);

		const collision = writePromptStackFile(cwd, "project", target, stack("alpha-v2"), { overwrite: false });
		assert.deepEqual(collision, { ok: false, reason: "exists", error: `Prompt stack already exists: ${target}` });

		const replaced = writePromptStackFile(cwd, "project", target, stack("alpha-v2"), { overwrite: true });
		assert.equal(replaced.ok, true);
		assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(stack("alpha-v2"), null, 2)}\n`);

		const deleted = deletePromptStackFile(cwd, "project", target);
		assert.equal(deleted.ok, true);
		assert.equal(existsSync(target), false);

		const missing = deletePromptStackFile(cwd, "project", target);
		assert.deepEqual(missing, { ok: false, reason: "missing", error: `Prompt stack does not exist: ${target}` });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("prompt-stack repository refuses writes outside scope storage", () => {
	const cwd = tempCwd();
	try {
		const escaped = join(cwd, ".pi", "forge", "prompt-stacks", "..", "..", "evil.json");
		const outside = writePromptStackFile(cwd, "project", escaped, stack("evil"), { overwrite: true });
		assert.equal(outside.ok, false);
		assert.equal(outside.reason, "invalid-path");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent-profile repository write/overwrite/delete replacement semantics", () => {
	const cwd = tempCwd();
	try {
		const target = agentProfileTargetPath(cwd, "project", "worker");
		const first = writeAgentProfileFile(cwd, "project", target, profile("worker"), { overwrite: false });
		assert.equal(first.ok, true);
		assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(profile("worker"), null, 2)}\n`);

		const collision = writeAgentProfileFile(cwd, "project", target, profile("worker"), { overwrite: false });
		assert.equal(collision.ok, false);
		assert.equal(collision.reason, "exists");

		const replaced = writeAgentProfileFile(cwd, "project", target, profile("worker-v2"), { overwrite: true });
		assert.equal(replaced.ok, true);
		assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(profile("worker-v2"), null, 2)}\n`);

		const deleted = deleteAgentProfileFile(cwd, "project", target);
		assert.equal(deleted.ok, true);
		assert.equal(existsSync(target), false);

		const missing = deleteAgentProfileFile(cwd, "project", target);
		assert.equal(missing.ok, false);
		assert.equal(missing.reason, "missing");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent-profile repository refuses writes outside scope storage", () => {
	const cwd = tempCwd();
	try {
		const escaped = join(cwd, ".pi", "forge", "agent-profiles", "..", "..", "evil.json");
		const outside = writeAgentProfileFile(cwd, "project", escaped, profile("evil"), { overwrite: true });
		assert.equal(outside.ok, false);
		assert.equal(outside.reason, "invalid-path");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("prompt-stack repository supports global scope", () => {
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-repo-global-"));
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		const target = promptStackTargetPath("/unused", "global", "global-stack");
		const written = writePromptStackFile("/unused", "global", target, stack("global-stack"), { overwrite: false });
		assert.equal(written.ok, true);
		assert.ok(target.startsWith(join(globalDir, "prompt-stacks")));
		assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(stack("global-stack"), null, 2)}\n`);
		const deleted = deletePromptStackFile("/unused", "global", target);
		assert.equal(deleted.ok, true);
	} finally {
		delete process.env[GLOBAL_FORGE_DIR_ENV];
		if (original !== undefined) process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("prompt-stack repository refuses writes/deletes through a symlink", () => {
	const cwd = tempCwd();
	try {
		const outside = join(cwd, "outside.txt");
		writeFileSync(outside, "x", "utf8");
		mkdirSync(join(cwd, ".pi", "forge", "prompt-stacks"), { recursive: true });
		const link = join(cwd, ".pi", "forge", "prompt-stacks", "link.json");
		symlinkSync(outside, link);

		const write = writePromptStackFile(cwd, "project", link, stack("link"), { overwrite: true });
		assert.equal(write.ok, false);
		assert.equal(write.reason, "invalid-path");

		const deleted = deletePromptStackFile(cwd, "project", link);
		assert.equal(deleted.ok, false);
		assert.equal(deleted.reason, "invalid-path");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent-profile repository supports global scope", () => {
	const original = process.env[GLOBAL_FORGE_DIR_ENV];
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-repo-global-profile-"));
	process.env[GLOBAL_FORGE_DIR_ENV] = globalDir;
	try {
		const target = agentProfileTargetPath("/unused", "global", "global-worker");
		const written = writeAgentProfileFile("/unused", "global", target, profile("global-worker"), { overwrite: false });
		assert.equal(written.ok, true);
		assert.ok(target.startsWith(join(globalDir, "agent-profiles")));
		assert.equal(readFileSync(target, "utf8"), `${JSON.stringify(profile("global-worker"), null, 2)}\n`);
		const deleted = deleteAgentProfileFile("/unused", "global", target);
		assert.equal(deleted.ok, true);
	} finally {
		delete process.env[GLOBAL_FORGE_DIR_ENV];
		if (original !== undefined) process.env[GLOBAL_FORGE_DIR_ENV] = original;
		rmSync(globalDir, { recursive: true, force: true });
	}
});

test("agent-profile repository refuses writes/deletes through a symlink", () => {
	const cwd = tempCwd();
	try {
		const outside = join(cwd, "outside.txt");
		writeFileSync(outside, "x", "utf8");
		mkdirSync(join(cwd, ".pi", "forge", "agent-profiles"), { recursive: true });
		const link = join(cwd, ".pi", "forge", "agent-profiles", "link.json");
		symlinkSync(outside, link);

		const write = writeAgentProfileFile(cwd, "project", link, profile("link"), { overwrite: true });
		assert.equal(write.ok, false);
		assert.equal(write.reason, "invalid-path");

		const deleted = deleteAgentProfileFile(cwd, "project", link);
		assert.equal(deleted.ok, false);
		assert.equal(deleted.reason, "invalid-path");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("web-host stack mutation failure maps to HTTP status codes", () => {
	assert.equal(stackMutationStatus("invalid-path"), 403);
	assert.equal(stackMutationStatus("exists"), 409);
	assert.equal(stackMutationStatus("missing"), 404);
	assert.equal(stackMutationStatus("io"), 500);
});

test("legacy stack migration copies normal files and refuses symlinked paths", () => {
	const cwd = tempCwd();
	try {
		const legacyDir = join(cwd, ".pi", "prompt-stacks");
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "ok.json"), JSON.stringify({ id: "ok" }), "utf8");
		const outside = join(cwd, "outside.txt");
		writeFileSync(outside, "x", "utf8");
		const link = join(legacyDir, "evil.json");
		symlinkSync(outside, link);

		const report = migrateLegacyPromptStacks(cwd, {});
		assert.equal(report.copied, 1);
		assert.equal(report.errors, 1);
		assert.ok(report.files.some((file) => file.name === "evil.json" && file.action === "error"));
		assert.ok(report.files.some((file) => file.name === "ok.json" && file.action === "copy"));
		assert.equal(existsSync(join(cwd, ".pi", "forge", "prompt-stacks", "ok.json")), true);
		assert.equal(existsSync(join(cwd, ".pi", "forge", "prompt-stacks", "evil.json")), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("repository writes stay byte-stable through the codec parser", () => {
	const cwd = tempCwd();
	try {
		const stackTarget = promptStackTargetPath(cwd, "project", "alpha");
		writePromptStackFile(cwd, "project", stackTarget, stack("alpha"), { overwrite: false });
		const parsed = parsePromptStack(readFileSync(stackTarget, "utf8"), stackTarget, "project");
		assert.equal(parsed.stack.id, "alpha");
		assert.equal(serializePromptStack(parsed.stack), serializePromptStack(stack("alpha")));

		const profileTarget = agentProfileTargetPath(cwd, "project", "worker");
		writeAgentProfileFile(cwd, "project", profileTarget, profile("worker"), { overwrite: false });
		const parsedProfile = parseAgentProfile(readFileSync(profileTarget, "utf8"), profileTarget, "project");
		assert.equal(parsedProfile.profile.id, "worker");
		assert.equal(serializeAgentProfile(parsedProfile.profile), serializeAgentProfile(profile("worker")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
