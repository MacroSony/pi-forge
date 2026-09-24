<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { createEditorApi, EditorApiError } from "../api.ts";
import { t } from "../i18n.ts";
import type { InstructionMode, InstructionModeEntry, WebEditorPolicyResource, WebEditorResources } from "../types.ts";
import ToolPicker from "./ToolPicker.vue";

const props = defineProps<{
	mode: "create" | "edit";
	sourceEntry?: InstructionModeEntry;
}>();

const emit = defineEmits<{
	cancel: [];
	saved: [selector: string, id: string];
	dirtyChange: [isDirty: boolean];
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

const initialScope: "project" | "global" = props.mode === "edit"
	? (props.sourceEntry?.scope ?? "project")
	: "project";

// Capture the edit target once. The browser may refresh its collection while
// this component is dirty; a new prop object must not change the PUT target or
// its optimistic-concurrency revision underneath the draft.
const editTarget = {
	selector: props.sourceEntry?.selector ?? "",
	sourceRevision: props.sourceEntry?.sourceRevision,
};
const editSource = props.mode === "edit" ? props.sourceEntry?.mode : undefined;

const initial = editSource
	? editSource
	: {
		schemaVersion: 1,
		type: "pi-forge.instruction-mode",
		id: "",
		name: "",
		description: "",
		content: "",
		tools: { add: [], remove: [] },
	};

const draft = reactive({
	id: initial.id,
	scope: initialScope,
	name: initial.name ?? "",
	description: initial.description ?? "",
	content: initial.content ?? "",
	toolsAdd: [...(initial.tools?.add ?? [])],
	toolsRemove: [...(initial.tools?.remove ?? [])],
});

const error = ref("");
const busy = ref(false);
const catalogTools = ref<WebEditorPolicyResource[]>([]);
const catalogLoading = ref(false);
const catalogError = ref("");
let isUnmounted = false;
let requestId = 0;
let catalogRequestId = 0;

async function loadCatalog(): Promise<void> {
	const reqId = ++catalogRequestId;
	catalogLoading.value = true;
	catalogError.value = "";
	try {
		const res = await api<WebEditorResources>("/api/resources");
		if (isUnmounted || reqId !== catalogRequestId) return;
		catalogTools.value = res?.tools || [];
	} catch (err) {
		if (isUnmounted || reqId !== catalogRequestId) return;
		catalogError.value = err instanceof Error ? err.message : String(err);
	} finally {
		if (reqId === catalogRequestId && !isUnmounted) {
			catalogLoading.value = false;
		}
	}
}

function snapshot(): string {
	return JSON.stringify({
		id: draft.id.trim(),
		scope: draft.scope,
		name: draft.name.trim(),
		description: draft.description.trim(),
		content: draft.content,
		toolsAdd: draft.toolsAdd,
		toolsRemove: draft.toolsRemove,
	});
}

const initialSnapshot = snapshot();
const dirty = computed(() => snapshot() !== initialSnapshot);

watch(dirty, (isDirty) => {
	emit("dirtyChange", isDirty);
});

function handleBeforeUnload(event: BeforeUnloadEvent): void {
	if (!dirty.value) return;
	event.preventDefault();
	event.returnValue = "";
}

onMounted(() => {
	window.addEventListener("beforeunload", handleBeforeUnload);
	loadCatalog();
});
onBeforeUnmount(() => {
	isUnmounted = true;
	window.removeEventListener("beforeunload", handleBeforeUnload);
});

function requestCancel(): void {
	if (dirty.value && !window.confirm(t("modes.confirmDiscard"))) return;
	emit("cancel");
}

function removeTool(kind: "add" | "remove", index: number): void {
	const targetList = kind === "add" ? draft.toolsAdd : draft.toolsRemove;
	targetList.splice(index, 1);
}

function modeFromDraft(): InstructionMode {
	const original = editSource;
	return {
		...original,
		schemaVersion: 1,
		type: "pi-forge.instruction-mode",
		id: draft.id.trim(),
		name: draft.name.trim() || undefined,
		description: draft.description.trim() || undefined,
		content: draft.content,
		tools: {
			...(original?.tools || {}),
			add: [...draft.toolsAdd],
			remove: [...draft.toolsRemove],
		},
	};
}

async function saveDraft(): Promise<void> {
	error.value = "";
	const trimmedId = draft.id.trim();
	if (!trimmedId) {
		error.value = t("modes.validationError", { message: "ID is required." });
		return;
	}
	if (!draft.content.trim() && draft.toolsAdd.length === 0 && draft.toolsRemove.length === 0) {
		error.value = t("modes.validationError", { message: "Mode must provide instruction content or tool modifications." });
		return;
	}

	const reqId = ++requestId;
	busy.value = true;
	try {
		const mode = modeFromDraft();
		const selector = props.mode === "create"
			? `${draft.scope}:${mode.id}`
			: editTarget.selector;
		if (props.mode === "edit" && !selector) {
			error.value = t("modes.validationError", { message: "The selected mode is no longer available." });
			return;
		}

		if (props.mode === "create") {
			await api("/api/instruction-modes", {
				method: "POST",
				body: { scope: draft.scope, mode },
			});
		} else {
			await api(`/api/instruction-modes/${encodeURIComponent(selector)}`, {
				method: "PUT",
				body: {
					mode,
					expectedSourceRevision: editTarget.sourceRevision,
				},
			});
		}

		if (reqId !== requestId || isUnmounted) return;
		emit("saved", selector, mode.id);
	} catch (caught) {
		if (reqId !== requestId || isUnmounted) return;
		if (caught instanceof EditorApiError && caught.status === 409) {
			// KEEP DRAFT on 409 stale conflict
			error.value = caught.message || t("modes.stale409");
		} else {
			error.value = caught instanceof Error ? caught.message : String(caught);
		}
	} finally {
		if (reqId === requestId && !isUnmounted) {
			busy.value = false;
		}
	}
}
</script>

<template>
	<section class="mode-editor">
		<header class="mode-editor-head">
			<div>
				<div class="mode-editor-title">
					{{ mode === "create" ? t("modes.editorTitleNew") : (draft.name || draft.id || editTarget.selector) }}
				</div>
				<div v-if="mode === 'edit'" class="mode-editor-selector">
					<code>{{ editTarget.selector }}</code>
				</div>
				<div class="mode-save-note">
					{{ t("modes.saveNeverActivates") }}
				</div>
			</div>
			<span class="action-spacer"></span>
			<span v-if="dirty" class="mode-dirty-badge">{{ t("chrome.unsaved") }}</span>
			<button id="modeCancelBtn" type="button" :disabled="busy" @click="requestCancel">
				{{ t("modes.cancel") }}
			</button>
			<button id="modeSaveBtn" class="primary" data-icon="✓" type="button" :disabled="busy" @click="saveDraft">
				{{ t("modes.save") }}
			</button>
		</header>

		<div v-if="error" class="mode-message error">{{ error }}</div>

		<div class="mode-form">
			<label class="mode-field">
				<span>{{ t("modes.editorName") }}</span>
				<input
					id="modeName"
					v-model="draft.name"
					:placeholder="t('modes.editorNamePlaceholder')"
					autocomplete="off"
				>
			</label>

			<div v-if="mode === 'create'" class="mode-form-row">
				<label class="mode-field">
					<span>{{ t("modes.editorId") }}</span>
					<input
						id="modeId"
						v-model="draft.id"
						:placeholder="t('modes.editorIdPlaceholder')"
						autocomplete="off"
					>
				</label>
				<label class="mode-field">
					<span>{{ t("polish.surfaces.modeScope") }}</span>
					<select id="modeScope" v-model="draft.scope" :aria-label="t('polish.surfaces.modeScopeAria')">
						<option value="project">{{ t("modes.scopeProject") }}</option>
						<option value="global">{{ t("modes.scopeGlobal") }}</option>
					</select>
				</label>
			</div>

			<label class="mode-field">
				<span>{{ t("modes.editorDescription") }}</span>
				<input
					id="modeDescription"
					v-model="draft.description"
					:placeholder="t('modes.editorDescriptionPlaceholder')"
					autocomplete="off"
				>
			</label>

			<label class="mode-field">
				<span>{{ t("modes.editorContent") }}</span>
				<textarea
					id="modeContent"
					v-model="draft.content"
					rows="8"
					:placeholder="t('modes.editorContentPlaceholder')"
				></textarea>
			</label>

			<div class="mode-tools-grid">
				<div class="mode-tools-col">
					<div class="mode-tools-header-row">
						<span class="mode-tools-label">{{ t("modes.toolsAdd") }}</span>
						<ToolPicker
							data-mode-tools-add-picker
							:button-label="t('modes.chooseAddTools')"
							:resources="catalogTools"
							:loading="catalogLoading"
							:error="catalogError"
							can-refresh
							@refresh="loadCatalog"
							v-model="draft.toolsAdd"
						/>
					</div>
					<div class="mode-tag-list">
						<span
							v-for="(tool, index) in draft.toolsAdd"
							:key="tool"
							class="mode-tag add"
						>
							{{ tool }}
							<button type="button" class="mode-tag-remove" :title="t('modes.delete')" @click="removeTool('add', index)">×</button>
						</span>
					</div>
				</div>

				<div class="mode-tools-col">
					<div class="mode-tools-header-row">
						<span class="mode-tools-label">{{ t("modes.toolsRemove") }}</span>
						<ToolPicker
							data-mode-tools-remove-picker
							:button-label="t('modes.chooseRemoveTools')"
							:resources="catalogTools"
							:loading="catalogLoading"
							:error="catalogError"
							can-refresh
							@refresh="loadCatalog"
							v-model="draft.toolsRemove"
						/>
					</div>
					<div class="mode-tag-list">
						<span
							v-for="(tool, index) in draft.toolsRemove"
							:key="tool"
							class="mode-tag remove"
						>
							{{ tool }}
							<button type="button" class="mode-tag-remove" :title="t('modes.delete')" @click="removeTool('remove', index)">×</button>
						</span>
					</div>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
.mode-editor {
	display: flex;
	flex-direction: column;
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: 6px;
	margin: 12px;
	overflow: hidden;
}

.mode-editor-head {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 10px 16px;
	border-bottom: 1px solid var(--line);
	background: var(--pane-soft);
}

.mode-editor-title {
	font-weight: 600;
	font-size: 15px;
}

.mode-editor-selector {
	margin-top: 2px;
}

.mode-editor-selector code {
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	font-size: 11px;
	color: var(--muted);
	background: var(--code, rgba(0, 0, 0, 0.04));
	padding: 1px 4px;
	border-radius: 3px;
}

.mode-save-note {
	font-size: 12px;
	color: var(--muted);
	margin-top: 2px;
}

.mode-dirty-badge {
	font-size: 11px;
	color: var(--accent);
	background: var(--accent-bg);
	padding: 2px 6px;
	border-radius: 4px;
	font-weight: 600;
}

.mode-message {
	padding: 8px 16px;
	font-size: 13px;
}

.mode-message.error {
	background: rgba(220, 50, 50, 0.1);
	color: var(--error);
	border-bottom: 1px solid var(--line);
}

.mode-form {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 16px;
	overflow-y: auto;
}

.mode-form-row {
	display: grid;
	grid-template-columns: 2fr 1fr;
	gap: 12px;
}

.mode-field {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.mode-field span {
	font-size: 12px;
	font-weight: 600;
	color: var(--muted);
}

.mode-scope-note {
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	font-size: 11px;
	color: var(--muted);
	overflow-wrap: anywhere;
}

.mode-field input,
.mode-field select,
.mode-field textarea {
	padding: 6px 8px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--bg);
	color: var(--fg);
	font-family: inherit;
	font-size:14px; min-height:34px;
}

.mode-field textarea {
	font-family: monospace;
	resize: vertical;
}

.mode-tools-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit,minmax(min(260px,100%),1fr));
	gap: 16px;
	border-top: 1px solid var(--line);
	padding-top: 12px;
}

.mode-tools-col {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.mode-tools-header-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-bottom: 6px;
}

.mode-tools-label {
	font-size: 12px;
	font-weight: 600;
	color: var(--muted);
}

.mode-tag-list {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	min-height: 28px;
}

.mode-tag {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 6px;
	border-radius: 4px;
	font-size: 12px;
	font-family: monospace;
	border: 1px solid var(--line);
	background: var(--pane-soft);
}

.mode-tag.add {
	border-color: rgba(40, 167, 69, 0.4);
	color: #28a745;
}

.mode-tag.remove {
	border-color: rgba(220, 53, 69, 0.4);
	color: #dc3545;
}

.mode-tag-remove {
	border: none;
	background: transparent;
	color: inherit;
	cursor: pointer;
	padding: 0 2px;
	font-size: 14px;
	line-height: 1;
}

.action-spacer {
	flex: 1;
}
</style>
