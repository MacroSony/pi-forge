// Data-driven registry of the web editor's stack-editor tabs.
//
// This module is intentionally free of Vue/DOM imports so it can be unit-tested
// under Node. The stack editor's section nav is rendered from `EDITOR_TABS` in
// App.vue, and `vue-tab-host.ts` mounts a Vue component for every tab whose
// `mount` is `"vue"`. The legacy imperative items workspace remains a tab too
// (`mount: "legacy"`) so the nav, active-state handling, and
// disable-when-empty behavior in legacy-editor.ts keep working unchanged.

export type EditorTabMount = "legacy" | "vue";

export interface EditorTabDefinition {
	/** Stable string tab id; also emitted as the button's data-tab attribute. */
	id: string;
	/** Visible label on the tab button. */
	label: string;
	/** Glyph rendered via the button's data-icon attribute. */
	icon: string;
	/** Accessible tooltip on the tab button. */
	title: string;
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
}

export const EDITOR_TABS = [
	{
		id: "items",
		label: "Items",
		icon: "☰",
		title: "Edit prompt stack items",
		mount: "legacy",
		stackFields: [],
	},
	{
		id: "regex",
		label: "Regex",
		icon: ".*",
		title: "Edit regex transform rules",
		mount: "vue",
		stackFields: ["regex"],
	},
	{
		id: "policy",
		label: "Policy",
		icon: "⊕",
		title: "Edit active-tool policy and model-visible skill filtering",
		mount: "vue",
		stackFields: ["tools", "skills"],
	},
	{
		id: "stack",
		label: "Stack",
		icon: "{}",
		title: "Edit context options and raw stack JSON",
		mount: "vue",
		stackFields: ["context", "variables"],
	},
] as const satisfies readonly EditorTabDefinition[];

/** Human-readable button id for a tab, e.g. "regex" -> "regexTabBtn". */
export function editorTabButtonId(id: string): string {
	return `${id}TabBtn`;
}

export function getEditorTab(id: string): EditorTabDefinition | undefined {
	return EDITOR_TABS.find((tab) => tab.id === id);
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
