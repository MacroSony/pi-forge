import assert from "node:assert/strict";
import test from "node:test";

import {
	buildSplitLineRows,
	diffTextLines,
	filterLineRows,
} from "../src/web-editor/line-diff.ts";

test("line diff assigns git-style old/new line numbers and inline changed spans", () => {
	const rows = diffTextLines(
		"alpha\nshared prefix OLD suffix\nomega",
		"alpha\nshared prefix NEW suffix\nomega",
	);

	assert.deepEqual(rows.map((row) => [row.kind, row.beforeLine, row.afterLine]), [
		["same", 1, 1],
		["removed", 2, undefined],
		["added", undefined, 2],
		["same", 3, 3],
	]);
	assert.deepEqual(rows[1]!.parts, [
		{ text: "shared prefix ", changed: false },
		{ text: "OLD", changed: true },
		{ text: " suffix", changed: false },
	]);
	assert.deepEqual(rows[2]!.parts, [
		{ text: "shared prefix ", changed: false },
		{ text: "NEW", changed: true },
		{ text: " suffix", changed: false },
	]);
});

test("changes-only and contextual filters preserve hunk separators", () => {
	const before = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
	const after = [...before];
	after[1] = "line two changed";
	after[10] = "line eleven changed";
	const rows = diffTextLines(before.join("\n"), after.join("\n"));

	const changedOnly = filterLineRows(rows, 0);
	assert.deepEqual(changedOnly.map((row) => row.kind), ["removed", "added", "separator", "removed", "added"]);
	assert.equal(changedOnly.some((row) => row.kind === "same"), false);

	const context = filterLineRows(rows, 1);
	assert.equal(context.filter((row) => row.kind === "separator").length, 1);
	assert.deepEqual(
		context.flatMap((row) => row.kind === "same" ? [row.afterLine] : []),
		[1, 3, 10, 12],
	);
	assert.equal(filterLineRows(rows, null).length, rows.length);
});

test("split line rows align replacement pairs without losing additions", () => {
	const unified = diffTextLines("one\ntwo\nthree", "one\nTWO\ninserted\nthree");
	const split = buildSplitLineRows(filterLineRows(unified, 0));

	assert.equal(split.length, 2);
	assert.equal(split[0]!.before?.text, "two");
	assert.equal(split[0]!.after?.text, "TWO");
	assert.equal(split[1]!.before, undefined);
	assert.equal(split[1]!.after?.text, "inserted");
});

test("identical and empty texts remain well-defined", () => {
	assert.deepEqual(diffTextLines("", ""), []);
	assert.deepEqual(diffTextLines("same", "same").map((row) => row.kind), ["same"]);
	assert.deepEqual(diffTextLines("", "added").map((row) => row.kind), ["added", "note"]);
});

test("inline spans stay on grapheme boundaries for emoji and combining marks", () => {
	for (const [before, after, changedBefore, changedAfter] of [
		["😀 suffix", "😁 suffix", "😀", "😁"],
		["👨‍👩‍👧 family", "👨‍👩‍👦 family", "👨‍👩‍👧", "👨‍👩‍👦"],
		["e\u0301 accent", "e\u0300 accent", "e\u0301", "e\u0300"],
	]) {
		const rows = diffTextLines(before, after);
		assert.equal(rows[0]!.parts.find((part) => part.changed)?.text, changedBefore);
		assert.equal(rows[1]!.parts.find((part) => part.changed)?.text, changedAfter);
		assert.equal(rows[0]!.parts.map((part) => part.text).join(""), before);
		assert.equal(rows[1]!.parts.map((part) => part.text).join(""), after);
		assert.doesNotMatch(JSON.stringify(rows), /�/);
	}
});

test("terminal newlines do not create ghost lines and EOF newline changes get a marker", () => {
	const same = diffTextLines("a\n", "a\n");
	assert.deepEqual(same.map((row) => [row.kind, row.beforeLine, row.afterLine]), [["same", 1, 1]]);

	const addedNewline = diffTextLines("a", "a\n");
	assert.deepEqual(addedNewline.map((row) => row.kind), ["same", "note"]);
	assert.equal(addedNewline[1]!.noteSide, "before");
	assert.equal(addedNewline[1]!.text, "No newline at end of file");

	const removedNewline = diffTextLines("a\n", "a");
	assert.equal(removedNewline.at(-1)!.noteSide, "after");
	assert.equal(filterLineRows(removedNewline, 0).at(-1)!.kind, "note");

	const emptyToTerminated = diffTextLines("", "a\n");
	assert.deepEqual(emptyToTerminated.map((row) => row.kind), ["added"]);
	const emptyToUnterminated = diffTextLines("", "a");
	assert.deepEqual(emptyToUnterminated.map((row) => row.kind), ["added", "note"]);
	assert.equal(emptyToUnterminated.at(-1)!.noteSide, "after");
	const terminatedToEmpty = diffTextLines("a\n", "");
	assert.deepEqual(terminatedToEmpty.map((row) => row.kind), ["removed"]);
	const unterminatedToEmpty = diffTextLines("a", "");
	assert.deepEqual(unterminatedToEmpty.map((row) => row.kind), ["removed", "note"]);
	assert.equal(unterminatedToEmpty.at(-1)!.noteSide, "before");
});

test("extreme single lines skip expensive inline segmentation", () => {
	const before = "a".repeat(30_000);
	const after = "a".repeat(29_999) + "b";
	const rows = diffTextLines(before, after);
	assert.deepEqual(rows[0]!.parts, [{ text: before, changed: true }]);
	assert.deepEqual(rows[1]!.parts, [{ text: after, changed: true }]);
});
