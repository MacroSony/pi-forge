import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

test("inspector-layout.css exists and defines V4 reading rules and arrow handle", () => {
	const cssPath = resolve(import.meta.dirname, "../src/web-editor/client/inspector-layout.css");
	const css = readFileSync(cssPath, "utf8");

	// Dock overrides
	assert.match(css, /\.editor-dock-area\.dock-open/);
	assert.match(css, /\[data-reading="side"\]|\.dock-side/);
	assert.match(css, /\[data-reading="wide"\]|\.dock-wide/);
	assert.match(css, /\[data-reading="focus"\]|\.dock-focus/);

	// Dimensions: side ~330-360px
	assert.match(css, /330px|350px/);

	// Wide ~ half workspace
	assert.match(css, /50%/);

	// Focus mode hides workspace
	assert.match(css, /\.workspace\s*\{\s*display:\s*none;/);

	// Arrow handle: 30px target, left boundary centered (-15px)
	assert.match(css, /left:\s*-15px/);
	assert.match(css, /width:\s*30px/);
	assert.match(css, /height:\s*30px/);

	// Responsive fallback avoiding viewport clipping
	assert.match(css, /max-width:\s*1150px/);
});


