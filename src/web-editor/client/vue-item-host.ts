import { t } from "./i18n.ts";
import { createApp, type App } from "vue";

import StackItemEditor from "./components/StackItemEditor.vue";
import type { EditorPromptStack, EditorPromptStackItem } from "./types.ts";

export interface VueItemHostDependencies {
	getStack(): EditorPromptStack | null;
	getSelectedIndex(): number;
	getSlotNames(): string[];
	roles: string[];
	markDirty(): void;
	renderItemList(): void;
	setStatus(text: string, tone?: string): void;
}

export function createVueItemHost(deps: VueItemHostDependencies) {
	let app: App<Element> | undefined;
	let mode: "form" | "json" = "form";
	let error = "";

	function mount(root: Element): boolean {
		unmount();
		error = "";
		const stack = deps.getStack();
		const index = deps.getSelectedIndex();
		const item = stack?.items[index];
		if (!stack || !item) return false;

		app = createApp(StackItemEditor, {
			item,
			mode,
			slotNames: deps.getSlotNames(),
			roles: deps.roles,
			onChange: (refreshList: boolean) => {
				error = "";
				deps.markDirty();
				if (refreshList) deps.renderItemList();
			},
			onError: (message: string) => {
				error = message;
				if (message) deps.setStatus(t("error.invalidItemOptionsShort"), "error");
			},
			onMode: (next: "form" | "json") => {
				mode = next;
			},
			onReplace: (replacement: EditorPromptStackItem) => {
				stack.items[index] = replacement;
				error = "";
				deps.markDirty();
				deps.renderItemList();
				mount(root);
			},
		});
		app.mount(root);
		return true;
	}

	function unmount(): void {
		app?.unmount();
		app = undefined;
	}

	function reset(): void {
		mode = "form";
		error = "";
	}

	return {
		mount,
		unmount,
		reset,
		getError: () => error,
	};
}
