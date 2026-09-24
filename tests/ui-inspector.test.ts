import assert from "node:assert/strict";
import test from "node:test";

import { inspectorEn, inspectorZhCN } from "../src/web-editor/client/i18n-inspector.ts";


test("inspector i18n has matching bilingual keys and correct placeholders", () => {
	const enKeys = Object.keys(inspectorEn).sort();
	const zhKeys = Object.keys(inspectorZhCN).sort();
	assert.deepEqual(enKeys, zhKeys, "Both languages must have identical keys");

	const requiredKeys = [
		"polish.inspector.cycle",
		"polish.inspector.widen",
		"polish.inspector.focus",
		"polish.inspector.restore",
		"polish.inspector.sideAria",
		"polish.inspector.wideAria",
		"polish.inspector.focusAria",
		"polish.inspector.draftScope",
		"polish.inspector.draftDiffScope",
		"polish.inspector.runDiffScope",
		"polish.inspector.returnEditing",
		"polish.inspector.draftIdentity",
		"polish.inspector.runIdentity",
	];

	for (const key of requiredKeys) {
		assert.ok(key in inspectorEn, `inspectorEn missing ${key}`);
		assert.ok(key in inspectorZhCN, `inspectorZhCN missing ${key}`);
		assert.ok((inspectorEn as any)[key].length > 0);
		assert.ok((inspectorZhCN as any)[key].length > 0);
	}

	assert.match((inspectorEn as any)["polish.inspector.draftIdentity"], /\{name\}/);
	assert.match((inspectorZhCN as any)["polish.inspector.draftIdentity"], /\{name\}/);
	assert.match((inspectorEn as any)["polish.inspector.runIdentity"], /\{turn\}/);
	assert.match((inspectorZhCN as any)["polish.inspector.runIdentity"], /\{turn\}/);
});

