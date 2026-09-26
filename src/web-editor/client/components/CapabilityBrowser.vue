<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { createEditorApi, EditorApiError } from "../api.ts";
import { t, tp } from "../i18n.ts";
import type { CapabilityCollection, CapabilityEntry } from "../types.ts";
import CapabilityEditor from "./CapabilityEditor.vue";

const props = defineProps<{
	active: boolean;
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

const collection = ref<CapabilityCollection>();
const selectedSelector = ref("");
const loadError = ref("");
const loading = ref(false);
const editorMode = ref<"create" | "edit">();
const actionStatus = ref("");
const actionError = ref("");
const actionBusy = ref(false);
const isEditorDirty = ref(false);

let isUnmounted = false;
let requestId = 0;

onBeforeUnmount(() => {
	isUnmounted = true;
});

function getCapabilities(col: CapabilityCollection | undefined): CapabilityEntry[] {
	return col?.capabilities ?? [];
}

function getCapability(entry: CapabilityEntry | undefined) {
	return entry?.capability;
}

const selected = computed<CapabilityEntry | undefined>(() => {
	const items = getCapabilities(collection.value);
	return items.find((entry) => entry.selector === selectedSelector.value);
});

let interactionVersion = 0;
let editorSession = 0;
let mutationId = 0;
let pendingCollection: { value: CapabilityCollection; interactionVersion: number } | undefined;

function applyCollection(next: CapabilityCollection, chooseFallback: boolean): void {
	collection.value = next;
	const items = getCapabilities(next);
	if (chooseFallback && !items.some((entry) => entry.selector === selectedSelector.value)) {
		selectedSelector.value = items[0]?.selector ?? "";
	}
}

function applyPendingCollection(): void {
	if (!pendingCollection) return;
	const pending = pendingCollection;
	pendingCollection = undefined;
	applyCollection(pending.value, pending.interactionVersion === interactionVersion);
}

watch(
	() => props.active,
	(active) => {
		if (active) void loadCapabilities();
	},
	{ immediate: true },
);

async function loadCapabilities(fromUserClick = false): Promise<void> {
	if (actionBusy.value) return;
	const reqId = ++requestId;
	const startedInteraction = interactionVersion;
	const startedEditorSession = editorSession;
	loading.value = true;
	loadError.value = "";
	if (!fromUserClick) actionError.value = "";
	try {
		const next = await api<CapabilityCollection>("/api/capabilities");
		if (reqId !== requestId || isUnmounted) return;
		const sameView = startedInteraction === interactionVersion && startedEditorSession === editorSession;
		if (isEditorDirty.value) {
			if (sameView) pendingCollection = { value: next, interactionVersion: startedInteraction };
			return;
		}
		if (!sameView) return;

		applyCollection(next, true);
		if (fromUserClick && editorMode.value) {
			editorMode.value = undefined;
			isEditorDirty.value = false;
		}
	} catch (error) {
		if (reqId !== requestId || isUnmounted) return;
		loadError.value = error instanceof Error ? error.message : String(error);
	} finally {
		if (reqId === requestId && !isUnmounted) {
			loading.value = false;
		}
	}
}

function selectCapability(entry: CapabilityEntry): void {
	if (entry.selector === selected.value?.selector && !editorMode.value) return;
	if (isEditorDirty.value && !window.confirm(t("capabilities.confirmDiscard"))) return;
	mutationId++;
	interactionVersion++;
	selectedSelector.value = entry.selector;
	editorMode.value = undefined;
	isEditorDirty.value = false;
	editorSession++;
	applyPendingCollection();
	actionStatus.value = "";
	actionError.value = "";
}

function startCreate(): void {
	if (isEditorDirty.value && !window.confirm(t("capabilities.confirmDiscard"))) return;
	interactionVersion++;
	editorSession++;
	editorMode.value = "create";
	isEditorDirty.value = false;
	actionStatus.value = "";
	actionError.value = "";
}

function startEdit(): void {
	if (isEditorDirty.value && !window.confirm(t("capabilities.confirmDiscard"))) return;
	interactionVersion++;
	editorSession++;
	editorMode.value = "edit";
	isEditorDirty.value = false;
	actionStatus.value = "";
	actionError.value = "";
}

function handleEditorCancel(): void {
	mutationId++;
	actionBusy.value = false;
	interactionVersion++;
	editorSession++;
	editorMode.value = undefined;
	isEditorDirty.value = false;
	applyPendingCollection();
}

async function handleEditorSaved(savedSelector: string, savedId: string): Promise<void> {
	const opId = ++mutationId;
	const session = editorSession;
	const view = interactionVersion;
	const wasCreate = editorMode.value === "create";
	const reqId = ++requestId;
	loading.value = false;
	actionBusy.value = true;
	try {
		const next = await api<CapabilityCollection>("/api/capabilities");
		if (
			isUnmounted || opId !== mutationId || reqId !== requestId
			|| session !== editorSession || view !== interactionVersion
		) return;
		applyCollection(next, false);
		pendingCollection = undefined;
		selectedSelector.value = savedSelector;
		actionStatus.value = t(wasCreate ? "capabilities.created" : "capabilities.saved", { id: savedId });
		const retainEditor = isEditorDirty.value;
		if (!retainEditor) {
			editorMode.value = undefined;
			isEditorDirty.value = false;
			editorSession++;
		}
	} catch (err) {
		if (isUnmounted || opId !== mutationId || reqId !== requestId) return;
		actionError.value = err instanceof Error ? err.message : String(err);
	} finally {
		if (!isUnmounted && opId === mutationId) actionBusy.value = false;
	}
}

async function deleteSelected(): Promise<void> {
	const target = selected.value;
	if (!target) return;
	const targetCap = getCapability(target);
	const targetId = targetCap?.id || target.selector;
	if (!window.confirm(t("capabilities.confirmDelete", { id: targetId }))) return;

	const opId = ++mutationId;
	const session = editorSession;
	const view = interactionVersion;
	const targetSelector = target.selector;
	const reqId = ++requestId;
	loading.value = false;
	actionBusy.value = true;
	actionStatus.value = "";
	actionError.value = "";
	try {
		await api(`/api/capabilities/${encodeURIComponent(targetSelector)}`, {
			method: "DELETE",
			body: { expectedSourceRevision: target.sourceRevision },
		});
		const next = await api<CapabilityCollection>("/api/capabilities");
		if (
			isUnmounted || opId !== mutationId || reqId !== requestId
			|| session !== editorSession || view !== interactionVersion
			|| selectedSelector.value !== targetSelector
		) return;
		applyCollection(next, false);
		pendingCollection = undefined;
		const items = getCapabilities(next);
		selectedSelector.value = items[0]?.selector ?? "";
		actionStatus.value = t("capabilities.deleted", { id: targetId });
		editorMode.value = undefined;
		isEditorDirty.value = false;
	} catch (error) {
		if (isUnmounted || opId !== mutationId || reqId !== requestId) return;
		if (error instanceof EditorApiError && error.status === 409) {
			actionError.value = error.message || t("capabilities.stale409");
		} else {
			actionError.value = error instanceof Error ? error.message : String(error);
		}
	} finally {
		if (!isUnmounted && opId === mutationId) actionBusy.value = false;
	}
}

function capabilityDiagnosticsBadge(entry: CapabilityEntry): string {
	const diags = entry.diagnostics || [];
	const errors = diags.filter((d) => d.level === "error").length;
	const warnings = diags.filter((d) => d.level === "warning").length;
	if (errors > 0) return tp("diag.errorOne", "diag.errorMany", errors);
	if (warnings > 0) return tp("diag.warningOne", "diag.warningMany", warnings);
	return "";
}
</script>

<template>
	<section class="capability-surface">
		<header class="capability-toolbar">
			<div>
				<div class="capability-heading">{{ t("capabilities.heading") }}</div>
				<div class="capability-subheading">{{ t("capabilities.subheading") }}</div>
			</div>
			<span class="action-spacer"></span>
			<span id="capabilitiesStatus" class="status" data-capabilities-status>
				{{ loading || actionBusy ? t("capabilities.working") : actionError || loadError || actionStatus || t("capabilities.count", { count: getCapabilities(collection).length }) }}
			</span>
		</header>

		<div v-if="loadError" class="capability-message error">{{ loadError }}</div>
		<div v-else-if="collection && !collection.trusted" class="capability-message warning">
			{{ t("capabilities.untrustedWarning") }}
		</div>

		<div v-if="collection" class="capability-layout">
			<aside class="capability-sidebar">
				<div class="capability-list-head">
					<strong>{{ t("capabilities.heading") }}</strong>
					<button id="capabilityRefreshBtn" class="icon" :title="t('capabilities.refresh')" :aria-label="t('capabilities.refresh')" data-icon="↻" type="button" :disabled="loading || actionBusy" @click="loadCapabilities(true)">
						{{ t("capabilities.refresh") }}
					</button>
				</div>
				<div class="capability-list" role="list" :aria-label="t('capabilities.listAria')">
					<button
						v-for="entry in getCapabilities(collection)"
						:key="entry.selector"
						type="button"
						class="capability-row"
						:class="{ selected: selected?.selector === entry.selector && !editorMode }"
						:disabled="actionBusy"
						data-capability-row

						:data-capability-id="getCapability(entry)?.id"
						:data-capability-selector="entry.selector"
						@click="selectCapability(entry)"
					>
						<span class="capability-row-title">
							{{ getCapability(entry)?.name || getCapability(entry)?.id }}
							<span class="badge scope" :class="entry.scope">
								{{ entry.scope === "global" ? t("chrome.scopeGlobal") : t("chrome.scopeProject") }}
							</span>
							<span v-if="capabilityDiagnosticsBadge(entry)" class="badge error">
								{{ capabilityDiagnosticsBadge(entry) }}
							</span>
						</span>
						<span class="capability-row-meta">{{ entry.selector }}</span>
					</button>
					<div v-if="getCapabilities(collection).length === 0" class="capability-empty-note">
						{{ t("capabilities.empty") }}
					</div>
					<button
						id="capabilityNewBtn"
						class="resource-add-row"
						data-icon="+"
						type="button"
						:disabled="loading || actionBusy || !!editorMode || collection.trusted === false"
						@click="startCreate"
					>
						{{ t("capabilities.newCapability") }}
					</button>
				</div>
			</aside>

			<main class="capability-content-area">
				<CapabilityEditor
					v-if="editorMode"
					:mode="editorMode"
					:source-entry="editorMode === 'create' ? undefined : selected"
					:mutation-busy="actionBusy"
					@cancel="handleEditorCancel"
					@saved="handleEditorSaved"
					@dirty-change="(isDirty) => { isEditorDirty = isDirty; }"
				/>
				<div v-else-if="selected" class="capability-detail-card">
					<header class="capability-detail-head">
						<div>
							<div class="capability-detail-title">
								{{ getCapability(selected)?.name || getCapability(selected)?.id }}
								<span class="badge scope" :class="selected.scope">
									{{ selected.scope === "global" ? t("chrome.scopeGlobal") : t("chrome.scopeProject") }}
								</span>
							</div>
							<div class="capability-detail-selector"><code>{{ selected.selector }}</code></div>
							<div class="capability-save-note">{{ t("capabilities.saveNeverActivates") }}</div>
						</div>
						<span class="action-spacer"></span>
						<button id="capabilityEditBtn" type="button" :disabled="actionBusy" @click="startEdit">
							{{ t("capabilities.edit") }}
						</button>
						<button id="capabilityDeleteBtn" class="danger" type="button" :disabled="actionBusy" @click="deleteSelected">
							{{ t("capabilities.delete") }}
						</button>
					</header>

					<div class="capability-detail-body">
						<div v-if="getCapability(selected)?.description" class="capability-section">
							<div class="capability-section-label">{{ t("capabilities.editorDescription") }}</div>
							<div class="capability-section-text">{{ getCapability(selected)?.description }}</div>
						</div>

						<div class="capability-section">
							<div class="capability-section-label">{{ t("capabilities.toolsHeader") }}</div>
							<div class="capability-tools-preview">
								<div v-if="(getCapability(selected)?.tools.add.length ?? 0) > 0">
									<strong>{{ t("capabilities.toolsAdd") }}:</strong>
									<span class="tool-list">{{ getCapability(selected)?.tools.add.join(", ") }}</span>
								</div>
								<div v-if="(getCapability(selected)?.tools.remove.length ?? 0) > 0">
									<strong>{{ t("capabilities.toolsRemove") }}:</strong>
									<span class="tool-list">{{ getCapability(selected)?.tools.remove.join(", ") }}</span>
								</div>
								<div v-if="(getCapability(selected)?.tools.add.length ?? 0) === 0 && (getCapability(selected)?.tools.remove.length ?? 0) === 0" class="capability-muted">
									{{ t("capabilities.noTools") }}
								</div>
							</div>
						</div>

						<div class="capability-section">
							<div class="capability-section-label">{{ t("capabilities.contentHeader") }}</div>
							<pre v-if="getCapability(selected)?.content" class="capability-content-pre">{{ getCapability(selected)?.content }}</pre>
							<div v-else class="capability-muted">{{ t("capabilities.noContent") }}</div>
						</div>

						<div class="capability-meta-grid">
							<div>
								<span class="capability-meta-label">{{ t("capabilities.filePath") }}:</span>
								<span class="capability-meta-val">{{ selected.filePath }}</span>
							</div>
							<div v-if="selected.sourceRevision">
								<span class="capability-meta-label">{{ t("capabilities.sourceRevision") }}:</span>
								<span class="capability-meta-val">{{ selected.sourceRevision }}</span>
							</div>
						</div>
					</div>
				</div>
				<div v-else class="capability-empty-detail">
					{{ t("capabilities.empty") }}
				</div>
			</main>
		</div>
	</section>
</template>

<style scoped>
.capability-surface {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	background: var(--bg);
}

.capability-toolbar select,
.capability-toolbar select { width: auto; min-width: 110px; flex: none; }
.capability-toolbar button,
.capability-toolbar button { flex: none; white-space: nowrap; }
.capability-toolbar {
	min-height: 48px;
	padding: 8px 16px;
	border-bottom: 1px solid var(--line);
	background: var(--pane);
	display: flex;
	align-items: center;
	gap: 10px;
}

.capability-heading {
	font-size: 15px;
	font-weight: 600;
}

.capability-subheading {
	color: var(--muted);
	font-size: 12px;
}

.action-spacer {
	flex: 1;
}

.capability-message {
	padding: 10px 16px;
	font-size: 13px;
}

.capability-message.error,
.capability-message.error {
	background: rgba(220, 50, 50, 0.1);
	color: var(--error);
	border-bottom: 1px solid var(--line);
}

.capability-message.warning,
.capability-message.warning {
	background: rgba(255, 193, 7, 0.15);
	border-bottom: 1px solid var(--line);
}

.capability-layout {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: minmax(212px, 260px) minmax(0, 1fr);
}

.capability-sidebar {
	min-width: 0;
	border-right: 1px solid var(--line);
	background: var(--pane);
	display: flex;
	flex-direction: column;
}

.capability-list-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 10px 12px;
	border-bottom: 1px solid var(--line);
}

.capability-list {
	flex: 1;
	overflow-y: auto;
	padding: 6px;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.capability-row {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	width: 100%;
	padding: 8px 10px;
	border: 1px solid transparent;
	border-radius: var(--radius);
	background: transparent;
	color: inherit;
	cursor: pointer;
	text-align: left;
	font-size: 13px;
}

.capability-row:hover,
.capability-row:hover {
	background: var(--hover);
}

.capability-row.selected,
.capability-row.selected {
	background: var(--active-bg);
	border-color: var(--accent);
}

.capability-row-title {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	font-weight: 500;
}

.badge {
	font-size: 11px;
	padding: 1px 5px;
	border-radius: 3px;
	text-transform: lowercase;
}

.badge.scope.global {
	background: rgba(100, 180, 255, 0.15);
	color: #3b82f6;
}

.badge.scope.project {
	background: rgba(34, 197, 94, 0.15);
	color: #16a34a;
}

.badge.error {
	background: rgba(220, 50, 50, 0.15);
	color: var(--error);
	margin-left: auto;
}

.capability-row-meta {
	font-size: 11px;
	color: var(--muted);
	margin-top: 2px;
	font-family: monospace;
}

.capability-empty-note {
	padding: 16px 10px;
	text-align: center;
	color: var(--muted);
	font-size: 12px;
}

.resource-add-row {
	margin-top: auto;
	width: 100%;
	padding: 8px;
	border: 1px dashed var(--line);
	border-radius: var(--radius);
	background: transparent;
	color: var(--accent);
	cursor: pointer;
	font-size: 13px;
}

.resource-add-row:hover:not(:disabled) {
	background: var(--hover);
	border-color: var(--accent);
}

.capability-content-area {
	flex: 1;
	min-width: 0;
	overflow-y: auto;
	padding: 16px;
}

.capability-detail-card {
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: var(--radius);
	display: flex;
	flex-direction: column;
}

.capability-detail-head {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 14px 16px;
	border-bottom: 1px solid var(--line);
}

.capability-detail-title {
	font-size: 16px;
	font-weight: 600;
	display: flex;
	align-items: center;
	gap: 8px;
}

.capability-detail-selector {
	margin-top: 4px;
	font-size: 12px;
}

.capability-save-note {
	margin-top: 4px;
	font-size: 11px;
	color: var(--muted);
}

.capability-detail-body {
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.capability-section {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.capability-section-label {
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	color: var(--muted);
	letter-spacing: 0.5px;
}

.capability-section-text {
	font-size: 13px;
	line-height: 1.5;
}

.capability-tools-preview {
	font-size: 13px;
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.tool-list {
	font-family: monospace;
	font-size: 12px;
	margin-left: 6px;
}

.capability-content-pre {
	font-family: inherit;
	white-space: pre-wrap;
	word-break: break-word;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: var(--radius);
	padding: 10px 12px;
	margin: 0;
	font-size: 13px;
	line-height: 1.5;
}

.capability-muted {
	color: var(--muted);
	font-size: 12px;
	font-style: italic;
}

.capability-meta-grid {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding-top: 8px;
	border-top: 1px solid var(--line);
	font-size: 11px;
	color: var(--muted);
}

.capability-meta-label {
	font-weight: 500;
	margin-right: 6px;
}

.capability-meta-val {
	font-family: monospace;
}

.capability-empty-detail {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 200px;
	color: var(--muted);
	font-size: 13px;
}
</style>
