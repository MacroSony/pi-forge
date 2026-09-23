// Internal dock host for the preview/context-diff tab.
//
// This is intentionally separate from legacy-editor.ts. It uses the data-driven
// tab registry's built-in "preview" entry, renders through a dock-specific data
// attribute so the legacy tab click handler does not claim it, and mounts the
// self-contained ContextDiffPanel Vue component into the right-side dock.

import { getEditorTab } from "./tab-registry.ts";
import { createVueContextDiffHost } from "./vue-context-diff-host.ts";
import { activateEditorView, subscribeEditorView } from "./editor-view-coordinator.ts";
import type { LegacyEditorDraft } from "./legacy-editor.ts";
import type { ReadingState } from "./components/ContextDiffPanel.vue";

export interface ContextDiffTabsDependencies {
	getStackDraft(): LegacyEditorDraft | undefined;
	subscribeStackDraft(listener: () => void): () => void;
}

export function startContextDiffTabs(deps: ContextDiffTabsDependencies): () => void {
	const nav = document.querySelector<HTMLElement>(".view-tabs");
	const dockArea = document.getElementById("editorDockArea");
	const workspace = document.getElementById("workspace");
	const legacyPanel = document.getElementById("tabPanel");
	const panel = document.getElementById("contextDiffPanel");
	const status = document.getElementById("status");
	if (!nav || !dockArea || !workspace || !legacyPanel || !panel) return () => {};

	const definition = getEditorTab("preview");
	if (!definition?.internalDock) return () => {};
	const definitionId = definition.id;

	const button = document.querySelector<HTMLButtonElement>(`[data-dock-tab="${definitionId}"]`);
	if (!button) return () => {};

	const navElement: HTMLElement = nav;
	const dockAreaElement: HTMLElement = dockArea;
	const workspaceElement: HTMLElement = workspace;
	const legacyPanelElement: HTMLElement = legacyPanel;
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
	}

	function clearLegacyActive(): void {
		for (const element of navElement.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
			element.classList.remove("active");
		}
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
		activateEditorView(definitionId);
		active = true;
		clearLegacyActive();
		setActiveButton(true);
		workspaceElement.style.display = "";
		legacyPanelElement.classList.remove("open");
		dockAreaElement.classList.add("dock-open");
		panelElement.classList.add("open");
		if (!contextDiffHost) {
			contextDiffHost = createVueContextDiffHost({
				getStackDraft: deps.getStackDraft,
				subscribeStackDraft: deps.subscribeStackDraft,
				setStatus,
				setExpanded: (expanded) => {
					if (expanded) {
						applyReadingMode("focus");
					} else if (dockAreaElement.dataset.reading === "focus") {
						applyReadingMode("side");
					}
				},
				setReadingMode: (mode) => applyReadingMode(mode),
			});
		}
		contextDiffHost.mount(panelElement);
	}

	buttonElement.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		if (active) {
			document.querySelector<HTMLButtonElement>('[data-tab="items"]')?.click();
			return;
		}
		activate();
	};
	const stopEditorView = subscribeEditorView((viewId) => {
		if (viewId !== definitionId) clearActiveState();
	});

	return () => {
		buttonElement.onclick = null;
		stopEditorView();
		clearActiveState();
	};
}
