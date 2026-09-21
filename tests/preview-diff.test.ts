import assert from "node:assert/strict";
import test from "node:test";

import { diffTurns } from "../src/context-diff.ts";
import {
	previewSections,
	previewSectionText,
	previewToTurnSnapshot,
} from "../src/web-editor/client/preview-diff.ts";
import type { WebEditorPreview } from "../src/web-editor/types.ts";

function preview(messages: WebEditorPreview["messages"], options?: {
	systemContent?: string;
	systemSections?: Record<string, string | null>;
	systemToolChanges?: { added: Array<{ name: string; description?: string; parameters?: unknown }>; removed: string[] };
	selectedTools?: string[];
}): WebEditorPreview {
	return {
		stackId: "draft",
		generatedAt: "",
		system: {
			id: "system",
			diffKey: "system",
			title: "System",
			content: options?.systemContent ?? "system",
			sections: options?.systemSections,
			toolChanges: options?.systemToolChanges,
			chars: (options?.systemContent ?? "system").length,
			approxTokens: 2,
		},
		messages,
		selectedTools: options?.selectedTools,
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

test("previewSections hides truly empty system section but preserves empty non-system messages", () => {
	const trulyEmptySystem = preview([section(0, "u1", "")], { systemContent: "" });
	trulyEmptySystem.system.sections = undefined;
	trulyEmptySystem.system.toolChanges = undefined;

	const sections = previewSections(trulyEmptySystem);
	assert.equal(sections.length, 1);
	assert.equal(sections[0]?.id, "message-0");
	assert.equal(sections[0]?.content, "");

	assert.deepEqual(previewSections(null), []);
});

test("previewSections preserves system section if native sections or toolChanges exist", () => {
	const withSectionOp = preview([], {
		systemContent: "",
		systemSections: { extra_instruction: null },
	});
	assert.equal(previewSections(withSectionOp).length, 1);
	assert.equal(previewSections(withSectionOp)[0]?.id, "system");

	const withToolChanges = preview([], {
		systemContent: "",
		systemToolChanges: { added: [{ name: "search" }], removed: [] },
	});
	assert.equal(previewSections(withToolChanges).length, 1);
	assert.equal(previewSections(withToolChanges)[0]?.id, "system");
});

test("previewSections preserves messages containing literal Added tool strings", () => {
	const literalUserMsg = section(0, "u1", 'User asked: "Added tool foo" and "Removed tool bar"');
	const p = preview([literalUserMsg]);
	const sections = previewSections(p);
	assert.equal(sections.length, 2);
	assert.equal(sections[1]?.content, 'User asked: "Added tool foo" and "Removed tool bar"');
});

test("previewSectionText concatenates body and non-null section values without pseudo headers or tool metadata", () => {
	const s = {
		id: "system",
		title: "System",
		content: "Base system body",
		sections: {
			rule_a: "Section A content",
			rule_b: null,
			rule_c: "Section C content",
		},
		toolChanges: {
			added: [{ name: "new_tool", description: "a new tool" }],
			removed: ["old_tool"],
		},
		chars: 100,
		approxTokens: 25,
	};

	const text = previewSectionText(s);
	assert.equal(text, "Base system body\n\nSection A content\n\nSection C content");
	assert.ok(!text.includes("new_tool"));
	assert.ok(!text.includes("old_tool"));
	assert.ok(!text.includes("rule_a"));
	assert.ok(!text.includes("rule_b"));
	assert.ok(!text.includes("Added tool"));
});

test("previewSectionText returns empty string for metadata-only section", () => {
	const metadataOnly = {
		id: "system",
		title: "System",
		content: "",
		sections: {
			rule_b: null,
		},
		toolChanges: {
			added: [{ name: "new_tool" }],
			removed: ["old_tool"],
		},
		chars: 0,
		approxTokens: 0,
	};

	assert.equal(previewSectionText(metadataOnly), "");
});

test("previewToTurnSnapshot counts text-only tokens/chars and uses serialized metadata for block hash", () => {
	const p = preview([], {
		systemContent: "Hello prompt",
		systemSections: { extra: "Extra prompt" },
		systemToolChanges: { added: [{ name: "tool1", description: "desc" }], removed: [] },
	});

	const snapshot = previewToTurnSnapshot(p, "turn-1");
	assert.equal(snapshot.blocks.length, 1);
	const block = snapshot.blocks[0]!;
	assert.equal(block.text, "Hello prompt\n\nExtra prompt");
	assert.equal(block.chars, "Hello prompt\n\nExtra prompt".length);
	assert.ok(!block.text.includes("tool1"));

	const pWithoutTools = preview([], {
		systemContent: "Hello prompt",
		systemSections: { extra: "Extra prompt" },
	});
	const snapshotWithoutTools = previewToTurnSnapshot(pWithoutTools, "turn-1");
	assert.equal(snapshotWithoutTools.blocks[0]!.text, block.text);
	assert.notEqual(snapshotWithoutTools.blocks[0]!.hash, block.hash);
});

test("previewToTurnSnapshot structural removal changes block hash without changing text", () => {
	const saved = preview([], {
		systemContent: "Prompt",
		systemSections: { removed_rule: null },
	});
	const draft = preview([], {
		systemContent: "Prompt",
	});

	const diff = diffTurns(
		previewToTurnSnapshot(saved, "saved"),
		previewToTurnSnapshot(draft, "draft"),
	);

	assert.equal(diff.summary.modifiedBlocks, 1);
	assert.equal(diff.blocks[0]?.status, "modified");
	assert.equal(diff.blocks[0]?.before?.text, "Prompt");
	assert.equal(diff.blocks[0]?.after?.text, "Prompt");
	assert.notEqual(diff.blocks[0]?.before?.hash, diff.blocks[0]?.after?.hash);
});

test("previewToTurnSnapshot toolChanges-only modification produces metadata-only diff", () => {
	const saved = preview([], {
		systemContent: "Prompt",
	});
	const draft = preview([], {
		systemContent: "Prompt",
		systemToolChanges: { added: [{ name: "inspect_tool" }], removed: [] },
	});

	const diff = diffTurns(
		previewToTurnSnapshot(saved, "saved"),
		previewToTurnSnapshot(draft, "draft"),
	);

	assert.equal(diff.summary.modifiedBlocks, 1);
	assert.equal(diff.blocks[0]?.status, "modified");
	assert.equal(diff.blocks[0]?.before?.text, "Prompt");
	assert.equal(diff.blocks[0]?.after?.text, "Prompt");
	assert.notEqual(diff.blocks[0]?.before?.hash, diff.blocks[0]?.after?.hash);
});

test("previewToTurnSnapshot selectedTools-only change affects draft diff as metadata-only change", () => {
	const saved = preview([], {
		systemContent: "Prompt",
		selectedTools: ["read"],
	});
	const draft = preview([], {
		systemContent: "Prompt",
		selectedTools: ["read", "write"],
	});

	const diff = diffTurns(
		previewToTurnSnapshot(saved, "saved"),
		previewToTurnSnapshot(draft, "draft"),
	);

	assert.equal(diff.summary.modifiedBlocks, 1);
	assert.equal(diff.blocks[0]?.status, "modified");
	assert.equal(diff.blocks[0]?.before?.text, "Prompt");
	assert.equal(diff.blocks[0]?.after?.text, "Prompt");
	assert.notEqual(diff.blocks[0]?.before?.hash, diff.blocks[0]?.after?.hash);
});

test("previewToTurnSnapshot selectedTools-only change on stack with truly empty system section still affects draft diff", () => {
	const saved = preview([], {
		systemContent: "",
		selectedTools: ["read"],
	});
	const draft = preview([], {
		systemContent: "",
		selectedTools: ["read", "write"],
	});

	const diff = diffTurns(
		previewToTurnSnapshot(saved, "saved"),
		previewToTurnSnapshot(draft, "draft"),
	);

	assert.equal(diff.summary.modifiedBlocks, 1);
	assert.equal(diff.blocks[0]?.status, "modified");
	assert.equal(diff.blocks[0]?.before?.text, "");
	assert.equal(diff.blocks[0]?.after?.text, "");
	assert.notEqual(diff.blocks[0]?.before?.hash, diff.blocks[0]?.after?.hash);
});
