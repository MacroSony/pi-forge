import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createResourceCatalog } from "../src/catalog.ts";
import { applyCapabilityOverrides, parseCapability, type CapabilityOverrides } from "../src/codecs/capability.ts";
import { createCapabilitySnapshot, reduceCapabilityEvents } from "../src/capability-events.ts";
import { resolveCapabilityBindings } from "../src/capabilities.ts";
import { canonicalJson, fingerprintJson } from "../src/json-fingerprint.ts";
import { canonicalSubagentJson, subagentFingerprint } from "../src/subagent/fingerprints.ts";
import type { ResourceKey } from "../src/resource-identity.ts";

const definition = (content: string) => ({
	schemaVersion: 1,
	type: "pi-forge.capability",
	id: "review",
	content,
	tools: { add: ["grep"], remove: ["write"] },
});

test("foundation composes codec, owner-scope resolution and branch snapshots without live transport", () => {
	const global = parseCapability(JSON.stringify(definition("GLOBAL_REVIEW")), "/global/review.json", "global");
	const project = parseCapability(JSON.stringify(definition("PROJECT_SHADOW")), "/project/review.json", "project");
	const catalog = createResourceCatalog([global, project]);
	const resolved = resolveCapabilityBindings(catalog, { scope: "global", id: "coding" }, [{
		ref: "review", modelCallable: true, overrides: { appendContent: "CHECK_COMPATIBILITY", tools: { add: ["find"] } },
	}]);
	assert.ok(resolved.ok);
	const binding = resolved.bindings[0]!;
	assert.equal(binding.capability.content, "GLOBAL_REVIEW\n\nCHECK_COMPATIBILITY");
	assert.equal(binding.modelCallable, true); // Eligibility data, not live admission/execution.
	const snapshot = createCapabilitySnapshot({
		activationId: "activation-a",
		source: { kind: "capability", key: binding.ref, binding: { preset: binding.preset, id: binding.id } },
		content: binding.capability.content,
		tools: binding.capability.tools,
	});
	global.capability.content = "LATER_SOURCE_EDIT";
	global.capability.tools.remove.length = 0;
	const activate = { schemaVersion: 1, eventId: "event-a", op: "activate", actor: "agent", createdAt: 2, snapshot };
	const off = { schemaVersion: 1, eventId: "event-b", op: "deactivate", actor: "user", createdAt: 1, activationId: snapshot.activationId };
	const onBranch = reduceCapabilityEvents(JSON.parse(JSON.stringify([activate])));
	const offBranch = reduceCapabilityEvents(JSON.parse(JSON.stringify([activate, off])));
	assert.ok(onBranch.ok && offBranch.ok);
	assert.equal(onBranch.active[0]!.snapshot.content, "GLOBAL_REVIEW\n\nCHECK_COMPATIBILITY");
	assert.deepEqual(onBranch.active[0]!.snapshot.tools, { add: ["find"], remove: ["write"] });
	assert.equal(offBranch.active.length, 0); // Branch order wins over the timestamp order.
	assert.equal(onBranch.active.length, 1); // Reducing another branch cannot mutate this view.
});

test("shared fingerprints preserve canonical bytes and legacy subagent names", () => {
	const value = { z: undefined, b: [-0, "text", null], a: { y: true, x: 1 } };
	const expected = '{"a":{"x":1,"y":true},"b":[0,"text",null]}';
	assert.equal(canonicalJson(value), expected);
	assert.equal(canonicalSubagentJson(value), expected);
	const hash = `sha256:v1:${createHash("sha256").update(expected).digest("hex")}`;
	assert.equal(fingerprintJson(value), hash);
	assert.equal(subagentFingerprint(value), hash);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	for (const invalid of [NaN, Infinity, new Date(), new Array(2), cyclic, { f: () => 1 }]) {
		assert.throws(() => canonicalJson(invalid), TypeError);
		assert.throws(() => canonicalSubagentJson(invalid), TypeError);
	}
});

test("explicit malformed override values are not silently treated as omitted", () => {
	const loaded = parseCapability(JSON.stringify(definition("base")), "review.json", "project");
	for (const invalid of [null, false, 0, ""]) {
		const result = applyCapabilityOverrides(loaded.capability, invalid as unknown as CapabilityOverrides);
		assert.equal(result.ok, false, `override ${JSON.stringify(invalid)} must fail`);
	}
	assert.equal(applyCapabilityOverrides(loaded.capability, undefined).ok, true);
});

test("malformed scope/id error formatting cannot throw on plain JSON objects", () => {
	const catalog = createResourceCatalog<ReturnType<typeof parseCapability>>([]);
	for (const key of [
		{ scope: { toString: null }, id: "p" },
		{ scope: "project", id: { toString: null } },
		{ scope: Object.create(null), id: "p" },
	]) {
		assert.doesNotThrow(() => {
			assert.equal(resolveCapabilityBindings(catalog, key as unknown as ResourceKey, []).ok, false);
		});
	}
});
