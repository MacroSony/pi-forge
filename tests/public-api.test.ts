import assert from "node:assert/strict";
import test from "node:test";

import * as rootSurface from "../src/index.ts";
import * as subagentSurface from "../src/subagent/index.ts";

/**
 * Public-surface tests for the `/subagent` host contract. Lane 4b adds the
 * complete root allowlist; this file pins the host-port entry after the 0.4
 * execution contract moved to the optional package (Lane 4a).
 */

const hostContractRuntimeExports = [
	"FORGE_HOST_CHANNEL",
	"FORGE_HOST_PORT_NAMESPACE",
	"FORGE_HOST_PORT_OPERATIONS",
	"FORGE_HOST_PORT_VERSION",
	"ForgeHost",
	"ForgeHostClient",
	"ForgeHostPortError",
	"SUBAGENT_FINGERPRINT_PREFIX",
	"canonicalSubagentJson",
	"subagentFingerprint",
	"subagentPromptStackFingerprint",
	"subagentSourceProfileFingerprint",
	"validateListProfilesRequest",
	"validateListProfilesResponse",
	"validatePrepareRequest",
	"validatePrepareResponse",
	"validateResolveProfileRequest",
	"validateResolveProfileResponse",
].sort();

test("the /subagent entry point exports exactly the host contract", () => {
	assert.deepEqual(Object.keys(subagentSurface).sort(), hostContractRuntimeExports);
});

test("the package root no longer re-exports subagent host or contract names", () => {
	const root = rootSurface as Record<string, unknown>;
	for (const name of [
		...hostContractRuntimeExports,
		"createAgentExecutionPlan",
		"validateAgentRequest",
		"validateAgentResponse",
		"resolveSubagentHostProfile",
		"prepareSubagentHostPlan",
		"negotiateSubagentTools",
	]) {
		assert.equal(root[name], undefined, name);
	}
});

test("the packaged /subagent entry matches the source surface", async () => {
	const packaged = await import("@zihanw/pi-forge/subagent");
	assert.deepEqual(Object.keys(packaged).sort(), hostContractRuntimeExports);
	assert.equal(typeof packaged.ForgeHostClient, "function");
	assert.equal(typeof packaged.ForgeHost, "function");
});

test("the package root exports exactly the extension factory and extension API", async () => {
	const expected = ["default", "registerMacro", "registerSlot"].sort();
	assert.deepEqual(Object.keys(rootSurface).sort(), expected);
	const packaged = await import("@zihanw/pi-forge");
	assert.deepEqual(Object.keys(packaged).sort(), expected);
	assert.equal(typeof packaged.default, "function");
	assert.equal(typeof packaged.registerMacro, "function");
	assert.equal(typeof packaged.registerSlot, "function");
});
