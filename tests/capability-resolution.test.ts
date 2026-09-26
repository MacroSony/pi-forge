import assert from "node:assert/strict";
import test from "node:test";
import { createResourceCatalog } from "../src/catalog.ts";
import {
	CAPABILITY_TYPE,
	type Diagnostic,
	type CapabilityBinding,
	type LoadedCapability,
} from "../src/codecs/capability.ts";
import {
	MAX_CAPABILITY_BINDINGS,
	resolveCapability,
	resolveCapabilityBindings,
} from "../src/capabilities.ts";
import type { ResourceKey, ResourceScope } from "../src/resource-identity.ts";

function createLoadedMode(
	scope: ResourceScope,
	id: string,
	options: {
		content?: string;
		tools?: { add: string[]; remove: string[] };
		diagnostics?: Diagnostic[];
	} = {},
): LoadedCapability {
	return {
		key: { scope, id },
		scope,
		filePath: `/${scope}/modes/${id}.json`,
		capability: {
			schemaVersion: 1,
			type: CAPABILITY_TYPE,
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

	const resShared = resolveCapability(catalog, "shared");
	assert.equal(resShared.ok, true);
	if (resShared.ok) {
		assert.equal(resShared.loaded.scope, "project");
		assert.equal(resShared.loaded.capability.content, "project shared");
	}

	const resGlobal = resolveCapability(catalog, "only-global");
	assert.equal(resGlobal.ok, true);
	if (resGlobal.ok) {
		assert.equal(resGlobal.loaded.scope, "global");
		assert.equal(resGlobal.loaded.capability.content, "global only");
	}
});

test("2. exact scope selector targets specific scope and global cannot be hijacked by project", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "audit", { content: "global audit" }),
		createLoadedMode("project", "audit", { content: "project audit" }),
	]);

	const exactGlobal = resolveCapability(catalog, "global:audit");
	assert.equal(exactGlobal.ok, true);
	if (exactGlobal.ok) {
		assert.equal(exactGlobal.loaded.scope, "global");
		assert.equal(exactGlobal.loaded.capability.content, "global audit");
	}

	const exactProject = resolveCapability(catalog, "project:audit");
	assert.equal(exactProject.ok, true);
	if (exactProject.ok) {
		assert.equal(exactProject.loaded.scope, "project");
		assert.equal(exactProject.loaded.capability.content, "project audit");
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

	const bare = resolveCapability(catalog, "architect");
	assert.equal(bare.ok, false);
	if (!bare.ok) {
		assert.match(bare.error, /project:architect.*errors.*Invalid syntax/);
	}

	const preset: ResourceKey = { scope: "project", id: "main-preset" };
	const bindings: CapabilityBinding[] = [{ ref: "architect" }];
	const resBindings = resolveCapabilityBindings(catalog, preset, bindings);
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

	const resMode = resolveCapability(catalog, "dup");
	assert.equal(resMode.ok, false);
	if (!resMode.ok) {
		assert.match(resMode.error, /Ambiguous capability "project:dup"/);
	}

	const preset: ResourceKey = { scope: "project", id: "main-preset" };
	const resBindings = resolveCapabilityBindings(catalog, preset, [{ ref: "dup" }]);
	assert.equal(resBindings.ok, false);
	if (!resBindings.ok) {
		assert.match(resBindings.error, /Ambiguous capability "project:dup"/);
		assert.equal(resBindings.index, 0);
	}
});

test("5. missing resource prompt includes qualified scope:id", () => {
	const catalog = createResourceCatalog<LoadedCapability>([]);

	const directRes = resolveCapability(catalog, "project:nonexistent");
	assert.equal(directRes.ok, false);
	if (!directRes.ok) {
		assert.equal(directRes.error, 'Capability capability "project:nonexistent" not found.');
	}

	const projPreset: ResourceKey = { scope: "project", id: "p-preset" };
	const bindingRes = resolveCapabilityBindings(catalog, projPreset, [{ ref: "missing-one" }]);
	assert.equal(bindingRes.ok, false);
	if (!bindingRes.ok) {
		assert.equal(bindingRes.error, 'Capability capability "project:missing-one" not found.');
		assert.equal(bindingRes.index, 0);
	}

	const globalPreset: ResourceKey = { scope: "global", id: "g-preset" };
	const globalBindingRes = resolveCapabilityBindings(catalog, globalPreset, [{ ref: "missing-two" }]);
	assert.equal(globalBindingRes.ok, false);
	if (!globalBindingRes.ok) {
		assert.equal(globalBindingRes.error, 'Capability capability "global:missing-two" not found.');
		assert.equal(globalBindingRes.index, 0);
	}
});

test("6. project preset bare ref strictly uses preset scope and does not fall back to global", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "helper", { content: "global helper" }),
	]);

	const projPreset: ResourceKey = { scope: "project", id: "my-preset" };
	const res = resolveCapabilityBindings(catalog, projPreset, [{ ref: "helper" }]);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.equal(res.error, 'Capability capability "project:helper" not found.');
		assert.equal(res.index, 0);
	}
});

test("7. explicit global ref works in project preset", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "shared-util", { content: "global utility capability" }),
	]);

	const projPreset: ResourceKey = { scope: "project", id: "my-preset" };
	const res = resolveCapabilityBindings(catalog, projPreset, [{ ref: "global:shared-util" }]);
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(res.bindings.length, 1);
		assert.equal(res.bindings[0].id, "shared-util");
		assert.deepEqual(res.bindings[0].ref, { scope: "global", id: "shared-util" });
		assert.deepEqual(res.bindings[0].preset, { scope: "project", id: "my-preset" });
		assert.equal(res.bindings[0].capability.content, "global utility capability");
	}
});

test("8. global preset cannot bind project instruction capability", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("project", "local-capability", { content: "project capability" }),
	]);

	const globalPreset: ResourceKey = { scope: "global", id: "root" };
	const res = resolveCapabilityBindings(catalog, globalPreset, [{ ref: "project:local-capability" }]);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.match(res.error, /Global binding cannot reference project capability/);
		assert.equal(res.index, 0);
	}
});

test("9. duplicate default id rejected and explicit id avoids collision", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("project", "tool-capability", { content: "project tool capability" }),
		createLoadedMode("global", "tool-capability", { content: "global tool capability" }),
	]);

	const projPreset: ResourceKey = { scope: "project", id: "p1" };

	// Both default to effective id "tool-capability"
	const colliding = resolveCapabilityBindings(catalog, projPreset, [
		{ ref: "tool-capability" },
		{ ref: "global:tool-capability" },
	]);
	assert.equal(colliding.ok, false);
	if (!colliding.ok) {
		assert.equal(colliding.error, 'Duplicate binding id "tool-capability" at index 1.');
		assert.equal(colliding.index, 1);
	}

	// Explicit id on one of them evades collision
	const nonColliding = resolveCapabilityBindings(catalog, projPreset, [
		{ ref: "tool-capability" },
		{ ref: "global:tool-capability", id: "global-tool-capability" },
	]);
	assert.equal(nonColliding.ok, true);
	if (nonColliding.ok) {
		assert.equal(nonColliding.bindings.length, 2);
		assert.equal(nonColliding.bindings[0].id, "tool-capability");
		assert.equal(nonColliding.bindings[1].id, "global-tool-capability");
	}
});

test("10. modelCallable is strictly true only when explicit true; defaults to false", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("project", "m1", { content: "capability 1" }),
		createLoadedMode("project", "m2", { content: "capability 2" }),
		createLoadedMode("project", "m3", { content: "capability 3" }),
	]);

	const preset: ResourceKey = { scope: "project", id: "p1" };
	const res = resolveCapabilityBindings(catalog, preset, [
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

test("11. overrides do not mutate source loaded capability in catalog", () => {
	const originalMode = createLoadedMode("project", "custom", {
		content: "Original Content",
		tools: { add: ["base_tool"], remove: [] },
	});
	const catalog = createResourceCatalog([originalMode]);

	const preset: ResourceKey = { scope: "project", id: "p1" };
	const res = resolveCapabilityBindings(catalog, preset, [
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
		assert.equal(res.bindings[0].capability.content, "Modified Content");
		assert.deepEqual(res.bindings[0].capability.tools.add, ["extra_tool"]);
		assert.deepEqual(res.bindings[0].capability.tools.remove, ["base_tool"]);
	}

	// Verify catalog source was NOT mutated
	assert.equal(originalMode.capability.content, "Original Content");
	assert.deepEqual(originalMode.capability.tools.add, ["base_tool"]);
	assert.deepEqual(originalMode.capability.tools.remove, []);
});

test("12. non-array / null / invalid binding fields fail without throwing", () => {
	const catalog = createResourceCatalog<LoadedCapability>([]);
	const preset: ResourceKey = { scope: "project", id: "p1" };

	assert.equal(resolveCapabilityBindings(catalog, preset, null as unknown as CapabilityBinding[]).ok, false);
	assert.equal(resolveCapabilityBindings(catalog, preset, undefined as unknown as CapabilityBinding[]).ok, false);
	assert.equal(resolveCapabilityBindings(catalog, preset, {} as unknown as CapabilityBinding[]).ok, false);

	// Invalid preset
	assert.equal(resolveCapabilityBindings(catalog, null as unknown as ResourceKey, []).ok, false);
	assert.equal(resolveCapabilityBindings(catalog, { scope: "bad" as unknown as ResourceScope, id: "p" }, []).ok, false);
	assert.equal(resolveCapabilityBindings(catalog, { scope: "project", id: "bad:id" }, []).ok, false);

	// Invalid binding fields
	const badFieldRes = resolveCapabilityBindings(catalog, preset, [
		{ ref: "valid", extraUnauthorized: 123 } as unknown as CapabilityBinding,
	]);
	assert.equal(badFieldRes.ok, false);
	if (!badFieldRes.ok) {
		assert.match(badFieldRes.error, /Unsupported binding field: extraUnauthorized/);
		assert.equal(badFieldRes.index, 0);
	}

	// Invalid modelCallable non-boolean
	const badModelCallable = resolveCapabilityBindings(catalog, preset, [
		{ ref: "valid", modelCallable: "yes" } as unknown as CapabilityBinding,
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

	const res = resolveCapabilityBindings(catalog, preset, [{ ref: "freezable" }]);
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(Object.isFrozen(res.bindings), true);
		assert.equal(Object.isFrozen(res.bindings[0]), true);
		assert.equal(Object.isFrozen(res.bindings[0].ref), true);
		assert.equal(Object.isFrozen(res.bindings[0].preset), true);
		assert.equal(Object.isFrozen(res.bindings[0].capability), true);
		assert.equal(Object.isFrozen(res.bindings[0].capability.tools), true);
		assert.equal(Object.isFrozen(res.bindings[0].capability.tools.add), true);
		assert.equal(Object.isFrozen(res.bindings[0].capability.tools.remove), true);

		assert.throws(() => {
			(res.bindings[0].capability as { content: string }).content = "mutation";
		}, TypeError);
	}

	// Catalog input must NOT be frozen
	assert.equal(Object.isFrozen(loaded), false);
	assert.equal(Object.isFrozen(loaded.capability), false);
	assert.equal(Object.isFrozen(loaded.capability.tools), false);
	assert.equal(Object.isFrozen(loaded.capability.tools.add), false);
	assert.equal(Object.isFrozen(catalog.all), false);
});

test("14. maximum 256 bindings limit is enforced", () => {
	const catalog = createResourceCatalog<LoadedCapability>([]);
	const preset: ResourceKey = { scope: "project", id: "p1" };

	const bindings: CapabilityBinding[] = Array.from(
		{ length: MAX_CAPABILITY_BINDINGS + 1 },
		(_, i) => ({ ref: `capability-${i}` }),
	);

	const res = resolveCapabilityBindings(catalog, preset, bindings);
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.match(res.error, /Exceeded maximum bindings limit of 256/);
	}
});

test("15. selector syntax validation rejects empty or invalid selectors in resolveCapability", () => {
	const catalog = createResourceCatalog<LoadedCapability>([]);
	assert.equal(resolveCapability(catalog, "").ok, false);
	assert.equal(resolveCapability(catalog, "   ").ok, false);
	assert.equal(resolveCapability(catalog, "invalid:scope:too:many").ok, false);
	assert.equal(resolveCapability(catalog, "unknownscope:capability").ok, false);
	assert.equal(resolveCapability(catalog, "project:").ok, false);
});

test("16. catalog exact ambiguity returns explicit error", () => {
	const catalog = createResourceCatalog([
		createLoadedMode("global", "dup-exact"),
		createLoadedMode("global", "dup-exact"),
	]);

	const res = resolveCapability(catalog, "global:dup-exact");
	assert.equal(res.ok, false);
	if (!res.ok) {
		assert.match(res.error, /Ambiguous capability "global:dup-exact"/);
	}
});

test("17. resolveCapability rejects non-string selector fail-closed without throwing", () => {
	const catalog = createResourceCatalog<LoadedCapability>([]);
	assert.equal(resolveCapability(catalog, null as any).ok, false);
	assert.equal(resolveCapability(catalog, undefined as any).ok, false);
	assert.equal(resolveCapability(catalog, 123 as any).ok, false);
	assert.equal(resolveCapability(catalog, {} as any).ok, false);
});

test("18. resolveCapability returns deeply frozen clone without freezing catalog entry", () => {
	const loadedMode = createLoadedMode("global", "test-freeze");
	const catalog = createResourceCatalog([loadedMode]);
	const res = resolveCapability(catalog, "global:test-freeze");
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.ok(Object.isFrozen(res.loaded));
		assert.ok(Object.isFrozen(res.loaded.capability));
		assert.ok(Object.isFrozen(res.loaded.capability.tools));
		assert.ok(Object.isFrozen(res.loaded.capability.tools.add));
		assert.ok(Object.isFrozen(res.loaded.diagnostics));

		// Catalog input must NOT be frozen
		assert.equal(Object.isFrozen(loadedMode), false);
		assert.equal(Object.isFrozen(loadedMode.capability), false);
		assert.equal(Object.isFrozen(loadedMode.capability.tools), false);
		assert.equal(Object.isFrozen(loadedMode.diagnostics), false);
	}
});

test("19. resolveCapabilityBindings rejects non-plain or extra fields on preset key, but allows valid long ID", () => {
	const catalog = createResourceCatalog<LoadedCapability>([]);

	// Non-plain object preset
	class CustomKey {
		scope = "project" as const;
		id = "custom";
	}
	const resCustom = resolveCapabilityBindings(catalog, new CustomKey() as any, []);
	assert.equal(resCustom.ok, false);

	// Extra fields on preset
	const resExtra = resolveCapabilityBindings(
		catalog,
		{ scope: "project", id: "p1", extra: "forbidden" } as any,
		[],
	);
	assert.equal(resExtra.ok, false);

	// Valid 200-char preset id succeeds
	const longPresetKey: ResourceKey = { scope: "project", id: "p".repeat(200) };
	const resLong = resolveCapabilityBindings(catalog, longPresetKey, []);
	assert.equal(resLong.ok, true);
});
