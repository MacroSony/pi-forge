import {
	createBlock,
	createTurnSnapshot,
	type TurnSnapshot,
} from "../../context-diff.ts";
import type { WebEditorPreview } from "../types.ts";

export function previewSections(value: WebEditorPreview | null): WebEditorPreview["messages"] {
	return value ? [value.system, ...(value.messages || [])] : [];
}

/** Converts compiled preview sections into stable blocks for saved-vs-draft alignment. */
export function previewToTurnSnapshot(value: WebEditorPreview, turnId: string): TurnSnapshot {
	return createTurnSnapshot({
		turnId,
		stackId: value.stackId,
		blocks: previewSections(value).map((section) => createBlock(
			section.diffKey ?? section.id,
			section.role ?? "",
			section.content,
		)),
	});
}
