import assert from "node:assert/strict";
import test from "node:test";

import * as rootSurface from "../src/index.ts";
import * as compatibilityContract from "../src/subagent-contract.ts";
import * as modularContract from "../src/subagent/contract.ts";
import * as subagentSurface from "../src/subagent/index.ts";

const contractRuntimeExports = [
	"SUBAGENT_CONTRACT_VERSION",
	"SUBAGENT_FINGERPRINT_PREFIX",
	"appendProtectedSubagentTask",
	"budgetSubagentContext",
	"canonicalSubagentJson",
	"createAgentExecutionPlan",
	"createProtectedSubagentTask",
	"hasSubagentErrors",
	"isProtectedSubagentTaskPreserved",
	"negotiateSubagentTools",
	"prepareSubagentInitialMessages",
	"renderSubagentSelectedContext",
	"subagentExecutionFingerprint",
	"subagentFingerprint",
	"subagentPromptRuntimeFingerprint",
	"subagentPromptStackFingerprint",
	"subagentSourceProfileFingerprint",
	"validateAgentExecutionPlan",
	"validateAgentProfileSnapshot",
	"validateAgentRequest",
	"validateAgentResponse",
	"validateBackendPreflight",
	"validatePreflightAgainstRequest",
	"validatePreparationRuntime",
	"validateSubagentArtifactReference",
	"validateSubagentTraceReference",
].sort();

test("the legacy subagent contract path preserves the modular contract surface", () => {
	assert.deepEqual(Object.keys(modularContract).sort(), contractRuntimeExports);
	assert.deepEqual(Object.keys(compatibilityContract).sort(), contractRuntimeExports);
});

test("the dedicated subagent entry point preserves the package-root adapter surface", async () => {
	for (const name of [
		"validateAgentRequest",
		"resolveSubagentHostProfile",
		"createAgentExecutionPlan",
		"validateAgentResponse",
		"SubagentBackendRegistry",
		"PiSubprocessBackend",
	] as const) {
		assert.equal(typeof subagentSurface[name], "function", name);
		assert.equal(rootSurface[name], subagentSurface[name], name);
	}

	const packaged = await import("@zihanw/pi-forge/subagent");
	assert.equal(typeof packaged.validateAgentRequest, "function");
	assert.equal(typeof packaged.resolveSubagentHostProfile, "function");
	assert.equal(typeof packaged.PiSubprocessBackend, "function");
	assert.equal(packaged.PI_SUBPROCESS_READONLY_BACKEND_ID, "pi-subprocess-readonly");
});
