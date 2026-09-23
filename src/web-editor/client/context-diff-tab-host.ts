// Independent inspector dock for the selected Preset, alongside any editor tab.
//
// This is intentionally separate from legacy-editor.ts. It uses the data-driven
// tab registry's built-in "preview" entry, renders through a dock-specific data
// attribute so the legacy tab click handler does not claim it, and mounts the
// self-contained ContextDiffPanel Vue component into the right-side dock.

import { subscribeEditorView } from "./editor-view-coordinator.ts";
import { getEditorTab } from "./tab-registry.ts";
import { createVueContextDiffHost } from "./vue-context-diff-host.ts";
import type { LegacyEditorDraft } from "./legacy-editor.ts";
import type { ReadingState } from "./components/ContextDiffPanel.vue";

export interface ContextDiffTabsDependencies {
	getStackDraft(): LegacyEditorDraft | undefined;
	subscribeStackDraft(listener: () => void): () => void;
}

export function startContextDiffTabs(deps: ContextDiffTabsDependencies): () => void {
	const dockArea = document.getElementById("editorDockArea");
	const panel = document.getElementById("contextDiffPanel");
	const status = document.getElementById("status");
	if (!dockArea || !panel) return () => {};

	const definition = getEditorTab("preview");
	if (!definition?.internalDock) return () => {};
	const button = document.querySelector<HTMLButtonElement>(`[data-dock-tab="${definition.id}"]`);
	if (!button) return () => {};

	const dockAreaElement: HTMLElement = dockArea;
	const panelElement: HTMLElement = panel;
	const buttonElement: HTMLButtonElement = button;
	const statusElement: HTMLElement | null = status;

	let active = false;
	let contextDiffHost: ReturnType<typeof createVueContextDiffHost> | undefined;

	function setStatus(text: string, tone = ""): void {
		if (!statusElement) return;
		statusElement.textContent = text;
		statusElement.style.color = tone === "error" ? "var(--error)" : tone === "success" ? "var(--success)" : "var(--muted)";
	}

	function setActiveButton(activeState: boolean): void {
		buttonElement.classList.toggle("active", activeState);
		buttonElement.setAttribute("aria-pressed", String(activeState));
	}

	function applyReadingMode(mode: ReadingState): void {
		dockAreaElement.dataset.reading = mode;
		dockAreaElement.classList.toggle("dock-side", mode === "side");
		dockAreaElement.classList.toggle("dock-wide", mode === "wide");
		dockAreaElement.classList.toggle("dock-focus", mode === "focus");
	}

	function clearActiveState(): void {
		if (!active) return;
		active = false;
		setActiveButton(false);
		dockAreaElement.classList.remove("dock-open");
		dockAreaElement.classList.remove("dock-side");
		dockAreaElement.classList.remove("dock-wide");
		dockAreaElement.classList.remove("dock-focus");
		delete dockAreaElement.dataset.reading;
		panelElement.classList.remove("open");
		contextDiffHost?.unmount();
		contextDiffHost = undefined;
	}

	function activate(): void {
		if (!deps.getStackDraft()) return;
		active = true;
		setActiveButton(true);
		dockAreaElement.classList.add("dock-open");
		panelElement.classList.add("open");
		if (!contextDiffHost) {
			contextDiffHost = createVueContextDiffHost({
				getStackDraft: deps.getStackDraft,
				subscribeStackDraft: (listener) => deps.subscribeStackDraft(() => {
					// A deleted final preset invalidates the inspector draft. Close the
					// pane through this existing subscription rather than inventing a
					// second source of selection state.
					if (!deps.getStackDraft()) {
						clearActiveState();
						return;
					}
					listener();
				}),
				setStatus,
				// ReadingState is owned by ContextDiffPanel; the host only reflects
				// its event in dock CSS through setReadingMode below.
				setExpanded: () => {},
				setReadingMode: (mode) => applyReadingMode(mode),
			});
		}
		contextDiffHost.mount(panelElement);
	}

	buttonElement.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (active) {
			clearActiveState();
			return;
		}
		activate();
	};

	const stopEditorNavigation = subscribeEditorView((viewId) => {
		if (active && ["items", "regex", "policy", "bindings", "stack"].includes(viewId)) {
			contextDiffHost?.revealEditor();
		}
	});

	return () => {
		stopEditorNavigation();
		buttonElement.onclick = null;
		clearActiveState();
	};
}
