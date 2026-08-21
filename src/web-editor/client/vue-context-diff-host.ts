import { createApp, type App } from "vue";

import ContextDiffPanel from "./components/ContextDiffPanel.vue";

export interface VueContextDiffHostDependencies {
	getStackId(): string | undefined;
	setStatus(text: string, tone?: string): void;
}

/** Mounts the self-contained preview/diff dock component into a root element. */
export function createVueContextDiffHost(deps: VueContextDiffHostDependencies) {
	let app: App<Element> | undefined;

	function mount(root: Element): void {
		unmount();
		app = createApp(ContextDiffPanel, {
			getStackId: deps.getStackId,
			onStatus: deps.setStatus,
		});
		app.mount(root);
	}

	function unmount(): void {
		app?.unmount();
		app = undefined;
	}

	return { mount, unmount };
}
