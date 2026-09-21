<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { createEditorApi, EditorApiError } from "../api.ts";
import { t, tp } from "../i18n.ts";
import type { InstructionModeCollection, InstructionModeEntry } from "../types.ts";
import InstructionModeEditor from "./InstructionModeEditor.vue";

const props = defineProps<{
	active: boolean;
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

const collection = ref<InstructionModeCollection>();
const selectedSelector = ref("");
const loadError = ref("");
const loading = ref(false);
const editorMode = ref<"create" | "edit">();
const createScope = ref<"project" | "global">("project");
const actionStatus = ref("");
const actionError = ref("");
const actionBusy = ref(false);
const isEditorDirty = ref(false);

let isUnmounted = false;
let requestId = 0;

onBeforeUnmount(() => {
	isUnmounted = true;
});

const selected = computed<InstructionModeEntry | undefined>(() => {
	const modes = collection.value?.modes || [];
	return modes.find((entry) => entry.selector === selectedSelector.value);
});

// A refresh can finish after the user has changed views. Keep it out of the
// reactive collection while an editor is dirty, and never let an old request
// choose a new selection.
let interactionVersion = 0;
let editorSession = 0;
let mutationId = 0;
let pendingCollection: { value: InstructionModeCollection; interactionVersion: number } | undefined;

function applyCollection(next: InstructionModeCollection, chooseFallback: boolean): void {
	collection.value = next;
	if (chooseFallback && !next.modes.some((entry) => entry.selector === selectedSelector.value)) {
		selectedSelector.value = next.modes[0]?.selector ?? "";
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
		if (active) void loadModes();
	},
	{ immediate: true },
);

async function loadModes(fromUserClick = false): Promise<void> {
	// A mutation's follow-up GET owns collection sequencing until it finishes.
	if (actionBusy.value) return;
	const reqId = ++requestId;
	const startedInteraction = interactionVersion;
	const startedEditorSession = editorSession;
	loading.value = true;
	loadError.value = "";
	if (!fromUserClick) actionError.value = "";
	try {
		const next = await api<InstructionModeCollection>("/api/instruction-modes");
		if (reqId !== requestId || isUnmounted) return;
		const sameView = startedInteraction === interactionVersion && startedEditorSession === editorSession;
		if (isEditorDirty.value) {
			// In particular, activation surface toggles must not replace the
			// source entry underneath an unsaved editor. Also discard a response
			// that began before the user changed the editor/selection.
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

function selectMode(entry: InstructionModeEntry): void {
	if (entry.selector === selected.value?.selector && !editorMode.value) return;
	if (isEditorDirty.value && !window.confirm(t("modes.confirmDiscard"))) return;
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
	if (isEditorDirty.value && !window.confirm(t("modes.confirmDiscard"))) return;
	interactionVersion++;
	editorSession++;
	editorMode.value = "create";
	isEditorDirty.value = false;
	actionStatus.value = "";
	actionError.value = "";
}

function startEdit(): void {
	if (isEditorDirty.value && !window.confirm(t("modes.confirmDiscard"))) return;
	interactionVersion++;
	editorSession++;
	editorMode.value = "edit";
	isEditorDirty.value = false;
	actionStatus.value = "";
	actionError.value = "";
}

function handleEditorCancel(): void {
	mutationId++;
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
	// A mutation refresh supersedes ordinary loads, including an activation
	// refresh that happened to start before the write completed.
	const reqId = ++requestId;
	loading.value = false;
	actionBusy.value = true;
	try {
		// After write, do not assume response body: explicit GET collection.
		const next = await api<InstructionModeCollection>("/api/instruction-modes");
		if (
			isUnmounted || opId !== mutationId || reqId !== requestId
			|| session !== editorSession || view !== interactionVersion
		) return;
		applyCollection(next, false);
		pendingCollection = undefined;
		selectedSelector.value = savedSelector;
		actionStatus.value = t(wasCreate ? "modes.created" : "modes.saved", { id: savedId });
		editorMode.value = undefined;
		isEditorDirty.value = false;
		editorSession++;
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
	if (!window.confirm(t("modes.confirmDelete", { id: target.mode.id }))) return;

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
		await api(`/api/instruction-modes/${encodeURIComponent(targetSelector)}`, {
			method: "DELETE",
			body: { expectedSourceRevision: target.sourceRevision },
		});
		// After success: explicit GET collection; never use a mutation response
		// as the new collection.
		const next = await api<InstructionModeCollection>("/api/instruction-modes");
		if (
			isUnmounted || opId !== mutationId || reqId !== requestId
			|| session !== editorSession || view !== interactionVersion
			|| selectedSelector.value !== targetSelector
		) return;
		applyCollection(next, false);
		pendingCollection = undefined;
		selectedSelector.value = next.modes[0]?.selector ?? "";
		actionStatus.value = t("modes.deleted", { id: target.mode.id });
		editorMode.value = undefined;
		isEditorDirty.value = false;
	} catch (error) {
		if (isUnmounted || opId !== mutationId || reqId !== requestId) return;
		if (error instanceof EditorApiError && error.status === 409) {
			actionError.value = error.message || t("modes.stale409");
		} else {
			actionError.value = error instanceof Error ? error.message : String(error);
		}
	} finally {
		if (!isUnmounted && opId === mutationId) actionBusy.value = false;
	}
}

function modeDiagnosticsBadge(entry: InstructionModeEntry): string {
	const diags = entry.diagnostics || [];
	const errors = diags.filter((d) => d.level === "error").length;
	const warnings = diags.filter((d) => d.level === "warning").length;
	if (errors > 0) return tp("diag.errorOne", "diag.errorMany", errors);
	if (warnings > 0) return tp("diag.warningOne", "diag.warningMany", warnings);
	return "";
}
</script>

<template>
	<section class="mode-surface">
		<header class="mode-toolbar">
			<div>
				<div class="mode-heading">{{ t("modes.heading") }}</div>
				<div class="mode-subheading">{{ t("modes.subheading") }}</div>
			</div>
			<span class="action-spacer"></span>
			<span id="modesStatus" class="status">
				{{ loading || actionBusy ? t("modes.working") : actionError || loadError || actionStatus || t("modes.count", { count: collection?.modes.length || 0 }) }}
			</span>
			<select
				id="modeCreateScope"
				v-model="createScope"
				:title="t('modes.scopeTitle')"
				:disabled="loading || actionBusy || !!editorMode"
			>
				<option value="project">{{ t("modes.scopeProject") }}</option>
				<option value="global">{{ t("modes.scopeGlobal") }}</option>
			</select>
			<button
				id="modeNewBtn"
				data-icon="+"
				type="button"
				:disabled="loading || actionBusy || !!editorMode || collection?.trusted === false"
				@click="startCreate"
			>
				{{ t("modes.newMode") }}
			</button>
			<button
				id="modeRefreshBtn"
				data-icon="↻"
				type="button"
				:disabled="loading || actionBusy"
				@click="loadModes(true)"
			>
				{{ t("modes.refresh") }}
			</button>
		</header>

		<div v-if="loadError" class="mode-message error">{{ loadError }}</div>
		<div v-else-if="collection && !collection.trusted" class="mode-message warning">
			{{ t("modes.untrustedWarning") }}
		</div>

		<div v-if="collection" class="mode-layout">
			<aside class="mode-sidebar">
				<div class="mode-list" role="list" :aria-label="t('modes.listAria')">
					<button
						v-for="entry in collection.modes"
						:key="entry.selector"
						type="button"
						class="mode-row"
						:class="{ selected: selected?.selector === entry.selector && !editorMode }"
						:disabled="actionBusy"
						data-mode-row
						:data-mode-id="entry.mode.id"
						:data-mode-selector="entry.selector"
						@click="selectMode(entry)"
					>
						<span class="mode-row-title">
							{{ entry.mode.name || entry.mode.id }}
							<span class="badge scope" :class="entry.scope">
								{{ entry.scope === "global" ? t("chrome.scopeGlobal") : t("chrome.scopeProject") }}
							</span>
							<span v-if="modeDiagnosticsBadge(entry)" class="badge error">
								{{ modeDiagnosticsBadge(entry) }}
							</span>
						</span>
						<span class="mode-row-meta">{{ entry.selector }}</span>
					</button>
					<div v-if="collection.modes.length === 0" class="mode-empty-note">
						{{ t("modes.empty") }}
					</div>
				</div>
			</aside>

			<main class="mode-content-area">
				<InstructionModeEditor
					v-if="editorMode"
					:mode="editorMode"
					:source-entry="editorMode === 'create' ? undefined : selected"
					:create-scope="createScope"
					@cancel="handleEditorCancel"
					@saved="handleEditorSaved"
					@dirty-change="(isDirty) => { isEditorDirty = isDirty; }"
				/>
				<div v-else-if="selected" class="mode-detail-card">
					<header class="mode-detail-head">
						<div>
							<div class="mode-detail-title">
								{{ selected.mode.name || selected.mode.id }}
								<span class="badge scope" :class="selected.scope">
									{{ selected.scope === "global" ? t("chrome.scopeGlobal") : t("chrome.scopeProject") }}
								</span>
							</div>
							<div class="mode-detail-selector">{{ selected.selector }}</div>
							<div class="mode-save-note">{{ t("modes.saveNeverActivates") }}</div>
						</div>
						<span class="action-spacer"></span>
						<button id="modeEditBtn" type="button" :disabled="actionBusy" @click="startEdit">
							{{ t("modes.edit") }}
						</button>
						<button id="modeDeleteBtn" class="danger" type="button" :disabled="actionBusy" @click="deleteSelected">
							{{ t("modes.delete") }}
						</button>
					</header>

					<div class="mode-detail-body">
						<div v-if="selected.mode.description" class="mode-section">
							<div class="mode-section-label">{{ t("modes.editorDescription") }}</div>
							<div class="mode-section-text">{{ selected.mode.description }}</div>
						</div>

						<div class="mode-section">
							<div class="mode-section-label">{{ t("modes.toolsHeader") }}</div>
							<div class="mode-tools-preview">
								<div v-if="selected.mode.tools.add.length > 0">
									<strong>{{ t("modes.toolsAdd") }}:</strong>
									<span class="tool-list">{{ selected.mode.tools.add.join(", ") }}</span>
								</div>
								<div v-if="selected.mode.tools.remove.length > 0">
									<strong>{{ t("modes.toolsRemove") }}:</strong>
									<span class="tool-list">{{ selected.mode.tools.remove.join(", ") }}</span>
								</div>
								<div v-if="selected.mode.tools.add.length === 0 && selected.mode.tools.remove.length === 0" class="mode-muted">
									{{ t("modes.noTools") }}
								</div>
							</div>
						</div>

						<div class="mode-section">
							<div class="mode-section-label">{{ t("modes.contentHeader") }}</div>
							<pre v-if="selected.mode.content" class="mode-content-pre">{{ selected.mode.content }}</pre>
							<div v-else class="mode-muted">{{ t("modes.noContent") }}</div>
						</div>

						<div class="mode-meta-grid">
							<div>
								<span class="mode-meta-label">{{ t("modes.filePath") }}:</span>
								<span class="mode-meta-val">{{ selected.filePath }}</span>
							</div>
							<div v-if="selected.sourceRevision">
								<span class="mode-meta-label">{{ t("modes.sourceRevision") }}:</span>
								<span class="mode-meta-val">{{ selected.sourceRevision }}</span>
							</div>
						</div>
					</div>
				</div>
				<div v-else class="mode-empty-detail">
					{{ t("modes.empty") }}
				</div>
			</main>
		</div>
	</section>
</template>

<style scoped>
.mode-surface {
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	background: var(--bg);
}

.mode-toolbar {
	min-height: 64px;
	padding: 10px 12px;
	border-bottom: 1px solid var(--line);
	background: var(--pane);
	display: flex;
	align-items: center;
	gap: 10px;
}

.mode-heading {
	font-size: 17px;
	font-weight: 700;
}

.mode-subheading {
	color: var(--muted);
	font-size: 12px;
}

.action-spacer {
	flex: 1;
}

.mode-message {
	padding: 10px 16px;
	font-size: 13px;
}

.mode-message.error {
	background: rgba(220, 50, 50, 0.1);
	color: var(--error);
	border-bottom: 1px solid var(--line);
}

.mode-message.warning {
	background: rgba(255, 193, 7, 0.15);
	border-bottom: 1px solid var(--line);
}

.mode-layout {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: minmax(260px, 330px) minmax(0, 1fr);
}

.mode-sidebar {
	min-width: 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
	border-right: 1px solid var(--line);
	background: var(--pane);
}

.mode-list {
	flex: 1;
	min-height: 0;
	padding: 8px;
	overflow-y: auto;
}

.mode-row {
	width: 100%;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	padding: 8px 10px;
	margin-bottom: 4px;
	border: 1px solid transparent;
	border-radius: 4px;
	background: transparent;
	text-align: left;
	cursor: pointer;
}

.mode-row:hover {
	background: var(--pane-soft);
}

.mode-row.selected {
	background: var(--accent-bg);
	border-color: var(--accent);
}

.mode-row-title {
	font-weight: 600;
	font-size: 13px;
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
}

.mode-row-meta {
	font-size: 11px;
	color: var(--muted);
	margin-top: 2px;
}

.badge {
	font-size: 10px;
	padding: 1px 5px;
	border-radius: 3px;
	font-weight: normal;
}

.badge.scope.global {
	background: rgba(0, 120, 215, 0.15);
	color: #0078d7;
}

.badge.scope.project {
	background: rgba(40, 167, 69, 0.15);
	color: #28a745;
}

.badge.error {
	background: rgba(220, 53, 69, 0.15);
	color: var(--error);
}

.mode-empty-note {
	padding: 16px;
	color: var(--muted);
	font-size: 13px;
	text-align: center;
}

.mode-content-area {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
}

.mode-detail-card {
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: 6px;
	margin: 12px;
	overflow: hidden;
}

.mode-detail-head {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 14px 18px;
	border-bottom: 1px solid var(--line);
	background: var(--pane-soft);
}

.mode-detail-title {
	font-size: 16px;
	font-weight: 700;
	display: flex;
	align-items: center;
	gap: 8px;
}

.mode-detail-selector {
	font-size: 12px;
	color: var(--muted);
	margin-top: 2px;
}

.mode-save-note {
	font-size: 12px;
	color: var(--muted);
	margin-top: 4px;
}

.mode-detail-body {
	padding: 18px;
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.mode-section {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.mode-section-label {
	font-size: 12px;
	font-weight: 600;
	color: var(--muted);
}

.mode-section-text {
	font-size: 13px;
}

.mode-tools-preview {
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-size: 13px;
}

.tool-list {
	margin-left: 6px;
	font-family: monospace;
}

.mode-content-pre {
	margin: 0;
	padding: 10px 12px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 4px;
	font-family: monospace;
	font-size: 12px;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 350px;
	overflow-y: auto;
}

.mode-meta-grid {
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-size: 11px;
	color: var(--muted);
	border-top: 1px solid var(--line);
	padding-top: 10px;
}

.mode-meta-label {
	font-weight: 600;
	margin-right: 4px;
}

.mode-empty-detail {
	padding: 32px;
	text-align: center;
	color: var(--muted);
}
</style>
