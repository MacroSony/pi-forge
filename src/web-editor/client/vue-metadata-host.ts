import type { MessageKey } from "./i18n.ts";
import { createApp, type App } from "vue";

import StackMetadataEditor from "./components/StackMetadataEditor.vue";
import type { EditorPromptStack } from "./types.ts";

export interface VueMetadataHostDependencies {
	getStack(): EditorPromptStack | null;
	getFilePath(): string;
	getPresetSelector?(): string;
	getPresetScope?(): "project" | "global";
	getCollapsed(): boolean;
	setCollapsed(collapsed: boolean): void;
	markDirty(): void;
	setStatus(text: string, tone?: string, semantic?: { key: MessageKey; params?: Record<string, string | number> }): void;
}

export function createVueMetadataHost(deps: VueMetadataHostDependencies) {
	let app: App<Element> | undefined;

	function mount(root: Element): void {
		unmount();
		const stack = deps.getStack();
		if (!stack) return;
		app = createApp(StackMetadataEditor, {
			stack,
			filePath: deps.getFilePath(),
			presetSelector: deps.getPresetSelector?.() ?? (stack.id ? `project:${stack.id}` : ""),
			presetScope: deps.getPresetScope?.() ?? (deps.getPresetSelector?.()?.startsWith("global:") ? "global" : "project"),
			collapsed: deps.getCollapsed(),
			onChange: deps.markDirty,
			onToggle: (collapsed: boolean) => {
				deps.setCollapsed(collapsed);
			},
		});
		app.mount(root);
	}

	function unmount(): void {
		app?.unmount();
		app = undefined;
	}

	return { mount, unmount };
}
