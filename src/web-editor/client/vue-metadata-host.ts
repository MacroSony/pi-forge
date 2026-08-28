import { t } from "./i18n.ts";
import { createApp, type App } from "vue";

import StackMetadataEditor from "./components/StackMetadataEditor.vue";
import type { EditorPromptStack } from "./types.ts";

export interface VueMetadataHostDependencies {
	getStack(): EditorPromptStack | null;
	getFilePath(): string;
	getCollapsed(): boolean;
	setCollapsed(collapsed: boolean): void;
	markDirty(): void;
	setStatus(text: string): void;
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
			collapsed: deps.getCollapsed(),
			onChange: deps.markDirty,
			onToggle: (collapsed: boolean) => {
				deps.setCollapsed(collapsed);
				deps.setStatus(collapsed ? t("status.metadataHidden") : t("status.metadataShown"));
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
