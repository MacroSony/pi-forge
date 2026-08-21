import assert from "node:assert/strict";
import test from "node:test";

import { diffTurns } from "../src/context-diff.ts";
import { previewToTurnSnapshot } from "../src/web-editor/client/preview-diff.ts";
import type { WebEditorPreview } from "../src/web-editor/types.ts";

function preview(messages: WebEditorPreview["messages"]): WebEditorPreview {
	return {
		stackId: "draft",
		generatedAt: "",
		system: { id: "system", diffKey: "system", title: "System", content: "system", chars: 6, approxTokens: 2 },
		messages,
		totalChars: 0,
		approxTokens: 0,
	};
}

function section(index: number, itemId: string, content: string): WebEditorPreview["messages"][number] {
	return {
		id: `message-${index}`,
		diffKey: `stack-item:${itemId}:1`,
		title: itemId,
		role: "user",
		content,
		chars: content.length,
		approxTokens: 1,
	};
}

test("compiled draft diff aligns stack messages by stable source key after an insertion", () => {
	const saved = preview([section(0, "a", "A"), section(1, "b", "B")]);
	const draft = preview([section(0, "x", "X"), section(1, "a", "A"), section(2, "b", "B")]);

	const diff = diffTurns(
		previewToTurnSnapshot(saved, "saved"),
		previewToTurnSnapshot(draft, "draft"),
	);

	assert.equal(diff.summary.addedBlocks, 1);
	assert.equal(diff.summary.modifiedBlocks, 0);
	assert.equal(diff.summary.sameBlocks, 3);
	assert.deepEqual(diff.blocks.filter((block) => block.status !== "same").map((block) => block.after?.key), ["stack-item:x:1"]);
});
