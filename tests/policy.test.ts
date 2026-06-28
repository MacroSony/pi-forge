import assert from "node:assert/strict";
import test from "node:test";
import { applyResourcePolicy, hasResourcePolicy } from "../src/policy.ts";

test("wildcard-only allow policy is permissive and not actively enforced", () => {
	const policy = { allow: ["*"], deny: [] };

	assert.equal(hasResourcePolicy(policy), false);
	assert.deepEqual(applyResourcePolicy(["read", "bash", "forge_state_set"], policy), ["read", "bash", "forge_state_set"]);
});

test("concrete allow policy wins over deny policy with wildcard support", () => {
	const policy = { allow: ["read", "browser-*"], deny: ["browser-danger", "*"] };

	assert.equal(hasResourcePolicy(policy), true);
	assert.deepEqual(applyResourcePolicy(["read", "bash", "browser-search", "browser-danger"], policy), ["read", "browser-search", "browser-danger"]);
});

test("deny policy filters names when allow is absent or wildcard-only", () => {
	assert.deepEqual(applyResourcePolicy(["read", "bash", "edit"], { deny: ["edit"] }), ["read", "bash"]);
	assert.deepEqual(applyResourcePolicy(["read", "bash", "edit"], { allow: ["*"], deny: ["edit"] }), ["read", "bash"]);
});
