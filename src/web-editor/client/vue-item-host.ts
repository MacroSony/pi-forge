import { t, type MessageKey } from "./i18n.ts";
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
	deleteSelectedItem(): void;
	copyText(text: string): Promise<void>;
	setStatus(text: string, tone?: string, semantic?: { key: MessageKey; params?: Record<string, string | number> }): void;
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
			onDelete: () => {
				if (deps.getStack() === stack && deps.getSelectedIndex() === index) deps.deleteSelectedItem();
			},
			onCopyId: async () => {
				try {
					await deps.copyText(item.id);
					deps.setStatus(t("polish.workspace.idCopied"), "success", { key: "polish.workspace.idCopied" });
				} catch (caught) { deps.setStatus(String(caught), "error"); }
			},
			onError: (message: string) => {
				error = message;
				if (message) deps.setStatus(t("error.invalidItemOptionsShort"), "error", { key: "error.invalidItemOptionsShort" });
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

	function reset(nextMode: "form" | "json" = "form"): void {
		mode = nextMode;
		error = "";
	}

	return {
		mount,
		unmount,
		reset,
		getMode: () => mode,
		getError: () => error,
	};
}
