import assert from "node:assert/strict";
import test from "node:test";
import {
	applyInstructionModeOverrides,
	createInstructionModeFault,
	INSTRUCTION_MODE_TYPE,
	isUsableInstructionMode,
	MAX_MODE_NAME_LENGTH,
	parseInstructionMode,
	serializeInstructionMode,
	validateInstructionMode,
	validateInstructionModeBinding,
	type InstructionMode,
	type InstructionModeOverrides,
} from "../src/codecs/instruction-mode.ts";

test("1. parseInstructionMode parses a complete valid instruction mode", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "strict-reviewer",
		name: "Strict Code Reviewer",
		description: "Enforces strict guidelines",
		content: "Review all changes with zero tolerance for bugs.",
		tools: {
			add: ["read_file", "search_repo"],
			remove: ["bash", "web_search"],
		},
	});

	const loaded = parseInstructionMode(json, "/path/to/strict-reviewer.json", "project");
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(isUsableInstructionMode(loaded), true);
	assert.equal(loaded.mode.id, "strict-reviewer");
	assert.equal(loaded.mode.name, "Strict Code Reviewer");
	assert.equal(loaded.mode.description, "Enforces strict guidelines");
	assert.equal(loaded.mode.content, "Review all changes with zero tolerance for bugs.");
	assert.deepEqual(loaded.mode.tools.add, ["read_file", "search_repo"]);
	assert.deepEqual(loaded.mode.tools.remove, ["bash", "web_search"]);
	assert.equal(loaded.scope, "project");
	assert.deepEqual(loaded.key, { scope: "project", id: "strict-reviewer" });
});

test("2. parseInstructionMode normalizes omitted tools to empty arrays", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "prompt-only",
		content: "You are a writing assistant.",
	});

	const loaded = parseInstructionMode(json, "prompt-only.json", "global");
	assert.equal(loaded.diagnostics.length, 0);
	assert.deepEqual(loaded.mode.tools, { add: [], remove: [] });
	assert.equal(loaded.mode.id, "prompt-only");
});

test("3. parseInstructionMode preserves raw whitespace in content", () => {
	const rawContent = "\n\n   ### System Directive:\n\t- Line 1\n\t- Line 2\n\n   ";
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "raw-whitespace",
		content: rawContent,
	});

	const loaded = parseInstructionMode(json, "raw-whitespace.json", "project");
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(loaded.mode.content, rawContent);
});

test("4. parseInstructionMode permits empty content if tools effect exists", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "tool-modifier-only",
		content: "",
		tools: {
			add: ["custom_tool"],
			remove: [],
		},
	});

	const loaded = parseInstructionMode(json, "tool-modifier-only.json", "project");
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(loaded.mode.content, "");
	assert.deepEqual(loaded.mode.tools.add, ["custom_tool"]);
});

test("5. parseInstructionMode rejects mode with neither content nor tool effects", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "no-effect",
		content: "   ",
		tools: {
			add: [],
			remove: [],
		},
	});

	const loaded = parseInstructionMode(json, "no-effect.json", "project");
	assert.equal(isUsableInstructionMode(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.message.includes("tool effect")));
});

test("6. parseInstructionMode rejects invalid resource id", () => {
	const badIds = ["-bad-start", "has:colon", "has space", "", "tool/slash"];
	for (const id of badIds) {
		const json = JSON.stringify({
			schemaVersion: 1,
			type: INSTRUCTION_MODE_TYPE,
			id,
			content: "Test",
		});
		const loaded = parseInstructionMode(json, "test.json", "project");
		assert.equal(isUsableInstructionMode(loaded), false);
		assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "id"));
	}
});

test("7. parseInstructionMode strictly rejects unknown fields on root and tools", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "strict-check",
		content: "Valid",
		extraRootField: "rejected",
		tools: {
			add: [],
			remove: [],
			extraToolField: "rejected",
		},
	});

	const loaded = parseInstructionMode(json, "strict-check.json", "project");
	assert.equal(isUsableInstructionMode(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "extraRootField"));
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "tools.extraToolField"));
});

test("8. parseInstructionMode rejects authorization and modelCallable in mode definition", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "auth-probe",
		content: "Valid content",
		authorization: "admin",
		modelCallable: true,
	});

	const loaded = parseInstructionMode(json, "auth-probe.json", "project");
	assert.equal(isUsableInstructionMode(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "authorization"));
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "modelCallable"));
});

test("9. parseInstructionMode validates tool name syntax and forbids wildcards/whitespace/control", () => {
	const invalidToolNames = [
		"",
		"tool with spaces",
		"tool*wildcard",
		"tool?wildcard",
		"tool\x00control",
		"tool\nnewline",
		"a".repeat(129),
	];

	for (const badTool of invalidToolNames) {
		const json = JSON.stringify({
			schemaVersion: 1,
			type: INSTRUCTION_MODE_TYPE,
			id: "tool-name-test",
			content: "Valid",
			tools: {
				add: [badTool],
				remove: [],
			},
		});
		const loaded = parseInstructionMode(json, "tool-name-test.json", "project");
		assert.equal(isUsableInstructionMode(loaded), false, `Tool name "${badTool}" should be rejected`);
		assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field?.startsWith("tools.")));
	}
});

test("10. parseInstructionMode rejects non-string tool array elements", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "non-string-tool",
		content: "Valid",
		tools: {
			add: [123, null, { name: "tool" }],
			remove: [],
		},
	});

	const loaded = parseInstructionMode(json, "non-string-tool.json", "project");
	assert.equal(isUsableInstructionMode(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "tools.add[0]"));
});

test("11. parseInstructionMode rejects tool array exceeding 256 items", () => {
	const tooManyTools = Array.from({ length: 257 }, (_, i) => `tool_${i}`);
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "huge-tools",
		content: "Valid",
		tools: {
			add: tooManyTools,
			remove: [],
		},
	});

	const loaded = parseInstructionMode(json, "huge-tools.json", "project");
	assert.equal(isUsableInstructionMode(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "tools.add"));
});

test("12. parseInstructionMode rejects content exceeding 100000 characters", () => {
	const hugeContent = "x".repeat(100_001);
	const json = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "huge-content",
		content: hugeContent,
	});

	const loaded = parseInstructionMode(json, "huge-content.json", "project");
	assert.equal(isUsableInstructionMode(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "content"));
});

test("13. parseInstructionMode and createInstructionModeFault handle invalid JSON fail-closed", () => {
	const loaded = parseInstructionMode("{ malformed json ...", "/modes/broken.json", "project");
	assert.equal(isUsableInstructionMode(loaded), false);
	assert.equal(loaded.mode.id, "broken");
	assert.equal(loaded.filePath, "/modes/broken.json");
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.message.includes("JSON")));

	const fault = createInstructionModeFault("/modes/faulty.json", "global", "File missing");
	assert.equal(isUsableInstructionMode(fault), false);
	assert.equal(fault.mode.id, "faulty");
	assert.equal(fault.scope, "global");
	assert.deepEqual(fault.key, { scope: "global", id: "faulty" });
	assert.equal(fault.diagnostics[0]?.message, "File missing");
});

test("14. serializeInstructionMode round-trips cleanly", () => {
	const mode: InstructionMode = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "roundtrip-mode",
		name: "Roundtrip Test",
		description: "Tests serialization fidelity",
		content: "Preserve all chars and indent.",
		tools: {
			add: ["tool_a", "tool_b"],
			remove: ["tool_c"],
		},
	};

	const serialized = serializeInstructionMode(mode);
	assert.ok(serialized.endsWith("\n"));

	const loaded = parseInstructionMode(serialized, "roundtrip.json", "project");
	assert.equal(loaded.diagnostics.length, 0);
	assert.deepEqual(loaded.mode, mode);
});

test("15. validateInstructionMode rejects non-objects and bad schemaVersion / type", () => {
	assert.ok(validateInstructionMode(null).some((d) => d.level === "error"));
	assert.ok(validateInstructionMode("not an object").some((d) => d.level === "error"));
	assert.ok(validateInstructionMode([]).some((d) => d.level === "error"));

	const badSchema = {
		schemaVersion: 2,
		type: INSTRUCTION_MODE_TYPE,
		id: "valid-id",
		content: "hello",
		tools: { add: [], remove: [] },
	};
	assert.ok(validateInstructionMode(badSchema).some((d) => d.level === "error" && d.field === "schemaVersion"));

	const badType = {
		schemaVersion: 1,
		type: "unknown-type",
		id: "valid-id",
		content: "hello",
		tools: { add: [], remove: [] },
	};
	assert.ok(validateInstructionMode(badType).some((d) => d.level === "error" && d.field === "type"));
});

test("16. validateInstructionModeBinding accepts bare and qualified refs within scope rules", () => {
	// Project scope can reference bare, global:, and project:
	const validProjectBindings = [
		{ ref: "fast-mode" },
		{ ref: "global:fast-mode" },
		{ ref: "project:local-mode" },
		{ ref: "mode-with-alias", id: "alias-id" },
		{ ref: "mode-callable", modelCallable: true },
	];

	for (const binding of validProjectBindings) {
		const diagnostics = validateInstructionModeBinding(binding, "project");
		assert.equal(diagnostics.length, 0, `Expected binding ${JSON.stringify(binding)} to be valid in project`);
	}

	// Global owner can reference bare or global:
	const validGlobalBindings = [
		{ ref: "fast-mode" },
		{ ref: "global:fast-mode" },
	];
	for (const binding of validGlobalBindings) {
		const diagnostics = validateInstructionModeBinding(binding, "global");
		assert.equal(diagnostics.length, 0, `Expected binding ${JSON.stringify(binding)} to be valid in global`);
	}

	// Global owner CANNOT reference project:
	const invalidGlobal = { ref: "project:local-mode" };
	const diag = validateInstructionModeBinding(invalidGlobal, "global");
	assert.ok(diag.some((d) => d.level === "error" && d.field === "ref" && d.message.includes("Global binding cannot reference project")));
});

test("17. validateInstructionModeBinding rejects malformed refs, IDs, and unknown fields", () => {
	const badBindings = [
		{ ref: "" },
		{ ref: "not:valid:scope:id" },
		{ ref: "unknownscope:id" },
		{ ref: "mode", id: "invalid ID with space" },
		{ ref: "mode", modelCallable: "yes" },
		{ ref: "mode", unknownField: "bad" },
		{ ref: "mode", overrides: { unknownOverrideField: true } },
		{ ref: "mode", overrides: { id: "cannot-patch-id" } },
		{ ref: "mode", overrides: { authorization: true } },
	];

	for (const bad of badBindings) {
		const diags = validateInstructionModeBinding(bad, "project");
		assert.ok(diags.some((d) => d.level === "error"), `Expected ${JSON.stringify(bad)} to fail binding validation`);
	}
});

test("18. applyInstructionModeOverrides rejects simultaneous content and appendContent", () => {
	const mode: InstructionMode = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "base-mode",
		content: "Base content",
		tools: { add: [], remove: [] },
	};

	const overrides: InstructionModeOverrides = {
		content: "Replaced content",
		appendContent: "Appended content",
	};

	const result = applyInstructionModeOverrides(mode, overrides);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.diagnostics.some((d) => d.level === "error" && d.message.includes("both content and appendContent")));
	}
});

test("19. applyInstructionModeOverrides applies content replacement and appendContent", () => {
	const baseMode: InstructionMode = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "base-mode",
		name: "Base",
		description: "Base description",
		content: "Primary instructions.",
		tools: { add: ["tool1"], remove: [] },
	};

	// Replacement
	const replaced = applyInstructionModeOverrides(baseMode, { content: "Completely new instructions." });
	assert.equal(replaced.ok, true);
	if (replaced.ok) {
		assert.equal(replaced.mode.content, "Completely new instructions.");
		assert.equal(replaced.mode.id, "base-mode");
		assert.equal(replaced.mode.name, "Base");
		assert.equal(replaced.mode.description, "Base description");
	}

	// Appending to non-empty
	const appended = applyInstructionModeOverrides(baseMode, { appendContent: "Additional guidelines." });
	assert.equal(appended.ok, true);
	if (appended.ok) {
		assert.equal(appended.mode.content, "Primary instructions.\n\nAdditional guidelines.");
	}

	// Appending to empty content
	const emptyBase: InstructionMode = {
		...baseMode,
		content: "",
	};
	const appendedToEmpty = applyInstructionModeOverrides(emptyBase, { appendContent: "First guidelines." });
	assert.equal(appendedToEmpty.ok, true);
	if (appendedToEmpty.ok) {
		assert.equal(appendedToEmpty.mode.content, "First guidelines.");
	}
});

test("20. applyInstructionModeOverrides replaces specified tool array without clearing the other", () => {
	const mode: InstructionMode = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "patch-mode",
		content: "Instructions",
		tools: {
			add: ["read", "search"],
			remove: ["dangerous_tool"],
		},
	};

	// Override only "add"
	const addOnly = applyInstructionModeOverrides(mode, {
		tools: { add: ["new_read"] },
	});
	assert.equal(addOnly.ok, true);
	if (addOnly.ok) {
		assert.deepEqual(addOnly.mode.tools.add, ["new_read"]);
		assert.deepEqual(addOnly.mode.tools.remove, ["dangerous_tool"], "remove array must be retained");
	}

	// Override only "remove"
	const removeOnly = applyInstructionModeOverrides(mode, {
		tools: { remove: ["other_tool"] },
	});
	assert.equal(removeOnly.ok, true);
	if (removeOnly.ok) {
		assert.deepEqual(removeOnly.mode.tools.add, ["read", "search"], "add array must be retained");
		assert.deepEqual(removeOnly.mode.tools.remove, ["other_tool"]);
	}
});

test("21. overlapping add/remove is preserved in mode", () => {
	const mode: InstructionMode = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "overlap-mode",
		content: "Has overlapping tools",
		tools: {
			add: ["bash", "read_file"],
			remove: ["bash", "write_file"],
		},
	};

	const validDiags = validateInstructionMode(mode);
	assert.equal(validDiags.length, 0, "Overlapping add/remove in patch is valid and preserved");
	assert.deepEqual(mode.tools.add, ["bash", "read_file"]);
	assert.deepEqual(mode.tools.remove, ["bash", "write_file"]);
});

test("22. applyInstructionModeOverrides guarantees immutability", () => {
	const originalAdd = ["tool_a", "tool_b"];
	const originalRemove = ["tool_c"];
	const mode: InstructionMode = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "immutable-mode",
		content: "Initial text",
		tools: {
			add: originalAdd,
			remove: originalRemove,
		},
	};

	const overrideAdd = ["tool_d"];
	const overrides: InstructionModeOverrides = {
		content: "Overridden text",
		tools: {
			add: overrideAdd,
		},
	};

	const result = applyInstructionModeOverrides(mode, overrides);
	assert.equal(result.ok, true);
	if (result.ok) {
		// Mutate caller input arrays
		overrideAdd.push("tool_e");
		originalAdd.push("tool_z");
		originalRemove.push("tool_y");

		// Resulting mode tools must not reflect mutations
		assert.deepEqual(result.mode.tools.add, ["tool_d"]);
		assert.deepEqual(result.mode.tools.remove, ["tool_c"]);

		// Original mode must not be mutated
		assert.equal(mode.content, "Initial text");
	}
});

test("23. applyInstructionModeOverrides fails closed when override empties both content and tools", () => {
	const mode: InstructionMode = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "edge-empty",
		content: "",
		tools: {
			add: ["only_tool"],
			remove: [],
		},
	};

	// Replacing add with empty array while content is empty leaves zero effect
	const result = applyInstructionModeOverrides(mode, {
		tools: { add: [] },
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.diagnostics.some((d) => d.level === "error" && d.message.includes("tool effect")));
	}
});

test("24. applyInstructionModeOverrides fails closed on bad base regardless of whether overrides is provided", () => {
	// Bad schemaVersion
	const badSchemaBase = {
		schemaVersion: 2,
		type: INSTRUCTION_MODE_TYPE,
		id: "bad-schema",
		content: "Valid content",
		tools: { add: [], remove: [] },
	} as unknown as InstructionMode;

	const noOverrideBadSchema = applyInstructionModeOverrides(badSchemaBase);
	assert.equal(noOverrideBadSchema.ok, false, "Should fail closed when overrides is absent");
	if (!noOverrideBadSchema.ok) {
		assert.ok(noOverrideBadSchema.diagnostics.some((d) => d.level === "error" && d.field === "schemaVersion"));
	}

	const withOverrideBadSchema = applyInstructionModeOverrides(badSchemaBase, { content: "New content" });
	assert.equal(withOverrideBadSchema.ok, false, "Should fail closed when overrides is present");
	if (!withOverrideBadSchema.ok) {
		assert.ok(withOverrideBadSchema.diagnostics.some((d) => d.level === "error" && d.field === "schemaVersion"));
	}

	// Unknown base field
	const unknownFieldBase = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "unknown-field",
		content: "Valid content",
		tools: { add: [], remove: [] },
		unknownBaseField: "not allowed",
	} as unknown as InstructionMode;

	const noOverrideUnknown = applyInstructionModeOverrides(unknownFieldBase);
	assert.equal(noOverrideUnknown.ok, false);
	if (!noOverrideUnknown.ok) {
		assert.ok(noOverrideUnknown.diagnostics.some((d) => d.level === "error" && d.field === "unknownBaseField"));
	}

	const withOverrideUnknown = applyInstructionModeOverrides(unknownFieldBase, { content: "New" });
	assert.equal(withOverrideUnknown.ok, false);
	if (!withOverrideUnknown.ok) {
		assert.ok(withOverrideUnknown.diagnostics.some((d) => d.level === "error" && d.field === "unknownBaseField"));
	}

	// Broken base content & tools cannot be repaired by overrides
	const emptyBase = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "empty-base",
		content: "",
		tools: { add: [], remove: [] },
	} as unknown as InstructionMode;

	const attemptRepair = applyInstructionModeOverrides(emptyBase, { content: "Trying to fix bad base" });
	assert.equal(attemptRepair.ok, false, "Overrides must not repair invalid base");
	if (!attemptRepair.ok) {
		assert.ok(attemptRepair.diagnostics.some((d) => d.level === "error" && d.message.includes("tool effect")));
	}
});

test("25. validateInstructionMode and applyInstructionModeOverrides handle omitted and partial tools without crashing", () => {
	// tools omitted entirely in validateInstructionMode
	const noTools = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "no-tools",
		content: "Valid content without tools",
	};
	const noToolsDiags = validateInstructionMode(noTools);
	assert.equal(noToolsDiags.length, 0);

	// tools: {} in validateInstructionMode
	const emptyTools = {
		...noTools,
		id: "empty-tools",
		tools: {},
	};
	const emptyToolsDiags = validateInstructionMode(emptyTools);
	assert.equal(emptyToolsDiags.length, 0);

	// tools with only add
	const partialAdd = {
		...noTools,
		id: "partial-add",
		tools: { add: ["search"] },
	};
	const partialAddDiags = validateInstructionMode(partialAdd);
	assert.equal(partialAddDiags.length, 0);

	// tools with only remove
	const partialRemove = {
		...noTools,
		id: "partial-remove",
		tools: { remove: ["bash"] },
	};
	const partialRemoveDiags = validateInstructionMode(partialRemove);
	assert.equal(partialRemoveDiags.length, 0);

	// applyInstructionModeOverrides on base with tools: {} does not crash reading undefined arrays
	const basePartialTools = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "base-partial",
		content: "Valid content",
		tools: {},
	} as unknown as InstructionMode;

	const appliedNoOverride = applyInstructionModeOverrides(basePartialTools);
	assert.equal(appliedNoOverride.ok, true);
	if (appliedNoOverride.ok) {
		assert.deepEqual(appliedNoOverride.mode.tools.add, []);
		assert.deepEqual(appliedNoOverride.mode.tools.remove, []);
	}

	const appliedWithOverride = applyInstructionModeOverrides(basePartialTools, {
		tools: { add: ["read"] },
	});
	assert.equal(appliedWithOverride.ok, true);
	if (appliedWithOverride.ok) {
		assert.deepEqual(appliedWithOverride.mode.tools.add, ["read"]);
		assert.deepEqual(appliedWithOverride.mode.tools.remove, []);
	}
});

test("26. plain object detection rejects Date, custom prototypes, and non-plain objects", () => {
	class CustomClass {
		schemaVersion = 1;
		type = INSTRUCTION_MODE_TYPE;
		id = "custom-class";
		content = "Some content";
		tools = { add: [], remove: [] };
	}

	// Rejects Date as root
	const dateRootDiags = validateInstructionMode(new Date());
	assert.ok(dateRootDiags.some((d) => d.level === "error" && d.message.includes("JSON object")));

	// Rejects custom class instance as root
	const customRootDiags = validateInstructionMode(new CustomClass());
	assert.ok(customRootDiags.some((d) => d.level === "error" && d.message.includes("JSON object")));

	// Rejects Date as tools
	const dateToolsDiags = validateInstructionMode({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "date-tools",
		content: "Valid content",
		tools: new Date(),
	});
	assert.ok(dateToolsDiags.some((d) => d.level === "error" && d.field === "tools" && d.message.includes("must be an object")));

	// Rejects custom prototype as tools
	class CustomToolsPatch {
		add = [];
		remove = [];
	}
	const customToolsDiags = validateInstructionMode({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "custom-tools",
		content: "Valid content",
		tools: new CustomToolsPatch(),
	});
	assert.ok(customToolsDiags.some((d) => d.level === "error" && d.field === "tools" && d.message.includes("must be an object")));

	// Binding rejects Date and custom class
	const dateBindingDiags = validateInstructionModeBinding(new Date(), "project");
	assert.ok(dateBindingDiags.some((d) => d.level === "error" && d.message.includes("must be an object")));

	class CustomBinding {
		ref = "mode-ref";
	}
	const customBindingDiags = validateInstructionModeBinding(new CustomBinding(), "project");
	assert.ok(customBindingDiags.some((d) => d.level === "error" && d.message.includes("must be an object")));

	// Overrides reject Date and custom prototype
	const validBase: InstructionMode = {
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "valid-base",
		content: "Valid base",
		tools: { add: [], remove: [] },
	};

	const dateOverride = applyInstructionModeOverrides(validBase, new Date() as unknown as InstructionModeOverrides);
	assert.equal(dateOverride.ok, false);
	if (!dateOverride.ok) {
		assert.ok(dateOverride.diagnostics.some((d) => d.level === "error" && d.field === "overrides"));
	}

	class CustomOverride {
		content = "custom";
	}
	const customOverride = applyInstructionModeOverrides(validBase, new CustomOverride() as unknown as InstructionModeOverrides);
	assert.equal(customOverride.ok, false);
	if (!customOverride.ok) {
		assert.ok(customOverride.diagnostics.some((d) => d.level === "error" && d.field === "overrides"));
	}

	const dateToolsOverride = applyInstructionModeOverrides(validBase, {
		tools: new Date() as unknown as any,
	});
	assert.equal(dateToolsOverride.ok, false);
	if (!dateToolsOverride.ok) {
		assert.ok(dateToolsOverride.diagnostics.some((d) => d.level === "error" && d.field === "overrides.tools"));
	}
});

test("27. MAX_MODE_NAME_LENGTH is enforced: reject names > 1000 characters", () => {
	assert.equal(MAX_MODE_NAME_LENGTH, 1000);

	const json1001 = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "name-1001",
		name: "n".repeat(1001),
		content: "Valid content",
	});
	const parsed1001 = parseInstructionMode(json1001, "name-1001.json", "project");
	assert.equal(isUsableInstructionMode(parsed1001), false);
	assert.ok(parsed1001.diagnostics.some((d) => d.field === "name" && d.message.includes("1000")));

	const json1000 = JSON.stringify({
		schemaVersion: 1,
		type: INSTRUCTION_MODE_TYPE,
		id: "name-1000",
		name: "n".repeat(1000),
		content: "Valid content",
	});
	const parsed1000 = parseInstructionMode(json1000, "name-1000.json", "project");
	assert.equal(isUsableInstructionMode(parsed1000), true);
	assert.equal(parsed1000.mode.name?.length, 1000);
});
