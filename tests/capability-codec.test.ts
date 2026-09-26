import assert from "node:assert/strict";
import test from "node:test";
import {
	applyCapabilityOverrides,
	createCapabilityFault,
	CAPABILITY_TYPE,
	isUsableCapability,
	MAX_CAPABILITY_NAME_LENGTH,
	parseCapability,
	serializeCapability,
	validateCapability,
	validateCapabilityBinding,
	type Capability,
	type CapabilityOverrides,
} from "../src/codecs/capability.ts";

test("1. parseCapability parses a complete valid instruction capability", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "strict-reviewer",
		name: "Strict Code Reviewer",
		description: "Enforces strict guidelines",
		content: "Review all changes with zero tolerance for bugs.",
		tools: {
			add: ["read_file", "search_repo"],
			remove: ["bash", "web_search"],
		},
	});

	const loaded = parseCapability(json, "/path/to/strict-reviewer.json", "project");
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(isUsableCapability(loaded), true);
	assert.equal(loaded.capability.id, "strict-reviewer");
	assert.equal(loaded.capability.name, "Strict Code Reviewer");
	assert.equal(loaded.capability.description, "Enforces strict guidelines");
	assert.equal(loaded.capability.content, "Review all changes with zero tolerance for bugs.");
	assert.deepEqual(loaded.capability.tools.add, ["read_file", "search_repo"]);
	assert.deepEqual(loaded.capability.tools.remove, ["bash", "web_search"]);
	assert.equal(loaded.scope, "project");
	assert.deepEqual(loaded.key, { scope: "project", id: "strict-reviewer" });
});

test("2. parseCapability normalizes omitted tools to empty arrays", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "prompt-only",
		content: "You are a writing assistant.",
	});

	const loaded = parseCapability(json, "prompt-only.json", "global");
	assert.equal(loaded.diagnostics.length, 0);
	assert.deepEqual(loaded.capability.tools, { add: [], remove: [] });
	assert.equal(loaded.capability.id, "prompt-only");
});

test("3. parseCapability preserves raw whitespace in content", () => {
	const rawContent = "\n\n   ### System Directive:\n\t- Line 1\n\t- Line 2\n\n   ";
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "raw-whitespace",
		content: rawContent,
	});

	const loaded = parseCapability(json, "raw-whitespace.json", "project");
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(loaded.capability.content, rawContent);
});

test("4. parseCapability permits empty content if tools effect exists", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "tool-modifier-only",
		content: "",
		tools: {
			add: ["custom_tool"],
			remove: [],
		},
	});

	const loaded = parseCapability(json, "tool-modifier-only.json", "project");
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(loaded.capability.content, "");
	assert.deepEqual(loaded.capability.tools.add, ["custom_tool"]);
});

test("5. parseCapability rejects capability with neither content nor tool effects", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "no-effect",
		content: "   ",
		tools: {
			add: [],
			remove: [],
		},
	});

	const loaded = parseCapability(json, "no-effect.json", "project");
	assert.equal(isUsableCapability(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.message.includes("tool effect")));
});

test("6. parseCapability rejects invalid resource id", () => {
	const badIds = ["-bad-start", "has:colon", "has space", "", "tool/slash"];
	for (const id of badIds) {
		const json = JSON.stringify({
			schemaVersion: 1,
			type: CAPABILITY_TYPE,
			id,
			content: "Test",
		});
		const loaded = parseCapability(json, "test.json", "project");
		assert.equal(isUsableCapability(loaded), false);
		assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "id"));
	}
});

test("7. parseCapability strictly rejects unknown fields on root and tools", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "strict-check",
		content: "Valid",
		extraRootField: "rejected",
		tools: {
			add: [],
			remove: [],
			extraToolField: "rejected",
		},
	});

	const loaded = parseCapability(json, "strict-check.json", "project");
	assert.equal(isUsableCapability(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "extraRootField"));
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "tools.extraToolField"));
});

test("8. parseCapability rejects authorization and modelCallable in capability definition", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "auth-probe",
		content: "Valid content",
		authorization: "admin",
		modelCallable: true,
	});

	const loaded = parseCapability(json, "auth-probe.json", "project");
	assert.equal(isUsableCapability(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "authorization"));
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "modelCallable"));
});

test("9. parseCapability validates tool name syntax and forbids wildcards/whitespace/control", () => {
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
			type: CAPABILITY_TYPE,
			id: "tool-name-test",
			content: "Valid",
			tools: {
				add: [badTool],
				remove: [],
			},
		});
		const loaded = parseCapability(json, "tool-name-test.json", "project");
		assert.equal(isUsableCapability(loaded), false, `Tool name "${badTool}" should be rejected`);
		assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field?.startsWith("tools.")));
	}
});

test("10. parseCapability rejects non-string tool array elements", () => {
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "non-string-tool",
		content: "Valid",
		tools: {
			add: [123, null, { name: "tool" }],
			remove: [],
		},
	});

	const loaded = parseCapability(json, "non-string-tool.json", "project");
	assert.equal(isUsableCapability(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "tools.add[0]"));
});

test("11. parseCapability rejects tool array exceeding 256 items", () => {
	const tooManyTools = Array.from({ length: 257 }, (_, i) => `tool_${i}`);
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "huge-tools",
		content: "Valid",
		tools: {
			add: tooManyTools,
			remove: [],
		},
	});

	const loaded = parseCapability(json, "huge-tools.json", "project");
	assert.equal(isUsableCapability(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "tools.add"));
});

test("12. parseCapability rejects content exceeding 100000 characters", () => {
	const hugeContent = "x".repeat(100_001);
	const json = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "huge-content",
		content: hugeContent,
	});

	const loaded = parseCapability(json, "huge-content.json", "project");
	assert.equal(isUsableCapability(loaded), false);
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.field === "content"));
});

test("13. parseCapability and createCapabilityFault handle invalid JSON fail-closed", () => {
	const loaded = parseCapability("{ malformed json ...", "/modes/broken.json", "project");
	assert.equal(isUsableCapability(loaded), false);
	assert.equal(loaded.capability.id, "broken");
	assert.equal(loaded.filePath, "/modes/broken.json");
	assert.ok(loaded.diagnostics.some((d) => d.level === "error" && d.message.includes("JSON")));

	const fault = createCapabilityFault("/modes/faulty.json", "global", "File missing");
	assert.equal(isUsableCapability(fault), false);
	assert.equal(fault.capability.id, "faulty");
	assert.equal(fault.scope, "global");
	assert.deepEqual(fault.key, { scope: "global", id: "faulty" });
	assert.equal(fault.diagnostics[0]?.message, "File missing");
});

test("14. serializeCapability round-trips cleanly", () => {
	const capability: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "roundtrip-capability",
		name: "Roundtrip Test",
		description: "Tests serialization fidelity",
		content: "Preserve all chars and indent.",
		tools: {
			add: ["tool_a", "tool_b"],
			remove: ["tool_c"],
		},
	};

	const serialized = serializeCapability(capability);
	assert.ok(serialized.endsWith("\n"));

	const loaded = parseCapability(serialized, "roundtrip.json", "project");
	assert.equal(loaded.diagnostics.length, 0);
	assert.deepEqual(loaded.capability, capability);
});

test("15. validateCapability rejects non-objects and bad schemaVersion / type", () => {
	assert.ok(validateCapability(null).some((d) => d.level === "error"));
	assert.ok(validateCapability("not an object").some((d) => d.level === "error"));
	assert.ok(validateCapability([]).some((d) => d.level === "error"));

	const badSchema = {
		schemaVersion: 2,
		type: CAPABILITY_TYPE,
		id: "valid-id",
		content: "hello",
		tools: { add: [], remove: [] },
	};
	assert.ok(validateCapability(badSchema).some((d) => d.level === "error" && d.field === "schemaVersion"));

	const badType = {
		schemaVersion: 1,
		type: "unknown-type",
		id: "valid-id",
		content: "hello",
		tools: { add: [], remove: [] },
	};
	assert.ok(validateCapability(badType).some((d) => d.level === "error" && d.field === "type"));
});

test("16. validateCapabilityBinding accepts bare and qualified refs within scope rules", () => {
	// Project scope can reference bare, global:, and project:
	const validProjectBindings = [
		{ ref: "fast-capability" },
		{ ref: "global:fast-capability" },
		{ ref: "project:local-capability" },
		{ ref: "capability-with-alias", id: "alias-id" },
		{ ref: "capability-callable", modelCallable: true },
	];

	for (const binding of validProjectBindings) {
		const diagnostics = validateCapabilityBinding(binding, "project");
		assert.equal(diagnostics.length, 0, `Expected binding ${JSON.stringify(binding)} to be valid in project`);
	}

	// Global owner can reference bare or global:
	const validGlobalBindings = [
		{ ref: "fast-capability" },
		{ ref: "global:fast-capability" },
	];
	for (const binding of validGlobalBindings) {
		const diagnostics = validateCapabilityBinding(binding, "global");
		assert.equal(diagnostics.length, 0, `Expected binding ${JSON.stringify(binding)} to be valid in global`);
	}

	// Global owner CANNOT reference project:
	const invalidGlobal = { ref: "project:local-capability" };
	const diag = validateCapabilityBinding(invalidGlobal, "global");
	assert.ok(diag.some((d) => d.level === "error" && d.field === "ref" && d.message.includes("Global binding cannot reference project")));
});

test("17. validateCapabilityBinding rejects malformed refs, IDs, and unknown fields", () => {
	const badBindings = [
		{ ref: "" },
		{ ref: "not:valid:scope:id" },
		{ ref: "unknownscope:id" },
		{ ref: "capability", id: "invalid ID with space" },
		{ ref: "capability", modelCallable: "yes" },
		{ ref: "capability", unknownField: "bad" },
		{ ref: "capability", overrides: { unknownOverrideField: true } },
		{ ref: "capability", overrides: { id: "cannot-patch-id" } },
		{ ref: "capability", overrides: { authorization: true } },
	];

	for (const bad of badBindings) {
		const diags = validateCapabilityBinding(bad, "project");
		assert.ok(diags.some((d) => d.level === "error"), `Expected ${JSON.stringify(bad)} to fail binding validation`);
	}
});

test("18. applyCapabilityOverrides rejects simultaneous content and appendContent", () => {
	const capability: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "base-capability",
		content: "Base content",
		tools: { add: [], remove: [] },
	};

	const overrides: CapabilityOverrides = {
		content: "Replaced content",
		appendContent: "Appended content",
	};

	const result = applyCapabilityOverrides(capability, overrides);
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.diagnostics.some((d) => d.level === "error" && d.message.includes("both content and appendContent")));
	}
});

test("19. applyCapabilityOverrides applies content replacement and appendContent", () => {
	const baseMode: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "base-capability",
		name: "Base",
		description: "Base description",
		content: "Primary instructions.",
		tools: { add: ["tool1"], remove: [] },
	};

	// Replacement
	const replaced = applyCapabilityOverrides(baseMode, { content: "Completely new instructions." });
	assert.equal(replaced.ok, true);
	if (replaced.ok) {
		assert.equal(replaced.capability.content, "Completely new instructions.");
		assert.equal(replaced.capability.id, "base-capability");
		assert.equal(replaced.capability.name, "Base");
		assert.equal(replaced.capability.description, "Base description");
	}

	// Appending to non-empty
	const appended = applyCapabilityOverrides(baseMode, { appendContent: "Additional guidelines." });
	assert.equal(appended.ok, true);
	if (appended.ok) {
		assert.equal(appended.capability.content, "Primary instructions.\n\nAdditional guidelines.");
	}

	// Appending to empty content
	const emptyBase: Capability = {
		...baseMode,
		content: "",
	};
	const appendedToEmpty = applyCapabilityOverrides(emptyBase, { appendContent: "First guidelines." });
	assert.equal(appendedToEmpty.ok, true);
	if (appendedToEmpty.ok) {
		assert.equal(appendedToEmpty.capability.content, "First guidelines.");
	}
});

test("20. applyCapabilityOverrides replaces specified tool array without clearing the other", () => {
	const capability: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "patch-capability",
		content: "Capabilities",
		tools: {
			add: ["read", "search"],
			remove: ["dangerous_tool"],
		},
	};

	// Override only "add"
	const addOnly = applyCapabilityOverrides(capability, {
		tools: { add: ["new_read"] },
	});
	assert.equal(addOnly.ok, true);
	if (addOnly.ok) {
		assert.deepEqual(addOnly.capability.tools.add, ["new_read"]);
		assert.deepEqual(addOnly.capability.tools.remove, ["dangerous_tool"], "remove array must be retained");
	}

	// Override only "remove"
	const removeOnly = applyCapabilityOverrides(capability, {
		tools: { remove: ["other_tool"] },
	});
	assert.equal(removeOnly.ok, true);
	if (removeOnly.ok) {
		assert.deepEqual(removeOnly.capability.tools.add, ["read", "search"], "add array must be retained");
		assert.deepEqual(removeOnly.capability.tools.remove, ["other_tool"]);
	}
});

test("21. overlapping add/remove is preserved in capability", () => {
	const capability: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "overlap-capability",
		content: "Has overlapping tools",
		tools: {
			add: ["bash", "read_file"],
			remove: ["bash", "write_file"],
		},
	};

	const validDiags = validateCapability(capability);
	assert.equal(validDiags.length, 0, "Overlapping add/remove in patch is valid and preserved");
	assert.deepEqual(capability.tools.add, ["bash", "read_file"]);
	assert.deepEqual(capability.tools.remove, ["bash", "write_file"]);
});

test("22. applyCapabilityOverrides guarantees immutability", () => {
	const originalAdd = ["tool_a", "tool_b"];
	const originalRemove = ["tool_c"];
	const capability: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "immutable-capability",
		content: "Initial text",
		tools: {
			add: originalAdd,
			remove: originalRemove,
		},
	};

	const overrideAdd = ["tool_d"];
	const overrides: CapabilityOverrides = {
		content: "Overridden text",
		tools: {
			add: overrideAdd,
		},
	};

	const result = applyCapabilityOverrides(capability, overrides);
	assert.equal(result.ok, true);
	if (result.ok) {
		// Mutate caller input arrays
		overrideAdd.push("tool_e");
		originalAdd.push("tool_z");
		originalRemove.push("tool_y");

		// Resulting capability tools must not reflect mutations
		assert.deepEqual(result.capability.tools.add, ["tool_d"]);
		assert.deepEqual(result.capability.tools.remove, ["tool_c"]);

		// Original capability must not be mutated
		assert.equal(capability.content, "Initial text");
	}
});

test("23. applyCapabilityOverrides fails closed when override empties both content and tools", () => {
	const capability: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "edge-empty",
		content: "",
		tools: {
			add: ["only_tool"],
			remove: [],
		},
	};

	// Replacing add with empty array while content is empty leaves zero effect
	const result = applyCapabilityOverrides(capability, {
		tools: { add: [] },
	});
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.ok(result.diagnostics.some((d) => d.level === "error" && d.message.includes("tool effect")));
	}
});

test("24. applyCapabilityOverrides fails closed on bad base regardless of whether overrides is provided", () => {
	// Bad schemaVersion
	const badSchemaBase = {
		schemaVersion: 2,
		type: CAPABILITY_TYPE,
		id: "bad-schema",
		content: "Valid content",
		tools: { add: [], remove: [] },
	} as unknown as Capability;

	const noOverrideBadSchema = applyCapabilityOverrides(badSchemaBase);
	assert.equal(noOverrideBadSchema.ok, false, "Should fail closed when overrides is absent");
	if (!noOverrideBadSchema.ok) {
		assert.ok(noOverrideBadSchema.diagnostics.some((d) => d.level === "error" && d.field === "schemaVersion"));
	}

	const withOverrideBadSchema = applyCapabilityOverrides(badSchemaBase, { content: "New content" });
	assert.equal(withOverrideBadSchema.ok, false, "Should fail closed when overrides is present");
	if (!withOverrideBadSchema.ok) {
		assert.ok(withOverrideBadSchema.diagnostics.some((d) => d.level === "error" && d.field === "schemaVersion"));
	}

	// Unknown base field
	const unknownFieldBase = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "unknown-field",
		content: "Valid content",
		tools: { add: [], remove: [] },
		unknownBaseField: "not allowed",
	} as unknown as Capability;

	const noOverrideUnknown = applyCapabilityOverrides(unknownFieldBase);
	assert.equal(noOverrideUnknown.ok, false);
	if (!noOverrideUnknown.ok) {
		assert.ok(noOverrideUnknown.diagnostics.some((d) => d.level === "error" && d.field === "unknownBaseField"));
	}

	const withOverrideUnknown = applyCapabilityOverrides(unknownFieldBase, { content: "New" });
	assert.equal(withOverrideUnknown.ok, false);
	if (!withOverrideUnknown.ok) {
		assert.ok(withOverrideUnknown.diagnostics.some((d) => d.level === "error" && d.field === "unknownBaseField"));
	}

	// Broken base content & tools cannot be repaired by overrides
	const emptyBase = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "empty-base",
		content: "",
		tools: { add: [], remove: [] },
	} as unknown as Capability;

	const attemptRepair = applyCapabilityOverrides(emptyBase, { content: "Trying to fix bad base" });
	assert.equal(attemptRepair.ok, false, "Overrides must not repair invalid base");
	if (!attemptRepair.ok) {
		assert.ok(attemptRepair.diagnostics.some((d) => d.level === "error" && d.message.includes("tool effect")));
	}
});

test("25. validateCapability and applyCapabilityOverrides handle omitted and partial tools without crashing", () => {
	// tools omitted entirely in validateCapability
	const noTools = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "no-tools",
		content: "Valid content without tools",
	};
	const noToolsDiags = validateCapability(noTools);
	assert.equal(noToolsDiags.length, 0);

	// tools: {} in validateCapability
	const emptyTools = {
		...noTools,
		id: "empty-tools",
		tools: {},
	};
	const emptyToolsDiags = validateCapability(emptyTools);
	assert.equal(emptyToolsDiags.length, 0);

	// tools with only add
	const partialAdd = {
		...noTools,
		id: "partial-add",
		tools: { add: ["search"] },
	};
	const partialAddDiags = validateCapability(partialAdd);
	assert.equal(partialAddDiags.length, 0);

	// tools with only remove
	const partialRemove = {
		...noTools,
		id: "partial-remove",
		tools: { remove: ["bash"] },
	};
	const partialRemoveDiags = validateCapability(partialRemove);
	assert.equal(partialRemoveDiags.length, 0);

	// applyCapabilityOverrides on base with tools: {} does not crash reading undefined arrays
	const basePartialTools = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "base-partial",
		content: "Valid content",
		tools: {},
	} as unknown as Capability;

	const appliedNoOverride = applyCapabilityOverrides(basePartialTools);
	assert.equal(appliedNoOverride.ok, true);
	if (appliedNoOverride.ok) {
		assert.deepEqual(appliedNoOverride.capability.tools.add, []);
		assert.deepEqual(appliedNoOverride.capability.tools.remove, []);
	}

	const appliedWithOverride = applyCapabilityOverrides(basePartialTools, {
		tools: { add: ["read"] },
	});
	assert.equal(appliedWithOverride.ok, true);
	if (appliedWithOverride.ok) {
		assert.deepEqual(appliedWithOverride.capability.tools.add, ["read"]);
		assert.deepEqual(appliedWithOverride.capability.tools.remove, []);
	}
});

test("26. plain object detection rejects Date, custom prototypes, and non-plain objects", () => {
	class CustomClass {
		schemaVersion = 1;
		type = CAPABILITY_TYPE;
		id = "custom-class";
		content = "Some content";
		tools = { add: [], remove: [] };
	}

	// Rejects Date as root
	const dateRootDiags = validateCapability(new Date());
	assert.ok(dateRootDiags.some((d) => d.level === "error" && d.message.includes("JSON object")));

	// Rejects custom class instance as root
	const customRootDiags = validateCapability(new CustomClass());
	assert.ok(customRootDiags.some((d) => d.level === "error" && d.message.includes("JSON object")));

	// Rejects Date as tools
	const dateToolsDiags = validateCapability({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
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
	const customToolsDiags = validateCapability({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "custom-tools",
		content: "Valid content",
		tools: new CustomToolsPatch(),
	});
	assert.ok(customToolsDiags.some((d) => d.level === "error" && d.field === "tools" && d.message.includes("must be an object")));

	// Binding rejects Date and custom class
	const dateBindingDiags = validateCapabilityBinding(new Date(), "project");
	assert.ok(dateBindingDiags.some((d) => d.level === "error" && d.message.includes("must be an object")));

	class CustomBinding {
		ref = "capability-ref";
	}
	const customBindingDiags = validateCapabilityBinding(new CustomBinding(), "project");
	assert.ok(customBindingDiags.some((d) => d.level === "error" && d.message.includes("must be an object")));

	// Overrides reject Date and custom prototype
	const validBase: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "valid-base",
		content: "Valid base",
		tools: { add: [], remove: [] },
	};

	const dateOverride = applyCapabilityOverrides(validBase, new Date() as unknown as CapabilityOverrides);
	assert.equal(dateOverride.ok, false);
	if (!dateOverride.ok) {
		assert.ok(dateOverride.diagnostics.some((d) => d.level === "error" && d.field === "overrides"));
	}

	class CustomOverride {
		content = "custom";
	}
	const customOverride = applyCapabilityOverrides(validBase, new CustomOverride() as unknown as CapabilityOverrides);
	assert.equal(customOverride.ok, false);
	if (!customOverride.ok) {
		assert.ok(customOverride.diagnostics.some((d) => d.level === "error" && d.field === "overrides"));
	}

	const dateToolsOverride = applyCapabilityOverrides(validBase, {
		tools: new Date() as unknown as any,
	});
	assert.equal(dateToolsOverride.ok, false);
	if (!dateToolsOverride.ok) {
		assert.ok(dateToolsOverride.diagnostics.some((d) => d.level === "error" && d.field === "overrides.tools"));
	}
});

test("27. MAX_CAPABILITY_NAME_LENGTH is enforced: reject names > 1000 characters", () => {
	assert.equal(MAX_CAPABILITY_NAME_LENGTH, 1000);

	const json1001 = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "name-1001",
		name: "n".repeat(1001),
		content: "Valid content",
	});
	const parsed1001 = parseCapability(json1001, "name-1001.json", "project");
	assert.equal(isUsableCapability(parsed1001), false);
	assert.ok(parsed1001.diagnostics.some((d) => d.field === "name" && d.message.includes("1000")));

	const json1000 = JSON.stringify({
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: "name-1000",
		name: "n".repeat(1000),
		content: "Valid content",
	});
	const parsed1000 = parseCapability(json1000, "name-1000.json", "project");
	assert.equal(isUsableCapability(parsed1000), true);
	assert.equal(parsed1000.capability.name?.length, 1000);
});
