import assert from "node:assert/strict";
import test from "node:test";

import * as rootSurface from "../src/index.ts";
import * as subagentSurface from "../src/subagent/index.ts";

test("the dedicated subagent entry point preserves the package-root adapter surface", async () => {
	for (const name of [
		"validateAgentRequest",
		"resolveSubagentHostProfile",
		"createAgentExecutionPlan",
		"validateAgentResponse",
	] as const) {
		assert.equal(typeof subagentSurface[name], "function", name);
		assert.equal(rootSurface[name], subagentSurface[name], name);
	}

	const packaged = await import("@zihanw/pi-forge/subagent");
	assert.equal(typeof packaged.validateAgentRequest, "function");
	assert.equal(typeof packaged.resolveSubagentHostProfile, "function");
});
