import assert from "node:assert/strict";
import fs, {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createResourceCatalog } from "../src/catalog.ts";
import {
	CAPABILITY_TYPE,
	isUsableCapability,
} from "../src/codecs/capability.ts";
import {
	capabilitiesDir,
	MAX_CAPABILITY_SOURCE_SIZE,
	readGlobalCapabilities,
	readCapabilitiesScoped,
	readSingleCapabilityFile,
} from "../src/repositories/capability.ts";

function createValidModeJson(id: string, content = `Content for ${id}`): string {
	return JSON.stringify(
		{
			schemaVersion: 1,
			type: CAPABILITY_TYPE,
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
	const globalDir = join(baseDir, "global", "capabilities");
	const projectDir = capabilitiesDir(cwd);

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
		const globalModes = readGlobalCapabilities(env.globalDir);
		assert.deepEqual(globalModes, []);

		const scopedModes = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.deepEqual(scopedModes, []);
	} finally {
		env.cleanup();
	}
});

test("2. scope: readCapabilitiesScoped distinguishes global and project scopes", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.globalDir, { recursive: true });
		mkdirSync(env.projectDir, { recursive: true });

		writeFileSync(join(env.globalDir, "global-capability.json"), createValidModeJson("global-capability"));
		writeFileSync(join(env.projectDir, "project-capability.json"), createValidModeJson("project-capability"));

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 2);

		const globalLoaded = loaded.find((m) => m.capability.id === "global-capability");
		const projectLoaded = loaded.find((m) => m.capability.id === "project-capability");

		assert.ok(globalLoaded);
		assert.equal(globalLoaded.scope, "global");
		assert.deepEqual(globalLoaded.key, { scope: "global", id: "global-capability" });
		assert.equal(isUsableCapability(globalLoaded), true);

		assert.ok(projectLoaded);
		assert.equal(projectLoaded.scope, "project");
		assert.deepEqual(projectLoaded.key, { scope: "project", id: "project-capability" });
		assert.equal(isUsableCapability(projectLoaded), true);
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

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 3);
		assert.equal(loaded[0]?.capability.id, "alpha");
		assert.equal(loaded[1]?.capability.id, "middle");
		assert.equal(loaded[2]?.capability.id, "zebra");
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

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0]?.capability.id, "valid");
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
		const padding = "x".repeat(MAX_CAPABILITY_SOURCE_SIZE + 100);
		writeFileSync(oversizedFilePath, `{"schemaVersion":1,"content":"${padding}"}`);

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 1);
		assert.equal(isUsableCapability(loaded[0]!), false);
		assert.ok(
			loaded[0]!.diagnostics.some(
				(d) => d.level === "error" && d.message.includes("1MiB limit"),
			),
		);
	} finally {
		env.cleanup();
	}
});

test("6. invalid local保留: corrupted local JSON is retained as fault to shadow global capability", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.globalDir, { recursive: true });
		mkdirSync(env.projectDir, { recursive: true });

		// Global has valid reviewer capability
		writeFileSync(join(env.globalDir, "reviewer.json"), createValidModeJson("reviewer", "Global reviewer instructions"));

		// Project has corrupted reviewer capability (broken JSON)
		writeFileSync(join(env.projectDir, "reviewer.json"), "INVALID { JSON NOT CLOSED");

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 2);

		const globalMode = loaded.find((m) => m.scope === "global");
		const projectMode = loaded.find((m) => m.scope === "project");

		assert.ok(globalMode);
		assert.equal(isUsableCapability(globalMode), true);

		assert.ok(projectMode);
		assert.equal(isUsableCapability(projectMode), false);
		assert.equal(projectMode.capability.id, "reviewer");
		assert.ok(projectMode.diagnostics.some((d) => d.level === "error" && d.message.includes("JSON")));

		// In resolution catalog, project shadows global: effective resolution returns project fault, not global fallback
		const catalog = createResourceCatalog(loaded);
		const effective = catalog.resolveEffective("reviewer");
		assert.ok(effective);
		assert.equal(effective.scope, "project");
		assert.equal(isUsableCapability(effective), false);
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

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 2);

		for (const capability of loaded) {
			assert.equal(isUsableCapability(capability), false);
			assert.ok(
				capability.diagnostics.some(
					(d) =>
						d.level === "error" &&
						d.message.includes("Duplicate project capability id") &&
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

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 2);

		const globalHelper = loaded.find((m) => m.scope === "global");
		const projectHelper = loaded.find((m) => m.scope === "project");

		assert.ok(globalHelper && isUsableCapability(globalHelper));
		assert.ok(projectHelper && isUsableCapability(projectHelper));

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
		assert.equal(effective.capability.content, "Project helper");
	} finally {
		env.cleanup();
	}
});

// Synchronous, path-specific mocks stay inside this test process. Synchronize
// named builtin imports both after replacement and after restoration.
for (const code of ["EACCES", "EPERM"] as const) {
	test(`9. unreadable path (${code}): unreadable directory throws Error fail-closed instead of returning []`, (t) => {
		const env = setupTestEnv();
		mkdirSync(env.projectDir, { recursive: true });
		const fixtureFile = join(env.projectDir, "fixture.json");
		writeFileSync(fixtureFile, createValidModeJson("fixture"));

		const denied = Object.assign(new Error(`${code}: probe access denied`), { code });
		const originalReaddirSync = fs.readdirSync;
		try {
			t.mock.method(fs, "readdirSync", (...args: unknown[]) => {
				if (String(args[0]) === env.projectDir) throw denied;
				return Reflect.apply(originalReaddirSync, fs, args);
			});
			syncBuiltinESMExports();

			assert.throws(
				() => {
					readCapabilitiesScoped(env.cwd, env.globalDir);
				},
				(err: unknown) => err === denied,
			);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			try {
				const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
				assert.equal(loaded.length, 1);
				assert.equal(loaded[0]?.capability.id, "fixture");
				assert.equal(isUsableCapability(loaded[0]!), true);
			} finally {
				env.cleanup();
			}
		}
	});
}

for (const code of ["EACCES", "EPERM"] as const) {
	test(`10. unreadable file (${code}): unreadable file inside readable directory is retained as fault`, (t) => {
		const env = setupTestEnv();
		mkdirSync(env.projectDir, { recursive: true });
		const unreadableFile = join(env.projectDir, "no-read.json");
		writeFileSync(unreadableFile, createValidModeJson("no-read"));

		const denied = Object.assign(new Error(`${code}: probe access denied`), { code });
		const originalReadFileSync = fs.readFileSync;
		try {
			t.mock.method(fs, "readFileSync", (...args: unknown[]) => {
				if (String(args[0]) === unreadableFile) throw denied;
				return Reflect.apply(originalReadFileSync, fs, args);
			});
			syncBuiltinESMExports();

			const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
			assert.equal(loaded.length, 1);
			assert.equal(loaded[0]?.capability.id, "no-read");
			assert.equal(isUsableCapability(loaded[0]!), false);
			assert.ok(
				loaded[0]!.diagnostics.some(
					(d) =>
						d.level === "error" &&
						d.message.includes("Failed to read capability") &&
						d.message.includes(code),
				),
			);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			try {
				const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
				assert.equal(loaded.length, 1);
				assert.equal(loaded[0]?.capability.id, "no-read");
				assert.equal(isUsableCapability(loaded[0]!), true);
			} finally {
				env.cleanup();
			}
		}
	});
}

test("11. symlink handling: follows symlinks to valid instruction capability files", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.projectDir, { recursive: true });
		const externalFile = join(env.baseDir, "external-target.json");
		writeFileSync(externalFile, createValidModeJson("linked-capability", "Capabilities from linked file"));

		const linkPath = join(env.projectDir, "linked-capability.json");
		symlinkSync(externalFile, linkPath);

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 1);
		assert.equal(loaded[0]?.capability.id, "linked-capability");
		assert.equal(loaded[0]?.capability.content, "Capabilities from linked file");
		assert.equal(isUsableCapability(loaded[0]!), true);
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
			type: CAPABILITY_TYPE,
			id: "safe-payload",
			name: "Safe Payload",
			description: "<script>alert('xss')</script>",
			content: "eval('process.exit(1)'); ${7*7} `rm -rf /`",
			tools: { add: [], remove: [] },
			__proto__: { polluted: "yes" },
		});

		writeFileSync(join(env.projectDir, "safe-payload.json"), maliciousPayload);

		const loaded = readCapabilitiesScoped(env.cwd, env.globalDir);
		assert.equal(loaded.length, 1);
		assert.equal(isUsableCapability(loaded[0]!), true);
		assert.equal(loaded[0]?.capability.content, "eval('process.exit(1)'); ${7*7} `rm -rf /`");
		assert.equal(loaded[0]?.capability.description, "<script>alert('xss')</script>");

		// Prototype pollution check
		assert.equal(({} as any).polluted, undefined);
	} finally {
		env.cleanup();
	}
});

test("13. readSingleCapabilityFile directly reads file with given scope", () => {
	const env = setupTestEnv();
	try {
		mkdirSync(env.globalDir, { recursive: true });
		const filePath = join(env.globalDir, "standalone.json");
		writeFileSync(filePath, createValidModeJson("standalone"));

		const loaded = readSingleCapabilityFile(filePath, "global");
		assert.equal(loaded.scope, "global");
		assert.equal(loaded.capability.id, "standalone");
		assert.equal(isUsableCapability(loaded), true);
	} finally {
		env.cleanup();
	}
});
