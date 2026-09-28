import assert from "node:assert/strict";
import test from "node:test";
import { declaredParameterCount, declarationExcerpt, declarationJson } from "../src/web-editor/client/preview-tool-declarations.ts";

test("historical declarations count only explicit top-level object properties", () => {
	assert.equal(declaredParameterCount({ type: "object", properties: { path: { type: "string" }, options: { type: "object", properties: { limit: {} } } } }), 2);
	assert.equal(declaredParameterCount({ properties: {} }), 0);
	assert.equal(declaredParameterCount({ properties: { path: {} }, additionalProperties: true, allOf: [{ $ref: "#/$defs/other" }] }), 1, "count is declared properties, not total effective arity");
	for (const schema of [undefined, null, true, false, "schema", [], {}, { $ref: "#/$defs/input" }, { properties: [] }, { properties: null }, { type: "array", properties: { ignored: {} } }, Object.create({ properties: { inherited: {} } })]) {
		assert.equal(declaredParameterCount(schema), null, "unknown count is not invented as zero");
	}
});

test("historical declaration excerpts are bounded while the JSON remains complete and unchanged", () => {
	const tool = Object.freeze({ name: "read", description: "Read a file.\n\n" + "Detailed documentation. ".repeat(200), parameters: Object.freeze({ type: "object", properties: { path: { type: "string" }, note: { enum: ["<img src=x onerror=alert(1)>"] } }, required: ["path"], additionalProperties: false }) });
	const before = JSON.stringify(tool);
	const summary = declarationExcerpt(tool.description);
	assert.ok(summary.length <= 181);
	assert.ok(summary.endsWith("…"));
	assert.doesNotMatch(summary, /\n/);
	const detail = declarationJson(tool);
	assert.deepEqual(JSON.parse(detail), tool);
	assert.ok(detail.includes("<img src=x onerror=alert(1)>"), "JSON is text; escaping is the Vue renderer's responsibility");
	assert.equal(JSON.stringify(tool), before);
});

test("declaration JSON preserves missing, null, empty and opaque schema values without inventing a definition", () => {
	for (const tool of [{ name: "minimal" }, { name: "null", parameters: null }, { name: "empty", parameters: {} }, { name: "opaque", parameters: { $ref: "#/$defs/input" } }]) {
		assert.deepEqual(JSON.parse(declarationJson(tool)), tool);
	}
	assert.equal(declarationExcerpt(undefined), "");
	assert.equal(declarationExcerpt(" Short\n description. "), "Short description.");
});
