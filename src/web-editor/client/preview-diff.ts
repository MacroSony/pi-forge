import {
	createBlock,
	createTurnSnapshot,
	type TurnSnapshot,
} from "../../context-diff.ts";
import type { WebEditorPreview, WebEditorPreviewSection } from "../types.ts";

import { isTrulyEmptySystemSection, previewSectionText } from "../../preview-text.ts";
export { isTrulyEmptySystemSection, previewSectionText } from "../../preview-text.ts";

export function previewSections(value: WebEditorPreview | null): WebEditorPreviewSection[] {
	if (!value) return [];
	const sections: WebEditorPreviewSection[] = [];
	if (value.system && !isTrulyEmptySystemSection(value.system)) {
		sections.push(value.system);
	}
	for (const msg of value.messages || []) {
		if (isTrulyEmptySystemSection(msg)) continue;
		sections.push(msg);
	}
	return sections;
}

/** Converts compiled preview sections into stable blocks for saved-vs-draft alignment. */
export function previewToTurnSnapshot(value: WebEditorPreview, turnId: string): TurnSnapshot {
	const sections = previewSections(value);
	const systemKey = value.system?.diffKey ?? value.system?.id ?? "system";
	const hasSystem = sections.some((s) => (s.diffKey ?? s.id) === systemKey || s.id === "system");
	const targetSections = (!hasSystem && value.system)
		? [value.system, ...sections]
		: sections;

	return createTurnSnapshot({
		turnId,
		stackId: value.stackId,
		blocks: targetSections.map((section) => {
			const text = previewSectionText(section);
			const metadata: Record<string, unknown> = {};
			if (section.sections && Object.keys(section.sections).length > 0) {
				metadata.sections = section.sections;
			}
			if (section.toolChanges && (
				(section.toolChanges.added && section.toolChanges.added.length > 0) ||
				(section.toolChanges.removed && section.toolChanges.removed.length > 0)
			)) {
				metadata.toolChanges = section.toolChanges;
			}
			const isSystem = (section.diffKey ?? section.id) === systemKey || section.id === "system";
			if (isSystem && value.selectedTools !== undefined) {
				metadata.selectedTools = value.selectedTools;
			}
			const serialized = Object.keys(metadata).length > 0 ? metadata : undefined;
			const block = createBlock(
				section.diffKey ?? section.id,
				section.role ?? "",
				text,
				serialized,
			);
			if (!text.length) block.approxTokens = 0;
			return block;
		}),
	});
}
