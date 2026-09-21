import assert from "node:assert/strict";
import test from "node:test";

import {
	deduplicateToolNames,
	groupTools,
	matchesAnyPattern,
	resourcePatternMatches,
	seedDefaultTools,
	toolTooltip,
} from "../src/web-editor/client/tool-picker-helpers.ts";
import type { WebEditorPolicyResource } from "../src/web-editor/types.ts";

const catalogWithActive: WebEditorPolicyResource[] = [
	{ name: "read", active: true, source: "fs", group: { id: "fs", label: "Filesystem" } },
	{ name: "write", active: true, source: "fs", group: { id: "fs", label: "Filesystem" } },
	{ name: "bash", active: false, source: "shell" },
	{ name: "git_status", active: false, source: "git", group: { id: "git", label: "Git" } },
];

const catalogWithoutActive: WebEditorPolicyResource[] = [
	{ name: "read", active: false, source: "fs" },
	{ name: "write", active: false, source: "fs" },
	{ name: "bash", active: false, source: "shell" },
];

test("seedDefaultTools: when no tools are active, never falls back to all catalog tools", () => {
	// Mode "none" with no active tools must yield empty array, not full catalog guess!
	assert.deepEqual(seedDefaultTools(catalogWithoutActive, "none", []), []);

	// Mode "deny" with no active tools must yield empty array
	assert.deepEqual(seedDefaultTools(catalogWithoutActive, "deny", ["bash"]), []);

	// Mode "allow" with wildcard ["*"] when no active tools must yield empty array, not all tools
	assert.deepEqual(seedDefaultTools(catalogWithoutActive, "allow", ["*"]), []);

	// Mode "allow" with empty patterns when no active tools must yield empty array
	assert.deepEqual(seedDefaultTools(catalogWithoutActive, "allow", []), []);
});

test("seedDefaultTools: allow:['*'] or empty allow is unrestricted baseline, not enable-all", () => {
	// Active baseline is ["read", "write"]. allow: ["*"] must return ["read", "write"], NOT ["read", "write", "bash", "git_status"]!
	assert.deepEqual(seedDefaultTools(catalogWithActive, "allow", ["*"]), ["read", "write"]);

	// Empty allow patterns in "allow" mode also behaves as unrestricted baseline
	assert.deepEqual(seedDefaultTools(catalogWithActive, "allow", []), ["read", "write"]);
});

test("seedDefaultTools: selective allow matches catalog and can activate inactive tools", () => {
	// Concrete allow on bash (which is inactive) activates bash
	assert.deepEqual(seedDefaultTools(catalogWithActive, "allow", ["bash"]), ["bash"]);

	// Wildcard pattern (not bare "*") matches catalog tools
	assert.deepEqual(seedDefaultTools(catalogWithActive, "allow", ["git_*"]), ["git_status"]);

	// Multiple selective patterns
	assert.deepEqual(seedDefaultTools(catalogWithActive, "allow", ["read", "bash"]), ["read", "bash"]);
});

test("seedDefaultTools: deny mode filters active baseline", () => {
	assert.deepEqual(seedDefaultTools(catalogWithActive, "deny", ["read"]), ["write"]);
	assert.deepEqual(seedDefaultTools(catalogWithActive, "deny", ["*"]), []);
	assert.deepEqual(seedDefaultTools(catalogWithActive, "deny", []), ["read", "write"]);
});

test("seedDefaultTools: none mode returns active baseline", () => {
	assert.deepEqual(seedDefaultTools(catalogWithActive, "none", []), ["read", "write"]);
});

test("deduplicateToolNames: preserves exact names and order, does not expand patterns", () => {
	assert.deepEqual(
		deduplicateToolNames(["read", "git_*", "read", "custom_unknown", "*"]),
		["read", "git_*", "custom_unknown", "*"],
	);
});


test("default seeding uses the saved baseline, not current mode overlays", () => {
	const resources = [
		{ name: "read", active: true, baselineActive: true },
		{ name: "write", active: false, baselineActive: true },
		{ name: "mode_extra", active: true, baselineActive: false },
	];
	assert.deepEqual(seedDefaultTools(resources, "none", []), ["read", "write"]);
	assert.deepEqual(seedDefaultTools(resources, "allow", ["*"]), ["read", "write"]);
	assert.deepEqual(seedDefaultTools(resources, "deny", ["write"]), ["read"]);
});
