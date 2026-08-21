// Self-contained host for settings contributed through the UI contribution port.
//
// This module is intentionally separate from legacy-editor.ts: it discovers the
// contribution descriptors through the HTTP proxy, renders them in the top-level
// plugin Settings surface, and mounts SchemaForm.vue through the generic host.
// It never reaches into stack-editor layout or imperative state.

import { createEditorApi } from "./api.ts";
import { cloneJson, type FormValues } from "../schema-form.ts";
import { createVueSchemaFormHost } from "./vue-schema-form-host.ts";
import {
	settingsContributionButtonId,
	uniqueContributionDescriptors,
	type ContributionTabDescriptor,
} from "./contribution-settings.ts";

interface ContributionListResponse {
	tabs: ContributionTabDescriptor[];
	providerKey?: string | null;
}

interface ContributionSaveJob {
	tabId: string;
	values: FormValues;
	revision: number;
}

interface ContributionTabStatus {
	text: string;
	tone: string;
}

export interface ContributionSettingsHostOptions {
	onAvailabilityChanged?(available: boolean): void;
}

export function startContributionTabs(options: ContributionSettingsHostOptions = {}): () => void {
	const token = new URLSearchParams(location.search).get("token") || "";
	const api = createEditorApi(token);
	const nav = document.getElementById("contribSettingsNav");
	const panel = document.getElementById("contribSettingsPanel");
	if (!nav || !panel) return () => {};
	const navElement: HTMLElement = nav;
	const panelElement: HTMLElement = panel;

	let disposed = false;
	let activeTabId: string | undefined;
	let descriptors: ContributionTabDescriptor[] = [];
	let providerKey: string | null | undefined;
	const saveTimers = new Map<string, number>();
	const editRevisions = new Map<string, number>();
	const savedRevisions = new Map<string, number>();
	const draftValues = new Map<string, FormValues>();
	const tabStatuses = new Map<string, ContributionTabStatus>();
	const queuedSaves = new Map<string, ContributionSaveJob>();
	const saveOrder: string[] = [];
	let saveInFlight = false;
	let refreshTimer: number | undefined;
	let refreshSequence = 0;
	let schemaFormHost: ReturnType<typeof createVueSchemaFormHost> | undefined;

	const statusElement = document.getElementById("settingsStatus");

	function setStatus(text: string, tone = ""): void {
		if (!statusElement) return;
		statusElement.textContent = text;
		statusElement.style.color = tone === "error" ? "var(--error)" : tone === "success" ? "var(--success)" : "var(--muted)";
	}

	function setTabStatus(tabId: string, text: string, tone = ""): void {
		tabStatuses.set(tabId, { text, tone });
		if (activeTabId === tabId) setStatus(text, tone);
	}

	function showActiveStatus(): void {
		if (!activeTabId) return;
		const status = tabStatuses.get(activeTabId);
		if (status) setStatus(status.text, status.tone);
		else setStatus("Settings ready");
	}

	function isDirty(tabId: string): boolean {
		return (editRevisions.get(tabId) ?? 0) !== (savedRevisions.get(tabId) ?? 0);
	}

	function setContributionActive(): void {
		for (const button of navElement.querySelectorAll<HTMLButtonElement>("[data-contrib-tab]")) {
			button.classList.toggle("active", button.dataset.contribTab === activeTabId);
		}
	}

	function clearActiveState(): void {
		activeTabId = undefined;
		schemaFormHost?.unmount();
		schemaFormHost = undefined;
		setContributionActive();
		panelElement.replaceChildren();
	}

	function activate(tab: ContributionTabDescriptor): void {
		activeTabId = tab.tabId;
		setContributionActive();
		mount(tab);
		showActiveStatus();
	}

	function mount(tab: ContributionTabDescriptor): void {
		schemaFormHost?.unmount();
		schemaFormHost = createVueSchemaFormHost({
			getSchema: () => tab.schema,
			getValues: () => draftValues.get(tab.tabId) ?? tab.values,
			markDirty: () => {},
			setStatus: (text, tone) => setTabStatus(tab.tabId, text, tone),
			onChange: (values, error) => {
				draftValues.set(tab.tabId, cloneJson(values));
				const revision = (editRevisions.get(tab.tabId) ?? 0) + 1;
				editRevisions.set(tab.tabId, revision);
				cancelQueuedSave(tab.tabId);
				if (error) {
					clearSaveTimer(tab.tabId);
					setTabStatus(tab.tabId, error, "error");
					return;
				}
				setTabStatus(tab.tabId, "Unsaved changes");
				clearSaveTimer(tab.tabId);
				const timer = window.setTimeout(() => {
					saveTimers.delete(tab.tabId);
					enqueueSave({ tabId: tab.tabId, values, revision });
				}, 250);
				saveTimers.set(tab.tabId, timer);
			},
		});
		schemaFormHost.mount(panelElement);
	}

	function clearSaveTimer(tabId: string): void {
		const timer = saveTimers.get(tabId);
		if (timer !== undefined) window.clearTimeout(timer);
		saveTimers.delete(tabId);
	}

	function enqueueSave(job: ContributionSaveJob): void {
		if (!queuedSaves.has(job.tabId)) saveOrder.push(job.tabId);
		queuedSaves.set(job.tabId, job);
		void drainSaveQueue();
	}

	function cancelQueuedSave(tabId: string): void {
		if (!queuedSaves.delete(tabId)) return;
		const index = saveOrder.indexOf(tabId);
		if (index >= 0) saveOrder.splice(index, 1);
	}

	async function drainSaveQueue(): Promise<void> {
		if (saveInFlight) return;
		saveInFlight = true;
		try {
			while (!disposed && saveOrder.length > 0) {
				const tabId = saveOrder.shift()!;
				const job = queuedSaves.get(tabId);
				queuedSaves.delete(tabId);
				if (job) await save(job);
			}
		} finally {
			saveInFlight = false;
		}
	}

	async function save(job: ContributionSaveJob): Promise<void> {
		const { tabId, values, revision } = job;
		const requestProviderKey = providerKey;
		if (revision === editRevisions.get(tabId)) setTabStatus(tabId, "Saving");
		try {
			const response = await api<{ ok: true; values?: FormValues }>(`/api/contrib/${encodeURIComponent(tabId)}`, {
				method: "PUT",
				body: values,
			});
			if (disposed || revision !== editRevisions.get(tabId)) return;
			if (requestProviderKey !== providerKey) {
				const latestValues = draftValues.get(tabId) ?? values;
				setTabStatus(tabId, "Provider restarted; retrying");
				enqueueSave({ tabId, values: cloneJson(latestValues), revision });
				return;
			}
			const canonicalValues = response.values ?? values;
			const mountedValues = activeTabId === tabId ? schemaFormHost?.getValues() : undefined;
			draftValues.set(tabId, cloneJson(canonicalValues));
			savedRevisions.set(tabId, revision);
			const current = descriptors.find((candidate) => candidate.tabId === tabId);
			if (current) current.values = canonicalValues;
			if (current && mountedValues && JSON.stringify(mountedValues) !== JSON.stringify(canonicalValues)) mount(current);
			setTabStatus(tabId, "Saved", "success");
		} catch (error) {
			if (!disposed && revision === editRevisions.get(tabId)) {
				setTabStatus(tabId, error instanceof Error ? error.message : String(error), "error");
			}
		}
	}

	function renderButtons(): void {
		for (const button of navElement.querySelectorAll<HTMLButtonElement>("[data-contrib-tab]")) button.remove();
		for (const tab of descriptors) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "";
			button.id = settingsContributionButtonId(tab.tabId);
			button.dataset.contribTab = tab.tabId;
			button.dataset.icon = tab.icon;
			button.title = `Edit ${tab.title}`;
			button.textContent = tab.title;
			button.onclick = () => {
				const descriptor = descriptors.find((candidate) => candidate.tabId === tab.tabId);
				if (descriptor) activate(descriptor);
			};
			navElement.appendChild(button);
		}
		setContributionActive();
	}

	async function refresh(): Promise<void> {
		if (disposed) return;
		const sequence = ++refreshSequence;
		try {
			const data = await api<ContributionListResponse>("/api/contrib");
			if (disposed || sequence !== refreshSequence) return;
			const nextProviderKey = typeof data.providerKey === "string" ? data.providerKey : null;
			const providerChanged = providerKey !== nextProviderKey;
			providerKey = nextProviderKey;
			const previousDescriptors = new Map(descriptors.map((descriptor) => [descriptor.tabId, descriptor]));
			descriptors = uniqueContributionDescriptors(Array.isArray(data.tabs) ? data.tabs : []);
			for (const descriptor of descriptors) {
				if (!draftValues.has(descriptor.tabId) || (providerChanged && !isDirty(descriptor.tabId))) {
					draftValues.set(descriptor.tabId, cloneJson(descriptor.values));
					if (providerChanged) {
						editRevisions.set(descriptor.tabId, 0);
						savedRevisions.set(descriptor.tabId, 0);
						tabStatuses.delete(descriptor.tabId);
					}
				}
			}
			options.onAvailabilityChanged?.(descriptors.length > 0);
			renderButtons();
			if (activeTabId) {
				const stillPresent = descriptors.some((descriptor) => descriptor.tabId === activeTabId);
				if (!stillPresent) clearActiveState();
				else {
					const descriptor = descriptors.find((candidate) => candidate.tabId === activeTabId);
					const previous = previousDescriptors.get(activeTabId);
					const schemaChanged = !!descriptor && JSON.stringify(previous?.schema) !== JSON.stringify(descriptor.schema);
					if (descriptor && (!schemaFormHost || providerChanged || schemaChanged)) mount(descriptor);
					showActiveStatus();
				}
			} else if (descriptors[0]) activate(descriptors[0]);
			if (descriptors.length > 0 && statusElement?.textContent === "Loading settings…") setStatus("Settings ready");
		} catch (error) {
			if (disposed || sequence !== refreshSequence) return;
			clearActiveState();
			descriptors = [];
			options.onAvailabilityChanged?.(false);
			renderButtons();
			setStatus(error instanceof Error ? error.message : String(error), "error");
		}
	}

	void refresh();
	refreshTimer = window.setInterval(() => {
		void refresh();
	}, 1000);

	return () => {
		disposed = true;
		refreshSequence += 1;
		if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
		for (const timer of saveTimers.values()) window.clearTimeout(timer);
		saveTimers.clear();
		queuedSaves.clear();
		saveOrder.length = 0;
		clearActiveState();
		options.onAvailabilityChanged?.(false);
		for (const button of navElement.querySelectorAll<HTMLButtonElement>("[data-contrib-tab]")) button.remove();
	};
}
