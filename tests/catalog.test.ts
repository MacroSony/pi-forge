import assert from "node:assert/strict";
import test from "node:test";
import {
	createResourceCatalog,
	resolveEffectiveResource,
	resolveExactResource,
	resolveResourceSelector,
} from "../src/catalog.ts";
import type { ResourceKey } from "../src/resource-identity.ts";

interface Item {
	key: ResourceKey;
	label: string;
	errors: boolean;
}

function item(scope: "global" | "project", id: string, label = id, errors = false): Item {
	return { key: { scope, id }, label, errors };
}

test("resolveEffectiveResource prefers project then global", () => {
	const all = [item("global", "reviewer", "g"), item("project", "reviewer", "p")];
	assert.equal(resolveEffectiveResource(all, "reviewer")?.label, "p");
	assert.equal(resolveEffectiveResource(all, "missing"), undefined);
});

test("resolveEffectiveResource returns the only global when no project match exists", () => {
	const all = [item("global", "reviewer", "g")];
	assert.equal(resolveEffectiveResource(all, "reviewer")?.label, "g");
});

test("resolveEffectiveResource does not fall back to global on an invalid project shadow", () => {
	const all = [item("global", "reviewer", "g"), item("project", "reviewer", "p", true)];
	// An invalid project shadow still shadows; effective resolution returns it (invalid), not global.
	assert.equal(resolveEffectiveResource(all, "reviewer")?.label, "p");
});

test("resolveEffectiveResource fails closed on ambiguous project scope", () => {
	const all = [
		item("project", "reviewer", "p1"),
		item("project", "reviewer", "p2"),
		item("global", "reviewer", "g"),
	];
	assert.equal(resolveEffectiveResource(all, "reviewer"), undefined);
});

test("resolveExactResource addresses only the named scope", () => {
	const all = [item("global", "reviewer", "g"), item("project", "reviewer", "p")];
	assert.equal(resolveExactResource(all, { scope: "global", id: "reviewer" })?.label, "g");
	assert.equal(resolveExactResource(all, { scope: "project", id: "reviewer" })?.label, "p");
	assert.equal(resolveExactResource(all, { scope: "global", id: "missing" }), undefined);
});

test("resolveExactResource is undefined when a scope has duplicate IDs", () => {
	const all = [item("project", "reviewer", "p1"), item("project", "reviewer", "p2")];
	assert.equal(resolveExactResource(all, { scope: "project", id: "reviewer" }), undefined);
});

test("resolveResourceSelector dispatches qualified to exact and bare to effective", () => {
	const all = [item("global", "reviewer", "g"), item("project", "reviewer", "p")];
	assert.equal(resolveResourceSelector(all, { id: "reviewer" })?.label, "p");
	assert.equal(resolveResourceSelector(all, { scope: "global", id: "reviewer" })?.label, "g");
});

test("createResourceCatalog exposes all, effective, and resolution helpers", () => {
	const all = [
		item("global", "reviewer", "g"),
		item("project", "reviewer", "p"),
		item("project", "other", "o"),
	];
	const catalog = createResourceCatalog(all);
	assert.equal(catalog.all.length, 3);
	assert.deepEqual(catalog.effective.map((i) => i.label).sort(), ["o", "p"]);
	assert.equal(catalog.resolveEffective("reviewer")?.label, "p");
	assert.equal(catalog.resolveExact("global", "reviewer")?.label, "g");
	assert.equal(catalog.resolveSelector({ scope: "global", id: "reviewer" })?.label, "g");
	assert.equal(catalog.resolveSelector({ id: "reviewer" })?.label, "p");
});
