import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_SUBAGENT_BACKEND_ID,
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	GLOBAL_FORGE_CONFIG_PATH_ENV,
	isValidSubagentTimeoutMs,
	loadForgeSubagentSettings,
	resolveSubagentBackend,
	resolveSubagentProfilePolicy,
} from "../src/forge-config.ts";

// Hermetic default: no real user global config leaks into these tests.
process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = join(tmpdir(), "pi-forge-config-test-no-global.json");

test("subagent unattended invocation is explicit, trusted, and fail-closed", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-config-"));
	const configDir = join(cwd, ".pi", "forge");
	const configPath = join(configDir, "config.json");
	mkdirSync(configDir, { recursive: true });
	try {
		assert.equal(loadForgeSubagentSettings(context(cwd, true)).allowAgentInvocationWithoutApproval, false);

		writeFileSync(configPath, JSON.stringify({ subagents: { allowAgentInvocationWithoutApproval: true } }), "utf8");
		const enabled = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(enabled.allowAgentInvocationWithoutApproval, true);
		assert.deepEqual(enabled.warnings, []);
		assert.equal(loadForgeSubagentSettings(context(cwd, false)).allowAgentInvocationWithoutApproval, false);

		writeFileSync(configPath, JSON.stringify({ subagents: { allowAgentInvocationWithoutApproval: "yes" } }), "utf8");
		const malformed = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(malformed.allowAgentInvocationWithoutApproval, false);
		assert.match(malformed.warnings[0] ?? "", /must be boolean/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent backend defaults layer global, trusted project, and explicit overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-forge-backend-config-"));
	const globalConfigPath = join(root, "global", "config.json");
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	mkdirSync(join(root, "global"), { recursive: true });
	const previousEnv = process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
	process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = globalConfigPath;
	try {
		// No config anywhere: built-in default, no warnings.
		const bare = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(bare.backend, undefined);
		assert.deepEqual(resolveSubagentBackend(bare), { id: DEFAULT_SUBAGENT_BACKEND_ID, source: "built-in" });

		// Global config supplies the default for any project.
		writeFileSync(globalConfigPath, JSON.stringify({ subagents: { backend: "global-backend" } }), "utf8");
		const globalOnly = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(globalOnly.backend, "global-backend");
		assert.equal(globalOnly.backendSource, "global");
		assert.deepEqual(resolveSubagentBackend(globalOnly), { id: "global-backend", source: "global" });

		// A trusted project config wins over the global config.
		writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify({ subagents: { backend: "project-backend" } }), "utf8");
		const project = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(project.backend, "project-backend");
		assert.equal(project.backendSource, "project");
		assert.deepEqual(resolveSubagentBackend(project), { id: "project-backend", source: "project" });

		// An untrusted project config is ignored; the global default still applies.
		const untrusted = loadForgeSubagentSettings(context(cwd, false));
		assert.equal(untrusted.backend, "global-backend");
		assert.equal(untrusted.allowAgentInvocationWithoutApproval, false);

		// A per-run explicit override beats every configuration layer.
		assert.deepEqual(resolveSubagentBackend(project, "run-backend"), { id: "run-backend", source: "explicit" });

		// Malformed values warn and are ignored without discarding other layers.
		writeFileSync(globalConfigPath, JSON.stringify({ subagents: { backend: 42 } }), "utf8");
		const malformed = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(malformed.backend, "project-backend");
		assert.match(malformed.warnings.join("\n"), /subagents\.backend must be a non-empty string/);
		writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify({ subagents: { backend: "  " } }), "utf8");
		const empty = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(empty.backend, undefined);
		assert.match(empty.warnings.join("\n"), /subagents\.backend must be a non-empty string/);
	} finally {
		if (previousEnv === undefined) delete process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
		else process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = previousEnv;
		rmSync(root, { recursive: true, force: true });
	}
});

test("subagent timeout config layers global, trusted-project, and validated fallback values", () => {
	assert.equal(isValidSubagentTimeoutMs(1_000), true);
	assert.equal(isValidSubagentTimeoutMs(3_600_000), true);
	assert.equal(isValidSubagentTimeoutMs(999), false);
	assert.equal(isValidSubagentTimeoutMs(3_600_001), false);
	assert.equal(isValidSubagentTimeoutMs(60_000.5), false);

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-timeout-config-"));
	const globalConfigPath = join(cwd, "global-config.json");
	const projectConfigDir = join(cwd, ".pi", "forge");
	const projectConfigPath = join(projectConfigDir, "config.json");
	const previousGlobalPath = process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
	process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = globalConfigPath;
	mkdirSync(projectConfigDir, { recursive: true });

	try {
		const defaults = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(defaults.timeoutMs, DEFAULT_SUBAGENT_TIMEOUT_MS);
		assert.equal(defaults.timeoutSource, "built-in");

		writeFileSync(globalConfigPath, JSON.stringify({ subagents: { timeoutMs: 300_000 } }), "utf8");
		writeFileSync(projectConfigPath, JSON.stringify({ subagents: { timeoutMs: 600_000 } }), "utf8");

		const trusted = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(trusted.timeoutMs, 600_000);
		assert.equal(trusted.timeoutSource, "project");

		const untrusted = loadForgeSubagentSettings(context(cwd, false));
		assert.equal(untrusted.timeoutMs, 300_000);
		assert.equal(untrusted.timeoutSource, "global");

		writeFileSync(projectConfigPath, JSON.stringify({ subagents: { timeoutMs: 999 } }), "utf8");
		const invalidProject = loadForgeSubagentSettings(context(cwd, true));
		assert.equal(invalidProject.timeoutMs, 300_000);
		assert.equal(invalidProject.timeoutSource, "global");
		assert.match(invalidProject.warnings[0] ?? "", /timeoutMs must be an integer from 1000 to 3600000/);
	} finally {
		if (previousGlobalPath === undefined) delete process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
		else process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = previousGlobalPath;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent profiles are trusted-project-only opt-ins with backend and timeout overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-forge-profile-policy-"));
	const globalConfigPath = join(root, "global", "config.json");
	const cwd = join(root, "project");
	const projectConfigPath = join(cwd, ".pi", "forge", "config.json");
	const previousGlobalPath = process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
	process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = globalConfigPath;
	mkdirSync(join(root, "global"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });

	try {
		const defaults = loadForgeSubagentSettings(context(cwd, true));
		assert.deepEqual(resolveSubagentProfilePolicy(defaults, "reviewer"), {
			profileId: "reviewer",
			enabled: false,
			enabledSource: "built-in",
			backend: { id: DEFAULT_SUBAGENT_BACKEND_ID, source: "built-in" },
			timeout: { milliseconds: DEFAULT_SUBAGENT_TIMEOUT_MS, source: "built-in" },
		});

		writeFileSync(globalConfigPath, JSON.stringify({
			subagents: {
				backend: "global-default",
				timeoutMs: 90_000,
				profiles: {
					reviewer: { enabled: true, backend: "global-reviewer", timeoutMs: 300_000 },
					"image-viewer": { enabled: true, timeoutMs: 180_000 },
				},
			},
		}), "utf8");
		writeFileSync(projectConfigPath, JSON.stringify({
			subagents: {
				backend: "project-default",
				timeoutMs: 120_000,
				profiles: {
					reviewer: { enabled: true, backend: "project-reviewer", timeoutMs: 300_000 },
					"image-viewer": { enabled: false },
				},
			},
		}), "utf8");

		const layered = loadForgeSubagentSettings(context(cwd, true));
		assert.deepEqual(resolveSubagentProfilePolicy(layered, "reviewer"), {
			profileId: "reviewer",
			enabled: true,
			enabledSource: "project-profile",
			backend: { id: "project-reviewer", source: "project-profile" },
			timeout: { milliseconds: 300_000, source: "project-profile" },
		});
		assert.deepEqual(resolveSubagentProfilePolicy(layered, "reviewer", "one-run"), {
			profileId: "reviewer",
			enabled: true,
			enabledSource: "project-profile",
			backend: { id: "one-run", source: "explicit" },
			timeout: { milliseconds: 300_000, source: "project-profile" },
		});
		assert.equal(resolveSubagentProfilePolicy(layered, "image-viewer").enabled, false);
		assert.equal(resolveSubagentProfilePolicy(layered, "unknown").enabled, false);
		assert.match(layered.warnings.join("\n"), /subagents\.profiles is project-only and ignored/);

		const untrusted = loadForgeSubagentSettings(context(cwd, false));
		assert.equal(resolveSubagentProfilePolicy(untrusted, "image-viewer").enabled, false);
		assert.deepEqual(resolveSubagentProfilePolicy(untrusted, "image-viewer").backend, {
			id: "global-default",
			source: "global",
		});
		assert.deepEqual(resolveSubagentProfilePolicy(untrusted, "image-viewer").timeout, {
			milliseconds: 90_000,
			source: "global",
		});
		assert.match(untrusted.warnings.join("\n"), /subagents\.profiles is project-only and ignored/);

		writeFileSync(projectConfigPath, JSON.stringify({
			subagents: {
				backend: "project-default",
				timeoutMs: 120_000,
				profiles: {
					reviewer: { enabled: "yes", backend: "", timeoutMs: 999, extra: true },
					"bad id": true,
				},
			},
		}), "utf8");
		const malformed = loadForgeSubagentSettings(context(cwd, true));
		const reviewer = resolveSubagentProfilePolicy(malformed, "reviewer");
		assert.equal(reviewer.enabled, false);
		assert.deepEqual(reviewer.backend, { id: "project-default", source: "project" });
		assert.deepEqual(reviewer.timeout, { milliseconds: 120_000, source: "project" });
		assert.match(malformed.warnings.join("\n"), /enabled must be boolean/);
		assert.match(malformed.warnings.join("\n"), /backend must be a non-empty string/);
		assert.match(malformed.warnings.join("\n"), /timeoutMs must be an integer/);
		assert.match(malformed.warnings.join("\n"), /extra is unsupported/);
		assert.match(malformed.warnings.join("\n"), /invalid profile id/);
	} finally {
		if (previousGlobalPath === undefined) delete process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
		else process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = previousGlobalPath;
		rmSync(root, { recursive: true, force: true });
	}
});

function context(cwd: string, trusted: boolean) {
	return { cwd, isProjectTrusted: () => trusted } as any;
}
