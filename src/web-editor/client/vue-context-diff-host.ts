import { createApp, type App } from "vue";

import ContextDiffPanel, { type ReadingState, type InstructionLocation } from "./components/ContextDiffPanel.vue";
import type { LegacyEditorDraft } from "./legacy-editor.ts";

export interface VueContextDiffHostDependencies {
	getStackDraft(): LegacyEditorDraft | undefined;
	subscribeStackDraft(listener: () => void): () => void;
	setStatus(text: string, tone?: string): void;
	setExpanded(expanded: boolean): void;
	setReadingMode?(mode: ReadingState): void;
}

/** Mounts the self-contained preview/diff dock component into a root element. */
export function createVueContextDiffHost(deps: VueContextDiffHostDependencies) {
	let app: App<Element> | undefined;
	let panel: { revealEditor(): void; locateInstruction(target: InstructionLocation): Promise<void> } | undefined;

	function mount(root: Element): void {
		unmount();
		app = createApp(ContextDiffPanel, {
			getStackDraft: deps.getStackDraft,
			subscribeStackDraft: deps.subscribeStackDraft,
			onStatus: deps.setStatus,
			onExpandedChanged: deps.setExpanded,
			onReadingChanged: (mode: ReadingState) => {
				deps.setReadingMode?.(mode);
				deps.setExpanded(mode === "focus");
			},
		});
		panel = app.mount(root) as unknown as { revealEditor(): void; locateInstruction(target: InstructionLocation): Promise<void> };
	}

	function unmount(): void {
		app?.unmount();
		app = undefined;
		panel = undefined;
	}

	return { mount, unmount, revealEditor: () => panel?.revealEditor(), locateInstruction: (target: InstructionLocation) => panel?.locateInstruction(target) };
}
