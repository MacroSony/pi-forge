import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadForgeSubagentSettings } from "../src/forge-config.ts";

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

function context(cwd: string, trusted: boolean) {
	return { cwd, isProjectTrusted: () => trusted } as any;
}
