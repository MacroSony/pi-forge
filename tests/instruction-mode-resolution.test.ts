import assert from "node:assert/strict";
import test from "node:test";
import { createResourceCatalog } from "../src/catalog.ts";
import {
	INSTRUCTION_MODE_TYPE,
	type Diagnostic,
	type InstructionModeBinding,
	type LoadedInstructionMode,
} from "../src/codecs/instruction-mode.ts";
import {
	MAX_INSTRUCTION_MODE_BINDINGS,
	resolveInstructionMode,
	resolveInstructionModeBindings,
} from "../src/instruction-modes.ts";
import type { ResourceKey, ResourceScope } from "../src/resource-identity.ts";

function createLoadedMode(
	scope: ResourceScope,
	id: string,
	options: {
		content?: string;
		tools?: { add: string[]; remove: string[] };
		diagnostics?: Diagnostic[];
	} = {},
): LoadedInstructionMode {
	return {
		key: { scope, id },
		scope,
		filePath: `/${scope}/modes/${id}.json`,
		mode: {
			schemaVersion: 1,
			type: INSTRUCTION_MODE_TYPE,
			id,
			content: options.content ?? `Default content for ${id}`,
			tools: options.tools ?? { add: [], remove: [] },
		},
		diagnostics: options.diagnostics ?? [],
	};
}

test("1. direct bare selector resolves project-over-global, falls back to global if no project", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "shared", { content: "global shared" }),
		createLoadedMode("project", "shared", { content: "project shared" }),
		createLoadedMode("global", "only-global", { content: "global only" }),
	]);

	const resShared = resolveInstructionMode(catalog, "shared");
	assert.equal(resShared.ok, true);
	if (resShared.ok) {
		assert.equal(resShared.loaded.scope, "project");
		assert.equal(resShared.loaded.mode.content, "project shared");
	}

	const resGlobal = resolveInstructionMode(catalog, "only-global");
	assert.equal(resGlobal.ok, true);
	if (resGlobal.ok) {
		assert.equal(resGlobal.loaded.scope, "global");
		assert.equal(resGlobal.loaded.mode.content, "global only");
	}
});

test("2. exact scope selector targets specific scope and global cannot be hijacked by project", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "audit", { content: "global audit" }),
		createLoadedMode("project", "audit", { content: "project audit" }),
	]);

	const exactGlobal = resolveInstructionMode(catalog, "global:audit");
	assert.equal(exactGlobal.ok, true);
	if (exactGlobal.ok) {
		assert.equal(exactGlobal.loaded.scope, "global");
		assert.equal(exactGlobal.loaded.mode.content, "global audit");
	}

	const exactProject = resolveInstructionMode(catalog, "project:audit");
	assert.equal(exactProject.ok, true);
	if (exactProject.ok) {
		assert.equal(exactProject.loaded.scope, "project");
		assert.equal(exactProject.loaded.mode.content, "project audit");
	}
});

test("3. invalid local shadow does not fall back to global", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "architect", { content: "valid global architect" }),
		createLoadedMode("project", "architect", {
			content: "",
			diagnostics: [{ level: "error", message: "Invalid syntax in project architect" }],
		}),
	]);

	const bare = resolveInstructionMode(catalog, "architect");
	assert.equal(bare.ok, false);
	if (!bare.ok) {
		assert.match(bare.error, /project:architect.*errors.*Invalid syntax/);
	}

	const preset: ResourceKey = { scope: "project", id: "main-preset" };
	const bindings: InstructionModeBinding[] = [{ ref: "architect" }];
	const resBindings = resolveInstructionModeBindings(catalog, preset, bindings);
	assert.equal(resBindings.ok, false);
	if (!resBindings.ok) {
		assert.match(resBindings.error, /project:architect.*errors.*Invalid syntax/);
		assert.equal(resBindings.index, 0);
	}
});

test("4. duplicated local in catalog fails closed and does not fall back to global", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "dup", { content: "global dup" }),
		createLoadedMode("project", "dup", { content: "project dup 1" }),
		createLoadedMode("project", "dup", { content: "project dup 2" }),
	]);

	const resMode = resolveInstructionMode(catalog, "dup");
	assert.equal(resMode.ok, false);
	if (!resMode.ok) {
		assert.match(resMode.error, /Ambiguous instruction mode "project:dup"/);
	}

	const preset: ResourceKey = { scope: "project", id: "main-preset" };
	const resBindings = resolveInstructionModeBindings(catalog, preset, [{ ref: "dup" }]);
	assert.equal(resBindings.ok, false);
	if (!resBindings.ok) {
		assert.match(resBindings.error, /Ambiguous instruction mode "project:dup"/);
		assert.equal(resBindings.index, 0);
	}
});

test("5. missing resource prompt includes qualified scope:id", () => {
	const catalog = createResourceCatalog<LoadedInstructionMode>([]);

	const directRes = resolveInstructionMode(catalog, "project:nonexistent");
	assert.equal(directRes.ok, false);
	if (!directRes.ok) {
		assert.equal(directRes.error, 'Instruction mode "project:nonexistent" not found.');
	}

	const projPreset: ResourceKey = { scope: "project", id: "p-preset" };
	const bindingRes = resolveInstructionModeBindings(catalog, projPreset, [{ ref: "missing-one" }]);
	assert.equal(bindingRes.ok, false);
	if (!bindingRes.ok) {
		assert.equal(bindingRes.error, 'Instruction mode "project:missing-one" not found.');
		assert.equal(bindingRes.index, 0);
	}

	const globalPreset: ResourceKey = { scope: "global", id: "g-preset" };
	const globalBindingRes = resolveInstructionModeBindings(catalog, globalPreset, [{ ref: "missing-two" }]);
	assert.equal(globalBindingRes.ok, false);
	if (!globalBindingRes.ok) {
		assert.equal(globalBindingRes.error, 'Instruction mode "global:missing-two" not found.');
		assert.equal(globalBindingRes.index, 0);
	}
});

test("6. project preset bare ref strictly uses preset scope and does not fall back to global", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "helper", { content: "global helper" }),
	]);

	const projPreset: ResourceKey = { scope: "project", id: "my-preset" };
	const res = resolveInstructionModeBindings(catalog, projPreset, [{ ref: "helper" }]);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.equal(res.error, 'Instruction mode "project:helper" not found.');
		assert.equal(res.index, 0);
	}
});

test("7. explicit global ref works in project preset", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "shared-util", { content: "global utility mode" }),
	]);

	const projPreset: ResourceKey = { scope: "project", id: "my-preset" };
	const res = resolveInstructionModeBindings(catalog, projPreset, [{ ref: "global:shared-util" }]);
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(res.bindings.length, 1);
		assert.equal(res.bindings[0].id, "shared-util");
		assert.deepEqual(res.bindings[0].ref, { scope: "global", id: "shared-util" });
		assert.deepEqual(res.bindings[0].preset, { scope: "project", id: "my-preset" });
		assert.equal(res.bindings[0].mode.content, "global utility mode");
	}
});

test("8. global preset cannot bind project instruction mode", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("project", "local-mode", { content: "project mode" }),
	]);

	const globalPreset: ResourceKey = { scope: "global", id: "root" };
	const res = resolveInstructionModeBindings(catalog, globalPreset, [{ ref: "project:local-mode" }]);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.match(res.error, /Global binding cannot reference project instruction mode/);
		assert.equal(res.index, 0);
	}
});

test("9. duplicate default id rejected and explicit id avoids collision", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("project", "tool-mode", { content: "project tool mode" }),
		createLoadedMode("global", "tool-mode", { content: "global tool mode" }),
	]);

	const projPreset: ResourceKey = { scope: "project", id: "p1" };

	// Both default to effective id "tool-mode"
	const colliding = resolveInstructionModeBindings(catalog, projPreset, [
		{ ref: "tool-mode" },
		{ ref: "global:tool-mode" },
	]);
	assert.equal(colliding.ok, false);
	if (!colliding.ok) {
		assert.equal(colliding.error, 'Duplicate binding id "tool-mode" at index 1.');
		assert.equal(colliding.index, 1);
	}

	// Explicit id on one of them evades collision
	const nonColliding = resolveInstructionModeBindings(catalog, projPreset, [
		{ ref: "tool-mode" },
		{ ref: "global:tool-mode", id: "global-tool-mode" },
	]);
	assert.equal(nonColliding.ok, true);
	if (nonColliding.ok) {
		assert.equal(nonColliding.bindings.length, 2);
		assert.equal(nonColliding.bindings[0].id, "tool-mode");
		assert.equal(nonColliding.bindings[1].id, "global-tool-mode");
	}
});

test("10. modelCallable is strictly true only when explicit true; defaults to false", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("project", "m1", { content: "mode 1" }),
		createLoadedMode("project", "m2", { content: "mode 2" }),
		createLoadedMode("project", "m3", { content: "mode 3" }),
	]);

	const preset: ResourceKey = { scope: "project", id: "p1" };
	const res = resolveInstructionModeBindings(catalog, preset, [
		{ ref: "m1" },
		{ ref: "m2", modelCallable: false },
		{ ref: "m3", modelCallable: true },
	]);

	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(res.bindings[0].modelCallable, false);
		assert.equal(res.bindings[1].modelCallable, false);
		assert.equal(res.bindings[2].modelCallable, true);
	}
});

test("11. overrides do not mutate source loaded mode in catalog", () => {
	const originalMode = createLoadedMode("project", "custom", {
		content: "Original Content",
		tools: { add: ["base_tool"], remove: [] },
	});
	const catalog = createResourceCatalog([originalMode]);

	const preset: ResourceKey = { scope: "project", id: "p1" };
	const res = resolveInstructionModeBindings(catalog, preset, [
		{
			ref: "custom",
			overrides: {
				content: "Modified Content",
				tools: { add: ["extra_tool"], remove: ["base_tool"] },
			},
		},
	]);

	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(res.bindings[0].mode.content, "Modified Content");
		assert.deepEqual(res.bindings[0].mode.tools.add, ["extra_tool"]);
		assert.deepEqual(res.bindings[0].mode.tools.remove, ["base_tool"]);
	}

	// Verify catalog source was NOT mutated
	assert.equal(originalMode.mode.content, "Original Content");
	assert.deepEqual(originalMode.mode.tools.add, ["base_tool"]);
	assert.deepEqual(originalMode.mode.tools.remove, []);
});

test("12. non-array / null / invalid binding fields fail without throwing", () => {
	const catalog = createResourceCatalog<LoadedInstructionMode>([]);
	const preset: ResourceKey = { scope: "project", id: "p1" };

	assert.equal(resolveInstructionModeBindings(catalog, preset, null as unknown as InstructionModeBinding[]).ok, false);
	assert.equal(resolveInstructionModeBindings(catalog, preset, undefined as unknown as InstructionModeBinding[]).ok, false);
	assert.equal(resolveInstructionModeBindings(catalog, preset, {} as unknown as InstructionModeBinding[]).ok, false);

	// Invalid preset
	assert.equal(resolveInstructionModeBindings(catalog, null as unknown as ResourceKey, []).ok, false);
	assert.equal(resolveInstructionModeBindings(catalog, { scope: "bad" as unknown as ResourceScope, id: "p" }, []).ok, false);
	assert.equal(resolveInstructionModeBindings(catalog, { scope: "project", id: "bad:id" }, []).ok, false);

	// Invalid binding fields
	const badFieldRes = resolveInstructionModeBindings(catalog, preset, [
		{ ref: "valid", extraUnauthorized: 123 } as unknown as InstructionModeBinding,
	]);
	assert.equal(badFieldRes.ok, false);
	if (!badFieldRes.ok) {
		assert.match(badFieldRes.error, /Unsupported binding field: extraUnauthorized/);
		assert.equal(badFieldRes.index, 0);
	}

	// Invalid modelCallable non-boolean
	const badModelCallable = resolveInstructionModeBindings(catalog, preset, [
		{ ref: "valid", modelCallable: "yes" } as unknown as InstructionModeBinding,
	]);
	assert.equal(badModelCallable.ok, false);
	if (!badModelCallable.ok) {
		assert.match(badModelCallable.error, /modelCallable must be a boolean/);
		assert.equal(badModelCallable.index, 0);
	}
});

test("13. output snapshot is deeply frozen and does not freeze catalog inputs", () => {
	const loaded = createLoadedMode("project", "freezable", {
		content: "Freeze Test Content",
		tools: { add: ["t1"], remove: [] },
	});
	const catalog = createResourceCatalog([loaded]);
	const preset: ResourceKey = { scope: "project", id: "p1" };

	const res = resolveInstructionModeBindings(catalog, preset, [{ ref: "freezable" }]);
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(Object.isFrozen(res.bindings), true);
		assert.equal(Object.isFrozen(res.bindings[0]), true);
		assert.equal(Object.isFrozen(res.bindings[0].ref), true);
		assert.equal(Object.isFrozen(res.bindings[0].preset), true);
		assert.equal(Object.isFrozen(res.bindings[0].mode), true);
		assert.equal(Object.isFrozen(res.bindings[0].mode.tools), true);
		assert.equal(Object.isFrozen(res.bindings[0].mode.tools.add), true);
		assert.equal(Object.isFrozen(res.bindings[0].mode.tools.remove), true);

		assert.throws(() => {
			(res.bindings[0].mode as { content: string }).content = "mutation";
		}, TypeError);
	}

	// Catalog input must NOT be frozen
	assert.equal(Object.isFrozen(loaded), false);
	assert.equal(Object.isFrozen(loaded.mode), false);
	assert.equal(Object.isFrozen(loaded.mode.tools), false);
	assert.equal(Object.isFrozen(loaded.mode.tools.add), false);
	assert.equal(Object.isFrozen(catalog.all), false);
});

test("14. maximum 256 bindings limit is enforced", () => {
	const catalog = createResourceCatalog<LoadedInstructionMode>([]);
	const preset: ResourceKey = { scope: "project", id: "p1" };

	const bindings: InstructionModeBinding[] = Array.from(
		{ length: MAX_INSTRUCTION_MODE_BINDINGS + 1 },
		(_, i) => ({ ref: `mode-${i}` }),
	);

	const res = resolveInstructionModeBindings(catalog, preset, bindings);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.match(res.error, /Exceeded maximum bindings limit of 256/);
	}
});

test("15. selector syntax validation rejects empty or invalid selectors in resolveInstructionMode", () => {
	const catalog = createResourceCatalog<LoadedInstructionMode>([]);
	assert.equal(resolveInstructionMode(catalog, "").ok, false);
	assert.equal(resolveInstructionMode(catalog, "   ").ok, false);
	assert.equal(resolveInstructionMode(catalog, "invalid:scope:too:many").ok, false);
	assert.equal(resolveInstructionMode(catalog, "unknownscope:mode").ok, false);
	assert.equal(resolveInstructionMode(catalog, "project:").ok, false);
});

test("16. catalog exact ambiguity returns explicit error", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "dup-exact"),
		createLoadedMode("global", "dup-exact"),
	]);

	const res = resolveInstructionMode(catalog, "global:dup-exact");
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.match(res.error, /Ambiguous instruction mode "global:dup-exact"/);
	}
});

test("17. resolveInstructionMode rejects non-string selector fail-closed without throwing", () => {
	const catalog = createResourceCatalog<LoadedInstructionMode>([]);
	assert.equal(resolveInstructionMode(catalog, null as any).ok, false);
	assert.equal(resolveInstructionMode(catalog, undefined as any).ok, false);
	assert.equal(resolveInstructionMode(catalog, 123 as any).ok, false);
	assert.equal(resolveInstructionMode(catalog, {} as any).ok, false);
});

test("18. resolveInstructionMode returns deeply frozen clone without freezing catalog entry", () => {
	const loadedMode = createLoadedMode("global", "test-freeze");
	const catalog = createResourceCatalog([loadedMode]);
	const res = resolveInstructionMode(catalog, "global:test-freeze");
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.ok(Object.isFrozen(res.loaded));
		assert.ok(Object.isFrozen(res.loaded.mode));
		assert.ok(Object.isFrozen(res.loaded.mode.tools));
		assert.ok(Object.isFrozen(res.loaded.mode.tools.add));
		assert.ok(Object.isFrozen(res.loaded.diagnostics));

		// Catalog input must NOT be frozen
		assert.equal(Object.isFrozen(loadedMode), false);
		assert.equal(Object.isFrozen(loadedMode.mode), false);
		assert.equal(Object.isFrozen(loadedMode.mode.tools), false);
		assert.equal(Object.isFrozen(loadedMode.diagnostics), false);
	}
});

test("19. resolveInstructionModeBindings rejects non-plain or extra fields on preset key, but allows valid long ID", () => {
	const catalog = createResourceCatalog<LoadedInstructionMode>([]);

	// Non-plain object preset
	class CustomKey {
		scope = "project" as const;
		id = "custom";
	}
	const resCustom = resolveInstructionModeBindings(catalog, new CustomKey() as any, []);
	assert.equal(resCustom.ok, false);

	// Extra fields on preset
	const resExtra = resolveInstructionModeBindings(
		catalog,
		{ scope: "project", id: "p1", extra: "forbidden" } as any,
		[],
	);
	assert.equal(resExtra.ok, false);

	// Valid 200-char preset id succeeds
	const longPresetKey: ResourceKey = { scope: "project", id: "p".repeat(200) };
	const resLong = resolveInstructionModeBindings(catalog, longPresetKey, []);
	assert.equal(resLong.ok, true);
});
