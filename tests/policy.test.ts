import assert from "node:assert/strict";
import test from "node:test";
import { applyResourcePolicy, hasResourcePolicy } from "../src/policy.ts";

test("wildcard-only allow policy is permissive and not actively enforced", () => {
	const policy = { allow: ["*"] };

	assert.equal(hasResourcePolicy(policy), false);
	assert.deepEqual(applyResourcePolicy(["read", "bash", "forge_state_set"], policy), ["read", "bash", "forge_state_set"]);
});

test("allow policy filters names with wildcard support", () => {
	const policy = { allow: ["read", "browser-*"] };

	assert.equal(hasResourcePolicy(policy), true);
	assert.deepEqual(applyResourcePolicy(["read", "bash", "browser-search", "browser-danger"], policy), ["read", "browser-search", "browser-danger"]);
});

test("deny policy filters names", () => {
	assert.deepEqual(applyResourcePolicy(["read", "bash", "edit"], { deny: ["edit"] }), ["read", "bash"]);
});
