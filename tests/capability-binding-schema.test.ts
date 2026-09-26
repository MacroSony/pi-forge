import assert from "node:assert/strict";
import test from "node:test";
import {
	parsePromptStack,
	serializePromptStack,
	validatePromptStack,
} from "../src/codecs/prompt-stack.ts";
import { isUsablePromptStack } from "../src/loader.ts";
import type { PromptStack } from "../src/types.ts";

function createValidPresetSource(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "test-preset",
		items: [{ id: "item-1", kind: "block", role: "system", content: "Test content" }],
		...extra,
	});
}

test("1. characterization / rejection: non-array capabilities fails validation", () => {
	const invalidValues = [
		null,
		"not-an-array",
		123,
		true,
		{ ref: "fast-capability" },
	];

	for (const value of invalidValues) {
		const source = createValidPresetSource({ capabilities: value });
		const loaded = parsePromptStack(source, "/project/.pi/forge/prompt-stacks/test.json", "project");
		const errors = loaded.diagnostics.filter((d) => d.level === "error");
		assert.ok(
			errors.some((d) => /capabilities must be an array/i.test(d.message)),
			`Expected error for capabilities: ${JSON.stringify(value)}`,
		);
		assert.equal(isUsablePromptStack(loaded), false);
	}
});

test("legacy instructionModes binding key is rejected explicitly", () => {
	const loaded = parsePromptStack(createValidPresetSource({ instructionModes: [{ ref: "review" }] }), "/project/.pi/forge/prompt-stacks/legacy.json", "project");
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && /instructionModes.*rename.*capabilities/i.test(d.message)));
	assert.equal(isUsablePromptStack(loaded), false);
	assert.equal(loaded.stack.capabilities, undefined);
});

test("legacy binding field mode is rejected explicitly", () => {
	const loaded = parsePromptStack(createValidPresetSource({ capabilities: [{ ref: "review", mode: "use" }] }), "/project/.pi/forge/prompt-stacks/legacy-binding.json", "project");
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && /Unsupported binding field: mode/.test(d.message)));
	assert.equal(isUsablePromptStack(loaded), false);
});

test("2. characterization / rejection: malformed binding entries fail validation", () => {
	const invalidEntries = [
		null,
		123,
		"fast-capability",
		true,
		[],
		{}, // missing ref
		{ ref: "" }, // empty ref
		{ ref: "   " }, // whitespace ref
		{ ref: 123 }, // non-string ref
		{ ref: "bad:scope:id:extra" }, // invalid selector syntax
		{ ref: "unknownscope:fast-capability" }, // invalid scope
	];

	for (const entry of invalidEntries) {
		const source = createValidPresetSource({ capabilities: [entry] });
		const loaded = parsePromptStack(source, "/project/.pi/forge/prompt-stacks/test.json", "project");
		const errors = loaded.diagnostics.filter((d) => d.level === "error");
		assert.ok(
			errors.length > 0,
			`Expected error for binding entry: ${JSON.stringify(entry)}`,
		);
		assert.equal(isUsablePromptStack(loaded), false);
	}
});

test("3. characterization / rejection: unknown fields on binding fail validation", () => {
	const badBinding = {
		ref: "fast-capability",
		extraUnauthorized: 123,
		anotherBadField: "disallowed",
	};
	const source = createValidPresetSource({ capabilities: [badBinding] });
	const loaded = parsePromptStack(source, "/project/.pi/forge/prompt-stacks/test.json", "project");
	const errors = loaded.diagnostics.filter((d) => d.level === "error");
	assert.ok(
		errors.some((d) => /Unsupported binding field/i.test(d.message)),
		"Expected error for unknown binding field",
	);
	assert.equal(isUsablePromptStack(loaded), false);
});

test("4. characterization / rejection: invalid id and modelCallable fail validation", () => {
	const invalidBindings = [
		{ ref: "fast-capability", id: 123 },
		{ ref: "fast-capability", id: "bad ID with spaces" },
		{ ref: "fast-capability", id: "bad:colon" },
		{ ref: "fast-capability", id: "" },
		{ ref: "fast-capability", modelCallable: "yes" },
		{ ref: "fast-capability", modelCallable: 1 },
		{ ref: "fast-capability", modelCallable: null },
	];

	for (const binding of invalidBindings) {
		const source = createValidPresetSource({ capabilities: [binding] });
		const loaded = parsePromptStack(source, "/project/.pi/forge/prompt-stacks/test.json", "project");
		const errors = loaded.diagnostics.filter((d) => d.level === "error");
		assert.ok(
			errors.length > 0,
			`Expected error for binding: ${JSON.stringify(binding)}`,
		);
		assert.equal(isUsablePromptStack(loaded), false);
	}
});

test("5. characterization / rejection: malformed overrides and unknown override fields fail validation", () => {
	const invalidOverrides = [
		{ overrides: "not-an-object" },
		{ overrides: null },
		{ overrides: { extraField: 123 } },
		{ overrides: { content: "a", appendContent: "b" } }, // mutually exclusive
		{ overrides: { content: 123 } },
		{ overrides: { appendContent: 123 } },
		{ overrides: { tools: "not-an-object" } },
		{ overrides: { tools: null } },
		{ overrides: { tools: { extra: [] } } },
		{ overrides: { tools: { add: "not-an-array" } } },
		{ overrides: { tools: { add: [123] } } },
		{ overrides: { tools: { add: ["invalid*wildcard"] } } },
		{ overrides: { tools: { remove: ["invalid space"] } } },
		{ overrides: { tools: { add: Array.from({ length: 257 }, (_, i) => `tool-${i}`) } } }, // > 256 tools
		{ overrides: { content: "x".repeat(100_001) } }, // > 100k chars
	];

	for (const overrideCase of invalidOverrides) {
		const binding = { ref: "fast-capability", ...overrideCase };
		const source = createValidPresetSource({ capabilities: [binding] });
		const loaded = parsePromptStack(source, "/project/.pi/forge/prompt-stacks/test.json", "project");
		const errors = loaded.diagnostics.filter((d) => d.level === "error");
		assert.ok(
			errors.length > 0,
			`Expected error for overrides: ${JSON.stringify(overrideCase)}`,
		);
		assert.equal(isUsablePromptStack(loaded), false);
	}
});

test("6. characterization / rejection: capabilities exceeding 256 bindings fails", () => {
	// 256 bindings should be allowed
	const maxBindings = Array.from({ length: 256 }, (_, i) => ({
		ref: `global:capability-${i}`,
	}));
	const validSource = createValidPresetSource({ capabilities: maxBindings });
	const loadedValid = parsePromptStack(validSource, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.equal(
		loadedValid.diagnostics.filter((d) => d.level === "error").length,
		0,
		"256 bindings should be valid",
	);

	// 257 bindings must fail
	const tooManyBindings = Array.from({ length: 257 }, (_, i) => ({
		ref: `global:capability-${i}`,
	}));
	const invalidSource = createValidPresetSource({ capabilities: tooManyBindings });
	const loadedInvalid = parsePromptStack(invalidSource, "/project/.pi/forge/prompt-stacks/test.json", "project");
	const errors = loadedInvalid.diagnostics.filter((d) => d.level === "error");
	assert.ok(
		errors.some((d) => /256/i.test(d.message) && /exceed|limit/i.test(d.message)),
		"Expected error for 257 bindings exceeding 256 limit",
	);
	assert.equal(isUsablePromptStack(loadedInvalid), false);
});

test("7. characterization / rejection: duplicate effective binding IDs fail validation", () => {
	// Duplicate bare refs
	const dupBare = createValidPresetSource({
		capabilities: [{ ref: "review" }, { ref: "review" }],
	});
	const loadedDupBare = parsePromptStack(dupBare, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.ok(
		loadedDupBare.diagnostics.some((d) => d.level === "error" && /duplicate.*binding.*review/i.test(d.message)),
		"Expected duplicate effective ID error for duplicate bare refs",
	);

	// Duplicate cross-scope without explicit disambiguation
	const dupCrossScope = createValidPresetSource({
		capabilities: [{ ref: "review" }, { ref: "global:review" }],
	});
	const loadedDupCross = parsePromptStack(dupCrossScope, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.ok(
		loadedDupCross.diagnostics.some((d) => d.level === "error" && /duplicate.*binding.*review/i.test(d.message)),
		"Expected duplicate effective ID error for same ID across scopes without disambiguation",
	);

	// Duplicate explicit id colliding with bare ref
	const dupExplicitWithRef = createValidPresetSource({
		capabilities: [{ ref: "review" }, { ref: "global:other-capability", id: "review" }],
	});
	const loadedDupExplicit = parsePromptStack(dupExplicitWithRef, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.ok(
		loadedDupExplicit.diagnostics.some((d) => d.level === "error" && /duplicate.*binding.*review/i.test(d.message)),
		"Expected duplicate effective ID error when explicit id matches another ref",
	);

	// Duplicate explicit IDs on both
	const dupBothExplicit = createValidPresetSource({
		capabilities: [
			{ ref: "capability-a", id: "custom-alias" },
			{ ref: "capability-b", id: "custom-alias" },
		],
	});
	const loadedBothExplicit = parsePromptStack(dupBothExplicit, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.ok(
		loadedBothExplicit.diagnostics.some((d) => d.level === "error" && /duplicate.*binding.*custom-alias/i.test(d.message)),
		"Expected duplicate effective ID error when two bindings specify same explicit id",
	);

	// Disambiguated same-name cross-scope succeeds
	const disambiguated = createValidPresetSource({
		capabilities: [
			{ ref: "review" },
			{ ref: "global:review", id: "global-review" },
		],
	});
	const loadedDisambiguated = parsePromptStack(disambiguated, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.equal(
		loadedDisambiguated.diagnostics.filter((d) => d.level === "error").length,
		0,
		"Disambiguated bindings should succeed without error",
	);
});

test("8. characterization / scope rules: global preset cannot bind project capability; bare refs owner-scope", () => {
	// Global preset referencing project capability MUST fail
	const globalPresetWithProjectRef = createValidPresetSource({
		capabilities: [{ ref: "project:local-capability" }],
	});
	const loadedGlobalProject = parsePromptStack(
		globalPresetWithProjectRef,
		"/global/.pi/forge/prompt-stacks/test.json",
		"global",
	);
	const errors = loadedGlobalProject.diagnostics.filter((d) => d.level === "error");
	assert.ok(
		errors.some((d) => /Global binding cannot reference project/i.test(d.message)),
		"Global preset cannot reference project instruction capability",
	);
	assert.equal(isUsablePromptStack(loadedGlobalProject), false);

	// Global preset referencing global capability SUCCEEDS
	const globalPresetWithGlobalRef = createValidPresetSource({
		capabilities: [{ ref: "global:shared-capability" }],
	});
	const loadedGlobalGlobal = parsePromptStack(
		globalPresetWithGlobalRef,
		"/global/.pi/forge/prompt-stacks/test.json",
		"global",
	);
	assert.equal(
		loadedGlobalGlobal.diagnostics.filter((d) => d.level === "error").length,
		0,
		"Global preset referencing global capability should succeed",
	);

	// Global preset with bare ref SUCCEEDS (bare refs resolve in owner scope = global)
	const globalPresetWithBareRef = createValidPresetSource({
		capabilities: [{ ref: "shared-capability" }],
	});
	const loadedGlobalBare = parsePromptStack(
		globalPresetWithBareRef,
		"/global/.pi/forge/prompt-stacks/test.json",
		"global",
	);
	assert.equal(
		loadedGlobalBare.diagnostics.filter((d) => d.level === "error").length,
		0,
		"Global preset with bare ref should succeed (owner-scope)",
	);

	// Project preset referencing project capability SUCCEEDS
	const projectPresetWithProjectRef = createValidPresetSource({
		capabilities: [{ ref: "project:local-capability" }],
	});
	const loadedProjectProject = parsePromptStack(
		projectPresetWithProjectRef,
		"/project/.pi/forge/prompt-stacks/test.json",
		"project",
	);
	assert.equal(
		loadedProjectProject.diagnostics.filter((d) => d.level === "error").length,
		0,
		"Project preset referencing project capability should succeed",
	);

	// Project preset referencing global capability SUCCEEDS
	const projectPresetWithGlobalRef = createValidPresetSource({
		capabilities: [{ ref: "global:shared-capability" }],
	});
	const loadedProjectGlobal = parsePromptStack(
		projectPresetWithGlobalRef,
		"/project/.pi/forge/prompt-stacks/test.json",
		"project",
	);
	assert.equal(
		loadedProjectGlobal.diagnostics.filter((d) => d.level === "error").length,
		0,
		"Project preset referencing global capability should succeed",
	);

	// Project preset with bare ref SUCCEEDS (bare refs resolve in owner scope = project)
	const projectPresetWithBareRef = createValidPresetSource({
		capabilities: [{ ref: "local-capability" }],
	});
	const loadedProjectBare = parsePromptStack(
		projectPresetWithBareRef,
		"/project/.pi/forge/prompt-stacks/test.json",
		"project",
	);
	assert.equal(
		loadedProjectBare.diagnostics.filter((d) => d.level === "error").length,
		0,
		"Project preset with bare ref should succeed (owner-scope)",
	);
});

test("9. characterization / parse: malformed data diagnostics are preserved rather than silently granted", () => {
	// A preset with both valid items and a malformed binding must preserve error diagnostics
	const source = createValidPresetSource({
		capabilities: [
			{ ref: "valid-capability" },
			{ ref: "bad-capability", extraField: "should-fail-open" },
		],
	});
	const loaded = parsePromptStack(source, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.equal(isUsablePromptStack(loaded), false);
	assert.ok(
		loaded.diagnostics.some((d) => d.level === "error" && /Unsupported binding field: extraField/.test(d.message)),
		"Malformed field diagnostic must be preserved in loaded.diagnostics",
	);

	// Calling validatePromptStack directly on a stack with malformed binding preserves diagnostics
	const directStack: PromptStack = {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "direct-stack",
		items: [],
		capabilities: [{ ref: "valid-capability", invalidProperty: true } as any],
	};
	const directDiags = validatePromptStack(directStack, "project");
	assert.ok(
		directDiags.some((d) => d.level === "error" && /Unsupported binding field: invalidProperty/.test(d.message)),
		"validatePromptStack must report error for invalid binding property",
	);
});

test("10. characterization / round-trip: valid refs, overrides, and modelCallable round-trip cleanly", () => {
	const validBinding1 = {
		ref: "global:review",
		id: "review-custom",
		modelCallable: true,
		overrides: {
			content: "Strict review instructions without direct edits.",
			tools: {
				add: ["grep", "find"],
				remove: ["write", "edit", "bash"],
			},
		},
	};
	const validBinding2 = {
		ref: "architect",
		modelCallable: false,
		overrides: {
			appendContent: "Additional architect guidance.",
		},
	};
	const validBinding3 = {
		ref: "project:minimal-capability",
	};

	const source = createValidPresetSource({
		capabilities: [validBinding1, validBinding2, validBinding3],
	});

	const loaded = parsePromptStack(source, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.equal(loaded.diagnostics.filter((d) => d.level === "error").length, 0);
	assert.ok(loaded.stack.capabilities);
	assert.equal(loaded.stack.capabilities.length, 3);
	assert.deepEqual(loaded.stack.capabilities[0], validBinding1);
	assert.deepEqual(loaded.stack.capabilities[1], validBinding2);
	assert.deepEqual(loaded.stack.capabilities[2], validBinding3);

	// Serialize and re-parse
	const serialized = serializePromptStack(loaded.stack);
	const reloaded = parsePromptStack(serialized, "/project/.pi/forge/prompt-stacks/test.json", "project");
	assert.equal(reloaded.diagnostics.filter((d) => d.level === "error").length, 0);
	assert.deepEqual(reloaded.stack.capabilities, loaded.stack.capabilities);
	assert.equal(serializePromptStack(reloaded.stack), serialized);
});

test("11. characterization / preservation: old presets without capabilities are preserved", () => {
	const oldPresetSource = JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "old-preset",
		name: "Old Preset",
		mode: "replace",
		items: [{ id: "item-1", kind: "block", role: "system", content: "Existing content" }],
	});

	const loaded = parsePromptStack(oldPresetSource, "/project/.pi/forge/prompt-stacks/old.json", "project");
	assert.equal(loaded.diagnostics.filter((d) => d.level === "error").length, 0);
	assert.equal(loaded.stack.capabilities, undefined);

	// Serializing must not add capabilities property
	const serialized = serializePromptStack(loaded.stack);
	assert.ok(!serialized.includes('"capabilities"'), "Serialized old preset must not contain capabilities");

	const reloaded = parsePromptStack(serialized, "/project/.pi/forge/prompt-stacks/old.json", "project");
	assert.equal(reloaded.stack.capabilities, undefined);
	assert.equal(serializePromptStack(reloaded.stack), serialized);
});
