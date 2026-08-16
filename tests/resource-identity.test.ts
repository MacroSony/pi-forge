import assert from "node:assert/strict";
import test from "node:test";
import {
	formatResourceKey,
	formatResourceSelector,
	isValidResourceId,
	parseResourceSelector,
	resourceKey,
} from "../src/resource-identity.ts";

test("isValidResourceId accepts the unified grammar and rejects colons", () => {
	for (const id of ["reviewer", "my.stack", "a_b-c", "A0", "x.1_2"]) {
		assert.equal(isValidResourceId(id), true, id);
	}
	for (const id of ["", " project", "proj:reviewer", "global:x", "a b", "-leading", ".leading", "with/slash"]) {
		assert.equal(isValidResourceId(id), false, id);
	}
});

test("parseResourceSelector handles bare, qualified, and malformed selectors", () => {
	assert.deepEqual(parseResourceSelector("reviewer"), { ok: true, selector: { id: "reviewer" } });
	assert.deepEqual(parseResourceSelector("project:reviewer"), { ok: true, selector: { scope: "project", id: "reviewer" } });
	assert.deepEqual(parseResourceSelector("global:reviewer"), { ok: true, selector: { scope: "global", id: "reviewer" } });

	assert.equal(parseResourceSelector("").ok, false);
	assert.equal(parseResourceSelector("   ").ok, false);
	assert.equal(parseResourceSelector("bad:scope:reviewer").ok, false);
	assert.equal(parseResourceSelector("unknown:reviewer").ok, false);
	assert.equal(parseResourceSelector("project:").ok, false);
	assert.equal(parseResourceSelector("project:bad id").ok, false);
});

test("parseResourceSelector rejects malformed selectors with a specific diagnostic", () => {
	const unknown = parseResourceSelector("unknown:reviewer");
	assert.equal(unknown.ok, false);
	if (unknown.ok) return;
	assert.match(unknown.error, /Unknown scope prefix: unknown/);

	const empty = parseResourceSelector("project:");
	assert.equal(empty.ok, false);
	if (empty.ok) return;
	assert.match(empty.error, /Invalid resource id/);
});

test("formatResourceKey and formatResourceSelector produce canonical forms", () => {
	assert.equal(formatResourceKey(resourceKey("project", "reviewer")), "project:reviewer");
	assert.equal(formatResourceKey(resourceKey("global", "reviewer")), "global:reviewer");
	assert.equal(formatResourceSelector({ id: "reviewer" }), "reviewer");
	assert.equal(formatResourceSelector({ scope: "global", id: "reviewer" }), "global:reviewer");
});
