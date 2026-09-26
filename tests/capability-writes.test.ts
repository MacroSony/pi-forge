import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CAPABILITY_TYPE,
	type Capability,
} from "../src/codecs/capability.ts";
import {
	deleteCapabilityFile,
	globalCapabilitiesDir,
	capabilityRevision,
	capabilitiesDir,
	MAX_CAPABILITY_SOURCE_SIZE,
	writeCapabilityFile,
} from "../src/repositories/capability.ts";
import { GLOBAL_FORGE_DIR_ENV } from "../src/storage.ts";

function createValidMode(id: string, content = `Capabilities for ${id}`): Capability {
	return {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id,
		name: `Name ${id}`,
		description: `Description ${id}`,
		content,
		tools: { add: ["read_file"], remove: [] },
	};
}

function setupTestEnv() {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-forge-inst-writes-"));
	const cwd = join(baseDir, "project");
	const globalDir = join(baseDir, "global-forge");
	mkdirSync(capabilitiesDir(cwd), { recursive: true });

	function cleanup() {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	}

	return { baseDir, cwd, globalDir, cleanup };
}

// ---------------------------------------------------------------------------
// 1. capabilityRevision
// ---------------------------------------------------------------------------

test("revision: capabilityRevision computes raw sha256 hex and throws missing", () => {
	const env = setupTestEnv();
	try {
		const filePath = join(capabilitiesDir(env.cwd), "rev-test.json");
		const rawBytes = Buffer.from("{\"hello\":\"world\"}\n");
		writeFileSync(filePath, rawBytes);

		const expected = createHash("sha256").update(rawBytes).digest("hex");
		const actual = capabilityRevision(filePath);
		assert.equal(actual, expected);

		// Missing file throws
		assert.throws(
			() => capabilityRevision(join(capabilitiesDir(env.cwd), "missing.json")),
			(err: any) => err.code === "ENOENT",
		);

		// Oversized file > 1MiB throws
		const oversizedPath = join(capabilitiesDir(env.cwd), "oversized.json");
		const bigBuf = Buffer.alloc(MAX_CAPABILITY_SOURCE_SIZE + 10, "x");
		writeFileSync(oversizedPath, bigBuf);
		assert.throws(
			() => capabilityRevision(oversizedPath),
			(err: any) => err.message.includes("1MiB limit"),
		);
	} finally {
		env.cleanup();
	}
});

// ---------------------------------------------------------------------------
// 2. path verification & no arbitrary rename
// ---------------------------------------------------------------------------

test("path: verifies immediate *.json child of exact project/global root, no traversal, no arbitrary rename", () => {
	const env = setupTestEnv();
	try {
		const capability = createValidMode("code-review");
		const validPath = join(capabilitiesDir(env.cwd), "code-review.json");

		// Normal project write succeeds
		const writeRes = writeCapabilityFile(env.cwd, "project", validPath, capability, { overwrite: false });
		assert.deepEqual(writeRes, { ok: true });

		// Non-immediate child (subdirectory) rejected
		const subDir = join(capabilitiesDir(env.cwd), "subdir");
		mkdirSync(subDir, { recursive: true });
		const subPath = join(subDir, "code-review.json");
		const subRes = writeCapabilityFile(env.cwd, "project", subPath, capability, { overwrite: false });
		assert.equal(subRes.ok, false);
		assert.equal(subRes.reason, "invalid-path");

		// Traversal outside scope root rejected
		const outsidePath = join(capabilitiesDir(env.cwd), "..", "code-review.json");
		const outsideRes = writeCapabilityFile(env.cwd, "project", outsidePath, capability, { overwrite: false });
		assert.equal(outsideRes.ok, false);
		assert.equal(outsideRes.reason, "invalid-path");

		// Non-json extension rejected
		const txtPath = join(capabilitiesDir(env.cwd), "code-review.txt");
		const txtRes = writeCapabilityFile(env.cwd, "project", txtPath, capability, { overwrite: false });
		assert.equal(txtRes.ok, false);
		assert.equal(txtRes.reason, "invalid-path");

		// Hidden file rejected
		const hiddenPath = join(capabilitiesDir(env.cwd), ".code-review.json");
		const hiddenRes = writeCapabilityFile(env.cwd, "project", hiddenPath, capability, { overwrite: false });
		assert.equal(hiddenRes.ok, false);
		assert.equal(hiddenRes.reason, "invalid-path");

		// Invalid resource id in filename rejected
		const badIdMode = { ...capability, id: "bad:id" };
		const badIdPath = join(capabilitiesDir(env.cwd), "bad:id.json");
		const badIdRes = writeCapabilityFile(env.cwd, "project", badIdPath, badIdMode, { overwrite: false });
		assert.equal(badIdRes.ok, false);
		assert.equal(badIdRes.reason, "invalid-path");

		// Arbitrary rename rejected: capability.id ("code-review") !== filename ("different.json")
		const differentPath = join(capabilitiesDir(env.cwd), "different.json");
		const renameRes = writeCapabilityFile(env.cwd, "project", differentPath, capability, { overwrite: false });
		assert.equal(renameRes.ok, false);
		assert.equal(renameRes.reason, "invalid-path");

		// Delete also rejects invalid paths
		const delSubRes = deleteCapabilityFile(env.cwd, "project", subPath, { expectedSourceRevision: "dummy" });
		assert.equal(delSubRes.ok, false);
		assert.equal(delSubRes.reason, "invalid-path");

		const delTxtRes = deleteCapabilityFile(env.cwd, "project", txtPath, { expectedSourceRevision: "dummy" });
		assert.equal(delTxtRes.ok, false);
		assert.equal(delTxtRes.reason, "invalid-path");
	} finally {
		env.cleanup();
	}
});

// ---------------------------------------------------------------------------
// 3. trust not repo responsibility
// ---------------------------------------------------------------------------

test("trust: repository writes and deletes without checking workspace trust", () => {
	const env = setupTestEnv();
	try {
		// An untrusted or random directory succeeds directly at the repository layer
		const untrustedCwd = join(env.baseDir, "untrusted-project");
		const target = join(capabilitiesDir(untrustedCwd), "untrusted-capability.json");
		const capability = createValidMode("untrusted-capability");

		const writeRes = writeCapabilityFile(untrustedCwd, "project", target, capability, { overwrite: false });
		assert.deepEqual(writeRes, { ok: true });
		assert.equal(existsSync(target), true);

		const rev = capabilityRevision(target);
		const delRes = deleteCapabilityFile(untrustedCwd, "project", target, { expectedSourceRevision: rev });
		assert.deepEqual(delRes, { ok: true });
		assert.equal(existsSync(target), false);
	} finally {
		env.cleanup();
	}
});

// ---------------------------------------------------------------------------
// 4. global temp env
// ---------------------------------------------------------------------------

test("global: respects GLOBAL_FORGE_DIR_ENV for global scope writes and deletes", () => {
	const env = setupTestEnv();
	const prevEnv = process.env[GLOBAL_FORGE_DIR_ENV];
	process.env[GLOBAL_FORGE_DIR_ENV] = env.globalDir;
	try {
		const target = join(globalCapabilitiesDir(), "global-capability.json");
		const capability = createValidMode("global-capability");

		const writeRes = writeCapabilityFile("/irrelevant", "global", target, capability, { overwrite: false });
		assert.deepEqual(writeRes, { ok: true });
		assert.ok(target.startsWith(join(env.globalDir, "capabilities")));
		assert.equal(existsSync(target), true);

		// Scoped mismatch: calling with scope "project" on global path is rejected
		const mismatchRes = writeCapabilityFile("/irrelevant", "project", target, capability, { overwrite: false });
		assert.equal(mismatchRes.ok, false);
		assert.equal(mismatchRes.reason, "invalid-path");

		const rev = capabilityRevision(target);
		const delRes = deleteCapabilityFile("/irrelevant", "global", target, { expectedSourceRevision: rev });
		assert.deepEqual(delRes, { ok: true });
		assert.equal(existsSync(target), false);
	} finally {
		if (prevEnv !== undefined) {
			process.env[GLOBAL_FORGE_DIR_ENV] = prevEnv;
		} else {
			delete process.env[GLOBAL_FORGE_DIR_ENV];
		}
		env.cleanup();
	}
});

// ---------------------------------------------------------------------------
// 5. symlinks (target, broken target, root, traversal)
// ---------------------------------------------------------------------------

test("symlink: rejects target symlinks (including broken symlinks), root symlinks, and traversal symlinks", () => {
	const env = setupTestEnv();
	try {
		const outsideFile = join(env.baseDir, "outside.json");
		writeFileSync(outsideFile, "{}");

		const capability = createValidMode("symlink-capability");

		// 1. Target symlink to existing file
		const linkTarget = join(capabilitiesDir(env.cwd), "symlink-capability.json");
		symlinkSync(outsideFile, linkTarget);

		const writeLink = writeCapabilityFile(env.cwd, "project", linkTarget, capability, { overwrite: true, expectedSourceRevision: "foo" });
		assert.equal(writeLink.ok, false);
		assert.equal(writeLink.reason, "invalid-path");

		const delLink = deleteCapabilityFile(env.cwd, "project", linkTarget, { expectedSourceRevision: "foo" });
		assert.equal(delLink.ok, false);
		assert.equal(delLink.reason, "invalid-path");

		rmSync(linkTarget);

		// 2. Broken symlink target
		const brokenTarget = join(capabilitiesDir(env.cwd), "broken-capability.json");
		const brokenMode = createValidMode("broken-capability");
		symlinkSync(join(env.baseDir, "non-existent-target.json"), brokenTarget);
		assert.equal(lstatSync(brokenTarget).isSymbolicLink(), true);

		const writeBroken = writeCapabilityFile(env.cwd, "project", brokenTarget, brokenMode, { overwrite: false });
		assert.equal(writeBroken.ok, false);
		assert.equal(writeBroken.reason, "invalid-path");

		const delBroken = deleteCapabilityFile(env.cwd, "project", brokenTarget, { expectedSourceRevision: "foo" });
		assert.equal(delBroken.ok, false);
		assert.equal(delBroken.reason, "invalid-path");

		rmSync(brokenTarget);

		// 3. Root directory is a symlink
		const altDir = join(env.baseDir, "alt-modes");
		mkdirSync(altDir, { recursive: true });
		const symlinkCwd = join(env.baseDir, "symlink-root-project");
		mkdirSync(join(symlinkCwd, ".pi", "forge"), { recursive: true });
		symlinkSync(altDir, join(symlinkCwd, ".pi", "forge", "capabilities"));

		const rootLinkTarget = join(capabilitiesDir(symlinkCwd), "capability.json");
		const rootLinkMode = createValidMode("capability");
		const writeRootLink = writeCapabilityFile(symlinkCwd, "project", rootLinkTarget, rootLinkMode, { overwrite: false });
		assert.equal(writeRootLink.ok, false);
		assert.equal(writeRootLink.reason, "invalid-path");

		// 4. Traversal symlink: .pi is a symlink
		const altPi = join(env.baseDir, "alt-pi");
		mkdirSync(altPi, { recursive: true });
		const traversalCwd = join(env.baseDir, "traversal-project");
		mkdirSync(traversalCwd, { recursive: true });
		symlinkSync(altPi, join(traversalCwd, ".pi"));

		const traversalTarget = join(capabilitiesDir(traversalCwd), "capability.json");
		const writeTraversal = writeCapabilityFile(traversalCwd, "project", traversalTarget, rootLinkMode, { overwrite: false });
		assert.equal(writeTraversal.ok, false);
		assert.equal(writeTraversal.reason, "invalid-path");
	} finally {
		env.cleanup();
	}
});

// ---------------------------------------------------------------------------
// 6. invalid capability
// ---------------------------------------------------------------------------

test("invalid: parse validation rejects invalid instruction capability payloads", () => {
	const env = setupTestEnv();
	try {
		const filePath = join(capabilitiesDir(env.cwd), "test-capability.json");

		// Invalid schemaVersion
		const badSchema = { ...createValidMode("test-capability"), schemaVersion: 2 as any };
		const badSchemaRes = writeCapabilityFile(env.cwd, "project", filePath, badSchema, { overwrite: false });
		assert.equal(badSchemaRes.ok, false);
		assert.equal(badSchemaRes.reason, "invalid-capability");

		// Invalid type
		const badType = { ...createValidMode("test-capability"), type: "invalid-type" as any };
		const badTypeRes = writeCapabilityFile(env.cwd, "project", filePath, badType, { overwrite: false });
		assert.equal(badTypeRes.ok, false);
		assert.equal(badTypeRes.reason, "invalid-capability");

		// Empty content and empty tools
		const emptyMode = { ...createValidMode("test-capability"), content: "", tools: { add: [], remove: [] } };
		const emptyRes = writeCapabilityFile(env.cwd, "project", filePath, emptyMode, { overwrite: false });
		assert.equal(emptyRes.ok, false);
		assert.equal(emptyRes.reason, "invalid-capability");

		// Invalid tool name (wildcard)
		const badToolMode = { ...createValidMode("test-capability"), tools: { add: ["tool*name"], remove: [] } };
		const badToolRes = writeCapabilityFile(env.cwd, "project", filePath, badToolMode, { overwrite: false });
		assert.equal(badToolRes.ok, false);
		assert.equal(badToolRes.reason, "invalid-capability");
	} finally {
		env.cleanup();
	}
});

// ---------------------------------------------------------------------------
// 7. stale revision conflict (409)
// ---------------------------------------------------------------------------

test("stale: update and delete require expected revision and fail with conflict on mismatch or missing file", () => {
	const env = setupTestEnv();
	try {
		const filePath = join(capabilitiesDir(env.cwd), "stale-test.json");
		const capability = createValidMode("stale-test", "Initial content");

		// Create
		const createRes = writeCapabilityFile(env.cwd, "project", filePath, capability, { overwrite: false });
		assert.deepEqual(createRes, { ok: true });
		const rev1 = capabilityRevision(filePath);

		// Update without expectedSourceRevision returns conflict
		const noRevRes = writeCapabilityFile(env.cwd, "project", filePath, { ...capability, content: "v2" }, { overwrite: true });
		assert.equal(noRevRes.ok, false);
		assert.equal(noRevRes.reason, "conflict");

		// Update with mismatched revision returns conflict
		const badRevRes = writeCapabilityFile(env.cwd, "project", filePath, { ...capability, content: "v2" }, { overwrite: true, expectedSourceRevision: "wrong-rev" });
		assert.equal(badRevRes.ok, false);
		assert.equal(badRevRes.reason, "conflict");

		// File content remains v1
		assert.equal(capabilityRevision(filePath), rev1);

		// Update with correct revision succeeds
		const goodUpdate = writeCapabilityFile(env.cwd, "project", filePath, { ...capability, content: "v2" }, { overwrite: true, expectedSourceRevision: rev1 });
		assert.deepEqual(goodUpdate, { ok: true });
		const rev2 = capabilityRevision(filePath);
		assert.notEqual(rev2, rev1);

		// Delete with stale rev1 returns conflict
		const staleDel = deleteCapabilityFile(env.cwd, "project", filePath, { expectedSourceRevision: rev1 });
		assert.equal(staleDel.ok, false);
		assert.equal(staleDel.reason, "conflict");
		assert.equal(existsSync(filePath), true);

		// Delete missing file returns conflict
		const missingPath = join(capabilitiesDir(env.cwd), "missing.json");
		const delMissing = deleteCapabilityFile(env.cwd, "project", missingPath, { expectedSourceRevision: "some-rev" });
		assert.equal(delMissing.ok, false);
		assert.equal(delMissing.reason, "conflict");

		// Update missing file returns conflict
		const updateMissing = writeCapabilityFile(env.cwd, "project", missingPath, createValidMode("missing"), { overwrite: true, expectedSourceRevision: "some-rev" });
		assert.equal(updateMissing.ok, false);
		assert.equal(updateMissing.reason, "conflict");

		// Delete with matching rev2 succeeds
		const goodDel = deleteCapabilityFile(env.cwd, "project", filePath, { expectedSourceRevision: rev2 });
		assert.deepEqual(goodDel, { ok: true });
		assert.equal(existsSync(filePath), false);
	} finally {
		env.cleanup();
	}
});

// ---------------------------------------------------------------------------
// 8. no overwrite (wx create semantics)
// ---------------------------------------------------------------------------

test("no overwrite: writeCapabilityFile with overwrite: false refuses to clobber existing file", () => {
	const env = setupTestEnv();
	try {
		const filePath = join(capabilitiesDir(env.cwd), "exclusive.json");
		const capability = createValidMode("exclusive", "Original content");

		// First create succeeds
		const first = writeCapabilityFile(env.cwd, "project", filePath, capability, { overwrite: false });
		assert.deepEqual(first, { ok: true });
		const originalRev = capabilityRevision(filePath);

		// Second create with overwrite: false returns conflict
		const second = writeCapabilityFile(env.cwd, "project", filePath, { ...capability, content: "Different content" }, { overwrite: false });
		assert.equal(second.ok, false);
		assert.equal(second.reason, "conflict");

		// Content was not overwritten
		assert.equal(capabilityRevision(filePath), originalRev);
		const raw = readFileSync(filePath, "utf8");
		assert.ok(raw.includes("Original content"));
	} finally {
		env.cleanup();
	}
});
