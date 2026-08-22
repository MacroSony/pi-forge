/** Presentation-only line diff used by the web editor's git-style diff view. */

export type LineDiffKind = "same" | "added" | "removed" | "note";

export interface LineDiffPart {
	text: string;
	changed: boolean;
}

export interface LineDiffRow {
	kind: LineDiffKind;
	text: string;
	beforeLine?: number;
	afterLine?: number;
	parts: LineDiffPart[];
	noteSide?: "before" | "after";
}

export interface LineDiffSeparator {
	kind: "separator";
}

export type LineDiffDisplayRow = LineDiffRow | LineDiffSeparator;

export interface SplitLineDiffRow {
	kind: "line" | "separator";
	before?: LineDiffRow;
	after?: LineDiffRow;
}

const MAX_LCS_CELLS = 500_000;
const MAX_INLINE_DIFF_CHARS = 50_000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function diffTextLines(beforeText: string, afterText: string): LineDiffRow[] {
	const before = splitLines(beforeText);
	const after = splitLines(afterText);
	const operations = lineOperations(before, after);
	let beforeLine = 1;
	let afterLine = 1;
	const rows: LineDiffRow[] = operations.map((operation) => {
		const row: LineDiffRow = {
			kind: operation.kind,
			text: operation.text,
			parts: [{ text: operation.text, changed: operation.kind !== "same" }],
		};
		if (operation.kind !== "added") row.beforeLine = beforeLine++;
		if (operation.kind !== "removed") row.afterLine = afterLine++;
		return row;
	});
	const annotated = annotateInlineChanges(rows);
	const beforeLacksFinalNewline = beforeText.length > 0 && !beforeText.endsWith("\n");
	const afterLacksFinalNewline = afterText.length > 0 && !afterText.endsWith("\n");
	if (beforeLacksFinalNewline !== afterLacksFinalNewline) {
		annotated.push({
			kind: "note",
			text: "No newline at end of file",
			parts: [{ text: "No newline at end of file", changed: false }],
			noteSide: beforeLacksFinalNewline ? "before" : "after",
		});
	}
	return annotated;
}

/** `contextLines = 0` means changed lines only; `null` means the complete file. */
export function filterLineRows(rows: readonly LineDiffRow[], contextLines: number | null): LineDiffDisplayRow[] {
	if (contextLines === null) return [...rows];
	const context = Math.max(0, Math.floor(contextLines));
	const keep = rows.map(() => false);
	for (let index = 0; index < rows.length; index++) {
		if (rows[index]!.kind === "same") continue;
		for (let nearby = Math.max(0, index - context); nearby <= Math.min(rows.length - 1, index + context); nearby++) {
			keep[nearby] = true;
		}
	}

	const result: LineDiffDisplayRow[] = [];
	let previousKept = -1;
	for (let index = 0; index < rows.length; index++) {
		if (!keep[index]) continue;
		if (previousKept >= 0 && index > previousKept + 1) result.push({ kind: "separator" });
		result.push(rows[index]!);
		previousKept = index;
	}
	return result;
}

export function buildSplitLineRows(rows: readonly LineDiffDisplayRow[]): SplitLineDiffRow[] {
	const result: SplitLineDiffRow[] = [];
	for (let index = 0; index < rows.length;) {
		const row = rows[index]!;
		if (row.kind === "separator") {
			result.push({ kind: "separator" });
			index++;
			continue;
		}
		if (row.kind === "same") {
			result.push({ kind: "line", before: row, after: row });
			index++;
			continue;
		}

		const removed: LineDiffRow[] = [];
		const added: LineDiffRow[] = [];
		while (index < rows.length && rows[index]!.kind !== "same" && rows[index]!.kind !== "separator") {
			const changed = rows[index] as LineDiffRow;
			if (changed.kind === "removed" || (changed.kind === "note" && changed.noteSide === "before")) removed.push(changed);
			else added.push(changed);
			index++;
		}
		for (let pair = 0; pair < Math.max(removed.length, added.length); pair++) {
			result.push({ kind: "line", before: removed[pair], after: added[pair] });
		}
	}
	return result;
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

function lineOperations(before: readonly string[], after: readonly string[]): Array<{ kind: LineDiffKind; text: string }> {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix
		&& suffix < after.length - prefix
		&& before[before.length - suffix - 1] === after[after.length - suffix - 1]
	) suffix++;

	const beforeMiddle = before.slice(prefix, before.length - suffix);
	const afterMiddle = after.slice(prefix, after.length - suffix);
	const result: Array<{ kind: LineDiffKind; text: string }> = before
		.slice(0, prefix)
		.map((text) => ({ kind: "same", text }));
	result.push(...diffMiddle(beforeMiddle, afterMiddle));
	result.push(...before.slice(before.length - suffix).map((text) => ({ kind: "same" as const, text })));
	return result;
}

function diffMiddle(before: readonly string[], after: readonly string[]): Array<{ kind: LineDiffKind; text: string }> {
	if (before.length === 0) return after.map((text) => ({ kind: "added", text }));
	if (after.length === 0) return before.map((text) => ({ kind: "removed", text }));
	if ((before.length + 1) * (after.length + 1) > MAX_LCS_CELLS) {
		return [
			...before.map((text) => ({ kind: "removed" as const, text })),
			...after.map((text) => ({ kind: "added" as const, text })),
		];
	}

	const width = after.length + 1;
	const matrix = new Uint32Array((before.length + 1) * width);
	for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex--) {
		for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex--) {
			const offset = beforeIndex * width + afterIndex;
			matrix[offset] = before[beforeIndex] === after[afterIndex]
				? matrix[(beforeIndex + 1) * width + afterIndex + 1]! + 1
				: Math.max(matrix[(beforeIndex + 1) * width + afterIndex]!, matrix[offset + 1]!);
		}
	}

	const result: Array<{ kind: LineDiffKind; text: string }> = [];
	let beforeIndex = 0;
	let afterIndex = 0;
	while (beforeIndex < before.length && afterIndex < after.length) {
		if (before[beforeIndex] === after[afterIndex]) {
			result.push({ kind: "same", text: before[beforeIndex]! });
			beforeIndex++;
			afterIndex++;
		} else if (matrix[(beforeIndex + 1) * width + afterIndex]! >= matrix[beforeIndex * width + afterIndex + 1]!) {
			result.push({ kind: "removed", text: before[beforeIndex++]! });
		} else {
			result.push({ kind: "added", text: after[afterIndex++]! });
		}
	}
	while (beforeIndex < before.length) result.push({ kind: "removed", text: before[beforeIndex++]! });
	while (afterIndex < after.length) result.push({ kind: "added", text: after[afterIndex++]! });
	return result;
}

function annotateInlineChanges(rows: readonly LineDiffRow[]): LineDiffRow[] {
	const result = rows.map((row) => ({ ...row, parts: [...row.parts] }));
	for (let index = 0; index < result.length;) {
		if (result[index]!.kind === "same") {
			index++;
			continue;
		}
		const start = index;
		while (index < result.length && result[index]!.kind !== "same") index++;
		const removed = result.slice(start, index).filter((row) => row.kind === "removed");
		const added = result.slice(start, index).filter((row) => row.kind === "added");
		for (let pair = 0; pair < Math.min(removed.length, added.length); pair++) {
			const [beforeParts, afterParts] = inlineParts(removed[pair]!.text, added[pair]!.text);
			removed[pair]!.parts = beforeParts;
			added[pair]!.parts = afterParts;
		}
	}
	return result;
}


function inlineParts(before: string, after: string): [LineDiffPart[], LineDiffPart[]] {
	if (before.length + after.length > MAX_INLINE_DIFF_CHARS) {
		return [
			[{ text: before, changed: true }],
			[{ text: after, changed: true }],
		];
	}
	const beforeGraphemes = splitGraphemes(before);
	const afterGraphemes = splitGraphemes(after);
	let prefix = 0;
	while (
		prefix < beforeGraphemes.length
		&& prefix < afterGraphemes.length
		&& beforeGraphemes[prefix] === afterGraphemes[prefix]
	) prefix++;
	let suffix = 0;
	while (
		suffix < beforeGraphemes.length - prefix
		&& suffix < afterGraphemes.length - prefix
		&& beforeGraphemes[beforeGraphemes.length - suffix - 1] === afterGraphemes[afterGraphemes.length - suffix - 1]
	) suffix++;
	return [
		partsForLine(beforeGraphemes, prefix, suffix),
		partsForLine(afterGraphemes, prefix, suffix),
	];
}

function partsForLine(graphemes: readonly string[], prefix: number, suffix: number): LineDiffPart[] {
	const parts: LineDiffPart[] = [];
	if (prefix > 0) parts.push({ text: graphemes.slice(0, prefix).join(""), changed: false });
	parts.push({ text: graphemes.slice(prefix, graphemes.length - suffix).join(""), changed: true });
	if (suffix > 0) parts.push({ text: graphemes.slice(graphemes.length - suffix).join(""), changed: false });
	return parts;
}

function splitGraphemes(text: string): string[] {
	return Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment);
}
