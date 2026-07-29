import assert from "node:assert/strict";
import test from "node:test";

import { inlineScript, inlineStyle } from "../src/web-editor/page.ts";

test("embedded web editor assets neutralize raw-text closing tags", () => {
	assert.equal(
		inlineScript('const value = "</ScRiPt><script>still inside";'),
		'const value = "<\\/script><script>still inside";',
	);
	assert.equal(
		inlineStyle('.probe::after { content: "</StYlE><style>still inside"; }'),
		'.probe::after { content: "<\\/style><style>still inside"; }',
	);
});
