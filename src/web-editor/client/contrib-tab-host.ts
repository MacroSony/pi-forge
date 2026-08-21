// Self-contained host for tabs contributed through the UI contribution port.
//
// This module is intentionally separate from legacy-editor.ts: it discovers the
// contribution descriptors through the HTTP proxy, registers them in the data-
// driven tab registry, renders their buttons in the same stack-editor tab bar,
// and mounts SchemaForm.vue through the generic vue-schema-form host. It never
// reaches into the legacy editor's imperative state.

import { createEditorApi } from "./api.ts";
import type { FormSchema, FormValues } from "../schema-form.ts";
import { clearContributedTabs, editorTabButtonId, getEditorTabs, setContributedTabs, type EditorTabDefinition } from "./tab-registry.ts";
import { createVueSchemaFormHost } from "./vue-schema-form-host.ts";

interface ContributionTabDescriptor {
	tabId: string;
	title: string;
	icon: string;
	schema: FormSchema;
	values: FormValues;
}

interface ContributionListResponse {
	tabs: ContributionTabDescriptor[];
}

export function startContributionTabs(): () => void {
	const token = new URLSearchParams(location.search).get("token") || "";
	const api = createEditorApi(token);
	const nav = document.querySelector<HTMLElement>(".view-tabs");
	const workspace = document.getElementById("workspace");
	const panel = document.getElementById("tabPanel");
	if (!nav || !workspace || !panel) return () => {};
	const navElement: HTMLElement = nav;
	const workspaceElement: HTMLElement = workspace;
	const panelElement: HTMLElement = panel;

	let disposed = false;
	let activeTabId: string | undefined;
	let descriptors: ContributionTabDescriptor[] = [];
	let saveTimer: number | undefined;
	let refreshTimer: number | undefined;
	let refreshSequence = 0;
	let schemaFormHost: ReturnType<typeof createVueSchemaFormHost> | undefined;

	const statusElement = document.getElementById("status");

	function setStatus(text: string, tone = ""): void {
		if (!statusElement) return;
		statusElement.textContent = text;
		statusElement.style.color = tone === "error" ? "var(--error)" : tone === "success" ? "var(--success)" : "var(--muted)";
	}

	function setContributionActive(active: boolean): void {
		for (const button of navElement.querySelectorAll<HTMLButtonElement>("[data-contrib-tab]")) {
			button.classList.toggle("active", active && button.dataset.contribTab === activeTabId);
		}
	}

	function clearActiveState(restoreLayout = true): void {
		const hadActiveContribution = activeTabId !== undefined;
		activeTabId = undefined;
		schemaFormHost?.unmount();
		schemaFormHost = undefined;
		setContributionActive(false);
		if (restoreLayout && hadActiveContribution) {
			workspaceElement.style.display = "";
			panelElement.classList.remove("open");
		}
	}

	function activate(tab: ContributionTabDescriptor): void {
		activeTabId = tab.tabId;
		// The legacy editor only knows about its own [data-tab] buttons. These
		// contribution buttons carry a separate attribute, so clear the legacy
		// active highlight here and manage contribution active state ourselves.
		for (const button of navElement.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
			button.classList.remove("active");
		}
		setContributionActive(true);
		workspaceElement.style.display = "none";
		panelElement.classList.add("open");
		mount(tab);
	}

	function mount(tab: ContributionTabDescriptor): void {
		schemaFormHost?.unmount();
		schemaFormHost = createVueSchemaFormHost({
			getSchema: () => tab.schema,
			getValues: () => tab.values,
			markDirty: () => {},
			setStatus,
			onChange: (values, error) => {
				if (error) {
					if (saveTimer !== undefined) window.clearTimeout(saveTimer);
					saveTimer = undefined;
					setStatus(error, "error");
					return;
				}
				if (saveTimer !== undefined) window.clearTimeout(saveTimer);
				saveTimer = window.setTimeout(() => {
					saveTimer = undefined;
					void save(tab, values);
				}, 250);
			},
		});
		schemaFormHost.mount(panelElement);
	}

	async function save(tab: ContributionTabDescriptor, values: FormValues): Promise<void> {
		setStatus("Saving");
		try {
			const response = await api<{ ok: true; values?: FormValues }>(`/api/contrib/${encodeURIComponent(tab.tabId)}`, {
				method: "PUT",
				body: values,
			});
			if (response.values) tab.values = response.values;
			setStatus("Saved", "success");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error), "error");
		}
	}

	function renderButtons(): void {
		for (const button of navElement.querySelectorAll<HTMLButtonElement>("[data-contrib-tab]")) button.remove();
		for (const tab of getEditorTabs()) {
			if (!tab.contributed) continue;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "";
			button.id = editorTabButtonId(tab.id);
			button.dataset.contribTab = tab.id;
			button.dataset.icon = tab.icon;
			button.title = tab.title;
			button.textContent = tab.label;
			button.onclick = () => {
				const descriptor = descriptors.find((candidate) => candidate.tabId === tab.id);
				if (descriptor) activate(descriptor);
			};
			navElement.appendChild(button);
		}
		setContributionActive(activeTabId !== undefined);
	}

	async function refresh(): Promise<void> {
		if (disposed) return;
		const sequence = ++refreshSequence;
		try {
			const data = await api<ContributionListResponse>("/api/contrib");
			if (disposed || sequence !== refreshSequence) return;
			descriptors = Array.isArray(data.tabs) ? data.tabs : [];
			const definitions: EditorTabDefinition[] = descriptors.map((descriptor) => ({
				id: descriptor.tabId,
				label: descriptor.title,
				icon: descriptor.icon,
				title: `Edit ${descriptor.title}`,
				mount: "vue",
				stackFields: [],
			}));
			setContributedTabs(definitions);
			renderButtons();
			if (activeTabId) {
				const stillPresent = descriptors.some((descriptor) => descriptor.tabId === activeTabId);
				if (!stillPresent) clearActiveState();
				else if (!schemaFormHost) {
					const descriptor = descriptors.find((candidate) => candidate.tabId === activeTabId);
					if (descriptor) mount(descriptor);
				}
			}
		} catch (error) {
			if (disposed || sequence !== refreshSequence) return;
			clearContributedTabs();
			clearActiveState();
			renderButtons();
			setStatus(error instanceof Error ? error.message : String(error), "error");
		}
	}

	// Static tab clicks are handled by legacy-editor first; this post-handler
	// only clears the contribution-specific active state after legacy has run.
	const onNavClick = (event: MouseEvent): void => {
		const target = event.target as HTMLElement;
		if (target.closest("[data-contrib-tab]")) return;
		if (target.closest("[data-tab]")) clearActiveState(false);
	};

	navElement.addEventListener("click", onNavClick);
	void refresh();
	refreshTimer = window.setInterval(() => {
		void refresh();
	}, 1000);

	return () => {
		disposed = true;
		refreshSequence += 1;
		if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
		if (saveTimer !== undefined) window.clearTimeout(saveTimer);
		navElement.removeEventListener("click", onNavClick);
		clearActiveState();
		clearContributedTabs();
		for (const button of navElement.querySelectorAll<HTMLButtonElement>("[data-contrib-tab]")) button.remove();
	};
}
