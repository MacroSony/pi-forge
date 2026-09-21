import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResourceCatalog } from "../src/catalog.ts";
import {
	INSTRUCTION_MODE_TYPE,
	isUsableInstructionMode,
} from "../src/codecs/instruction-mode.ts";
import {
	instructionModesDir,
	MAX_INSTRUCTION_MODE_SOURCE_SIZE,
	readGlobalInstructionModes,
	readInstructionModesScoped,
	readSingleInstructionModeFile,
} from "../src/repositories/instruction-mode.ts";

function createValidModeJson(id: string, content = `Content for ${id}`): string {
	return JSON.stringify(
		{
			schemaVersion: 1,
			type: INSTRUCTION_MODE_TYPE,
			id,
			name: `Name for ${id}`,
			description: `Description for ${id}`,
			content,
			tools: { add: [], remove: [] },
		},
		null,
		2,
	);
}

function setupTestEnv() {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-forge-repo-test-"));
	const cwd = join(baseDir, "project");
	const globalDir = join(baseDir, "global", "instruction-modes");
	const projectDir = instructionModesDir(cwd);

	function cleanup() {
		try {
			rmSync(baseDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	}

	return { baseDir, cwd, globalDir, projectDir, cleanup };
}

test("1. missing directory returns empty array without throwing", () => {
	const env = setupTestEnv();
	try {
		// Neither globalDir nor projectDir exists
		const globalModes = readGlobalInstructionModes(env.globalDir);
		assert.deepEqual(globalModes, []);

		const scopedModes = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.deepEqual(scopedModes, []);
	} finally {
		env.cleanup();
	}
});

test("2. scope: readInstructionModesScoped distinguishes global and project scopes", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.globalDir, { recursive: true });
		mkdirSync(env.projectDir, { recursive: true });

		writeFileSync(join(env.globalDir, "global-mode.json"), createValidModeJson("global-mode"));
		writeFileSync(join(env.projectDir, "project-mode.json"), createValidModeJson("project-mode"));

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 2);

		const globalLoaded = loaded.find((m) => m.mode.id === "global-mode");
		const projectLoaded = loaded.find((m) => m.mode.id === "project-mode");

		assert.ok(globalLoaded);
		assert.equal(globalLoaded.scope, "global");
		assert.deepEqual(globalLoaded.key, { scope: "global", id: "global-mode" });
		assert.equal(isUsableInstructionMode(globalLoaded), true);

		assert.ok(projectLoaded);
		assert.equal(projectLoaded.scope, "project");
		assert.deepEqual(projectLoaded.key, { scope: "project", id: "project-mode" });
		assert.equal(isUsableInstructionMode(projectLoaded), true);
	} finally {
		env.cleanup();
	}
});

test("3. sorting: directory entries are discovered in alphabetical filename order", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.projectDir, { recursive: true });

		// Write files in non-sorted order
		writeFileSync(join(env.projectDir, "zebra.json"), createValidModeJson("zebra"));
		writeFileSync(join(env.projectDir, "alpha.json"), createValidModeJson("alpha"));
		writeFileSync(join(env.projectDir, "middle.json"), createValidModeJson("middle"));

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 3);
		assert.equal(loaded[0]?.mode.id, "alpha");
		assert.equal(loaded[1]?.mode.id, "middle");
		assert.equal(loaded[2]?.mode.id, "zebra");
	} finally {
		env.cleanup();
	}
});

test("4. onlyjson: ignores non-json files, subdirectories, and nested folders", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.projectDir, { recursive: true });

		// Valid json file
		writeFileSync(join(env.projectDir, "valid.json"), createValidModeJson("valid"));

		// Non-json files
		writeFileSync(join(env.projectDir, "readme.md"), "# Documentation");
		writeFileSync(join(env.projectDir, "notes.txt"), "some notes");
		writeFileSync(join(env.projectDir, "valid.json.bak"), createValidModeJson("backup"));
		writeFileSync(join(env.projectDir, ".hidden.json"), createValidModeJson("hidden"));

		// Subdirectories (even one named with .json extension)
		mkdirSync(join(env.projectDir, "subdir"));
		mkdirSync(join(env.projectDir, "nested.json"));
		writeFileSync(join(env.projectDir, "subdir", "sub-valid.json"), createValidModeJson("sub-valid"));

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0]?.mode.id, "valid");
	} finally {
		env.cleanup();
	}
});

test("5. oversized: files exceeding 1MiB produce a fault and are unusable", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.projectDir, { recursive: true });

		// Construct oversized file > 1MiB
		const oversizedFilePath = join(env.projectDir, "oversized.json");
		const padding = "x".repeat(MAX_INSTRUCTION_MODE_SOURCE_SIZE + 100);
		writeFileSync(oversizedFilePath, `{"schemaVersion":1,"content":"${padding}"}`);

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 1);
		assert.equal(isUsableInstructionMode(loaded[0]!), false);
		assert.ok(
			loaded[0]!.diagnostics.some(
				(d) => d.level === "error" && d.message.includes("1MiB limit"),
			),
		);
	} finally {
		env.cleanup();
	}
});

test("6. invalid local保留: corrupted local JSON is retained as fault to shadow global mode", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.globalDir, { recursive: true });
		mkdirSync(env.projectDir, { recursive: true });

		// Global has valid reviewer mode
		writeFileSync(join(env.globalDir, "reviewer.json"), createValidModeJson("reviewer", "Global reviewer instructions"));

		// Project has corrupted reviewer mode (broken JSON)
		writeFileSync(join(env.projectDir, "reviewer.json"), "INVALID { JSON NOT CLOSED");

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 2);

		const globalMode = loaded.find((m) => m.scope === "global");
		const projectMode = loaded.find((m) => m.scope === "project");

		assert.ok(globalMode);
		assert.equal(isUsableInstructionMode(globalMode), true);

		assert.ok(projectMode);
		assert.equal(isUsableInstructionMode(projectMode), false);
		assert.equal(projectMode.mode.id, "reviewer");
		assert.ok(projectMode.diagnostics.some((d) => d.level === "error" && d.message.includes("JSON")));

		// In resolution catalog, project shadows global: effective resolution returns project fault, not global fallback
		const catalog = createResourceCatalog(loaded);
		const effective = catalog.resolveEffective("reviewer");
		assert.ok(effective);
		assert.equal(effective.scope, "project");
		assert.equal(isUsableInstructionMode(effective), false);
	} finally {
		env.cleanup();
	}
});

test("7. duplicate: duplicate id in the same scope marks all duplicates with error diagnostics", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.projectDir, { recursive: true });

		// Two project files defining the same id
		writeFileSync(join(env.projectDir, "file-a.json"), createValidModeJson("duplicate-id"));
		writeFileSync(join(env.projectDir, "file-b.json"), createValidModeJson("duplicate-id"));

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 2);

		for (const mode of loaded) {
			assert.equal(isUsableInstructionMode(mode), false);
			assert.ok(
				mode.diagnostics.some(
					(d) =>
						d.level === "error" &&
						d.message.includes("Duplicate project instruction mode id") &&
						d.message.includes("duplicate-id"),
				),
			);
		}

		// Ambiguous project scope fails closed in catalog resolution
		const catalog = createResourceCatalog(loaded);
		const effective = catalog.resolveEffective("duplicate-id");
		assert.equal(effective, undefined);
	} finally {
		env.cleanup();
	}
});

test("8. duplicate across scopes: project-over-global with same id is valid shadowing, not duplicate error", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.globalDir, { recursive: true });
		mkdirSync(env.projectDir, { recursive: true });

		writeFileSync(join(env.globalDir, "helper.json"), createValidModeJson("helper", "Global helper"));
		writeFileSync(join(env.projectDir, "helper.json"), createValidModeJson("helper", "Project helper"));

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 2);

		const globalHelper = loaded.find((m) => m.scope === "global");
		const projectHelper = loaded.find((m) => m.scope === "project");

		assert.ok(globalHelper && isUsableInstructionMode(globalHelper));
		assert.ok(projectHelper && isUsableInstructionMode(projectHelper));

		// Neither has duplicate diagnostic
		assert.equal(
			loaded.some((m) => m.diagnostics.some((d) => d.message.includes("Duplicate"))),
			false,
		);

		// Project effectively shadows global
		const catalog = createResourceCatalog(loaded);
		const effective = catalog.resolveEffective("helper");
		assert.ok(effective);
		assert.equal(effective.scope, "project");
		assert.equal(effective.mode.content, "Project helper");
	} finally {
		env.cleanup();
	}
});

test("9. unreadable path: unreadable directory throws Error fail-closed instead of returning []", () => {
	const env = setupTestEnv();
	mkdirSync(env.projectDir, { recursive: true });
	try {
		chmodSync(env.projectDir, 0o000);

		assert.throws(
			() => {
				readInstructionModesScoped(env.cwd, env.globalDir);
			},
			(err: any) => {
				return err instanceof Error && (err.message.includes("permission") || (err as any).code === "EACCES");
			},
		);
	} finally {
		try {
			chmodSync(env.projectDir, 0o755);
		} catch {
			// ignore
		}
		env.cleanup();
	}
});

test("10. unreadable file: unreadable file inside readable directory is retained as fault", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.projectDir, { recursive: true });
		const unreadableFile = join(env.projectDir, "no-read.json");
		writeFileSync(unreadableFile, createValidModeJson("no-read"));
		chmodSync(unreadableFile, 0o000);

		try {
			const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
			assert.equal(loaded.length, 1);
			assert.equal(loaded[0]?.mode.id, "no-read");
			assert.equal(isUsableInstructionMode(loaded[0]!), false);
			assert.ok(
				loaded[0]!.diagnostics.some(
					(d) => d.level === "error" && d.message.includes("Failed to read instruction mode"),
				),
			);
		} finally {
			chmodSync(unreadableFile, 0o644);
		}
	} finally {
		env.cleanup();
	}
});

test("11. symlink handling: follows symlinks to valid instruction mode files", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.projectDir, { recursive: true });
		const externalFile = join(env.baseDir, "external-target.json");
		writeFileSync(externalFile, createValidModeJson("linked-mode", "Instructions from linked file"));

		const linkPath = join(env.projectDir, "linked-mode.json");
		symlinkSync(externalFile, linkPath);

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0]?.mode.id, "linked-mode");
		assert.equal(loaded[0]?.mode.content, "Instructions from linked file");
		assert.equal(isUsableInstructionMode(loaded[0]!), true);
	} finally {
		env.cleanup();
	}
});

test("12. 数据不被执行: executable code, script tags, and prototype pollution are treated strictly as data", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.projectDir, { recursive: true });

		const maliciousPayload = JSON.stringify({
			schemaVersion: 1,
			type: INSTRUCTION_MODE_TYPE,
			id: "safe-payload",
			name: "Safe Payload",
			description: "<script>alert('xss')</script>",
			content: "eval('process.exit(1)'); ${7*7} `rm -rf /`",
			tools: { add: [], remove: [] },
			__proto__: { polluted: "yes" },
		});

		writeFileSync(join(env.projectDir, "safe-payload.json"), maliciousPayload);

		const loaded = readInstructionModesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 1);
		assert.equal(isUsableInstructionMode(loaded[0]!), true);
		assert.equal(loaded[0]?.mode.content, "eval('process.exit(1)'); ${7*7} `rm -rf /`");
		assert.equal(loaded[0]?.mode.description, "<script>alert('xss')</script>");

		// Prototype pollution check
		assert.equal(({} as any).polluted, undefined);
	} finally {
		env.cleanup();
	}
});

test("13. readSingleInstructionModeFile directly reads file with given scope", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.globalDir, { recursive: true });
		const filePath = join(env.globalDir, "standalone.json");
		writeFileSync(filePath, createValidModeJson("standalone"));

		const loaded = readSingleInstructionModeFile(filePath, "global");
		assert.equal(loaded.scope, "global");
		assert.equal(loaded.mode.id, "standalone");
		assert.equal(isUsableInstructionMode(loaded), true);
	} finally {
		env.cleanup();
	}
});
