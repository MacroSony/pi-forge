// Data-driven registry of the web editor's stack-editor tabs.
//
// This module is intentionally free of Vue/DOM imports so it can be unit-tested
// under Node. The stack editor's section nav is rendered from `EDITOR_TABS` in
// App.vue, and `vue-tab-host.ts` mounts a Vue component for every tab whose
// `mount` is `"vue"`. The legacy imperative items workspace remains a tab too
// (`mount: "legacy"`) so the nav, active-state handling, and
// disable-when-empty behavior in legacy-editor.ts keep working unchanged.

// Type-only import: this module stays runtime-free of Vue/DOM so it remains
// unit-testable under Node.
import type { MessageKey } from "./i18n.ts";

export type EditorTabMount = "legacy" | "vue";

export interface EditorTabDefinition {
	/** Stable string tab id; also emitted as the button's data-tab attribute. */
	id: string;
	/** Visible label on the tab button (i18n message key). */
	labelKey: MessageKey;
	/** Glyph rendered via the button's data-icon attribute. */
	icon: string;
	/** Accessible tooltip on the tab button (i18n message key). */
	titleKey: MessageKey;
	/**
	 * "legacy" tabs (items) render the imperative workspace; "vue" tabs mount a
	 * Vue component into the tab panel via vue-tab-host.
	 */
	mount: EditorTabMount;
	/**
	 * Stack fields this tab's editor writes back into the live stack draft when
	 * it reports a change. Optional fields are copied only when present.
	 */
	stackFields: readonly string[];
	/**
	 * True for built-in dock tabs managed by a dedicated internal host. These
	 * use a separate data attribute so legacy-editor.ts does not claim clicks.
	 */
	internalDock?: boolean;
}

export const EDITOR_TABS = [
	{
		id: "items",
		labelKey: "tab.items",
		icon: "☰",
		titleKey: "tab.itemsTitle",
		mount: "legacy",
		stackFields: [],
		internalDock: false,
	},
	{
		id: "regex",
		labelKey: "tab.regex",
		icon: ".*",
		titleKey: "tab.regexTitle",
		mount: "vue",
		stackFields: ["regex"],
		internalDock: false,
	},
	{
		id: "policy",
		labelKey: "tab.policy",
		icon: "⊕",
		titleKey: "tab.policyTitle",
		mount: "vue",
		stackFields: ["tools", "skills"],
		internalDock: false,
	},
	{
		id: "stack",
		labelKey: "tab.stack",
		icon: "{}",
		titleKey: "tab.stackTitle",
		mount: "vue",
		stackFields: ["context", "variables"],
		internalDock: false,
	},
	{
		id: "preview",
		labelKey: "tab.preview",
		icon: "◱",
		titleKey: "tab.previewTitle",
		mount: "vue",
		stackFields: [],
		internalDock: true,
	},
] as const satisfies readonly EditorTabDefinition[];

/** Human-readable button id for a tab, e.g. "regex" -> "regexTabBtn". */
export function editorTabButtonId(id: string): string {
	return `${id}TabBtn`;
}

export function getEditorTab(id: string): EditorTabDefinition | undefined {
	return EDITOR_TABS.find((tab): tab is (typeof EDITOR_TABS)[number] => tab.id === id);
}

export function isEditorVueTab(id: string): boolean {
	return getEditorTab(id)?.mount === "vue";
}

/**
 * Copies only the given optional stack fields from `source` into `target`,
 * deleting them from `target` when absent from `source`. Mirrors the previous
 * per-tab draft synchronization in vue-tab-host.
 */
export function copyStackFields<T extends object>(
	target: T,
	source: T,
	fields: readonly string[],
): void {
	const targetRecord = target as Record<string, unknown>;
	const sourceRecord = source as Record<string, unknown>;
	for (const key of fields) {
		if (key in sourceRecord) targetRecord[key] = sourceRecord[key];
		else delete targetRecord[key];
	}
}
