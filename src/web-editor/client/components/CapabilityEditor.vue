<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { createEditorApi, EditorApiError } from "../api.ts";
import { t } from "../i18n.ts";
import type { Capability, CapabilityEntry, WebEditorPolicyResource, WebEditorResources } from "../types.ts";
import ToolPicker from "./ToolPicker.vue";

const props = defineProps<{
	mode: "create" | "edit";
	sourceEntry?: CapabilityEntry;
	mutationBusy?: boolean;
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

const editTarget = {
	selector: props.sourceEntry?.selector ?? "",
	sourceRevision: props.sourceEntry?.sourceRevision,
};
const editSource = props.mode === "edit" ? props.sourceEntry?.capability : undefined;
const persisted = ref(props.mode === "edit");

const initial = editSource
	? editSource
	: {
		schemaVersion: 1 as const,
		type: "pi-forge.capability" as const,
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

const savedSnapshot = ref(snapshot());
const dirty = computed(() => snapshot() !== savedSnapshot.value);

watch(dirty, (isDirty) => {
	emit("dirtyChange", isDirty);
}, { flush: "sync" });

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
	if (dirty.value && !window.confirm(t("capabilities.confirmDiscard"))) return;
	emit("cancel");
}

function removeTool(kind: "add" | "remove", index: number): void {
	const targetList = kind === "add" ? draft.toolsAdd : draft.toolsRemove;
	targetList.splice(index, 1);
}

function capabilityFromDraft(): Capability {
	const original = editSource;
	return {
		...original,
		schemaVersion: 1,
		type: "pi-forge.capability",
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
	if (busy.value || props.mutationBusy) return;
	error.value = "";
	const trimmedId = draft.id.trim();
	if (!trimmedId) {
		error.value = t("capabilities.validationError", { message: "ID is required." });
		return;
	}
	if (!draft.content.trim() && draft.toolsAdd.length === 0 && draft.toolsRemove.length === 0) {
		error.value = t("capabilities.validationError", { message: "Capability must provide instruction content or tool modifications." });
		return;
	}

	const reqId = ++requestId;
	const submittedSnapshot = snapshot();
	const submittedAsCreate = !persisted.value;
	busy.value = true;
	try {
		const cap = capabilityFromDraft();
		const selector = submittedAsCreate
			? `${draft.scope}:${cap.id}`
			: editTarget.selector;
		if (!submittedAsCreate && !selector) {
			error.value = t("capabilities.validationError", { message: "The selected capability is no longer available." });
			return;
		}

		let receipt: { sourceRevision?: string };
		if (submittedAsCreate) {
			receipt = await api("/api/capabilities", {
				method: "POST",
				body: { scope: draft.scope, capability: cap },
			});
		} else {
			receipt = await api(`/api/capabilities/${encodeURIComponent(selector)}`, {
				method: "PUT",
				body: {
					capability: cap,
					expectedSourceRevision: editTarget.sourceRevision,
				},
			});
		}

		if (reqId !== requestId || isUnmounted) return;
		if (typeof receipt?.sourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sourceRevision)) {
			throw new Error("Capability write did not return its source revision receipt.");
		}
		editTarget.selector = selector;
		editTarget.sourceRevision = receipt.sourceRevision;
		persisted.value = true;
		savedSnapshot.value = submittedSnapshot;
		emit("saved", selector, cap.id);
	} catch (caught) {
		if (reqId !== requestId || isUnmounted) return;
		if (caught instanceof EditorApiError && caught.status === 409) {
			error.value = caught.message || t("capabilities.stale409");
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
	<section class="capability-editor">
		<header class="capability-editor-head">
			<div>
				<div class="capability-editor-title">
					{{ mode === "create" ? t("capabilities.editorTitleNew") : (draft.name || draft.id || editTarget.selector) }}
				</div>
				<div v-if="mode === 'edit'" class="capability-editor-selector">
					<code>{{ editTarget.selector }}</code>
				</div>
				<div class="capability-save-note">
					{{ t("capabilities.saveNeverActivates") }}
				</div>
			</div>
			<span class="action-spacer"></span>
			<span v-if="dirty" class="capability-dirty-badge">{{ t("chrome.unsaved") }}</span>
			<button id="capabilityCancelBtn" type="button" :disabled="busy" @click="requestCancel">
				{{ t("capabilities.cancel") }}
			</button>
			<button id="capabilitySaveBtn" class="primary" data-icon="✓" type="button" :disabled="busy || mutationBusy" @click="saveDraft">
				{{ t("capabilities.save") }}
			</button>
		</header>

		<div v-if="error" class="capability-message error">{{ error }}</div>

		<div class="capability-form">
			<label class="capability-field">
				<span>{{ t("capabilities.editorName") }}</span>
				<input
					id="capabilityName"
					v-model="draft.name"
					:placeholder="t('capabilities.editorNamePlaceholder')"
					autocomplete="off"
				>
			</label>

			<div v-if="mode === 'create'" class="capability-form-row">
				<label class="capability-field">
					<span>{{ t("capabilities.editorId") }}</span>
					<input
						id="capabilityId"
						v-model="draft.id"
						:placeholder="t('capabilities.editorIdPlaceholder')"
						autocomplete="off"
						:disabled="busy || mutationBusy || persisted"
					>
				</label>
				<label class="capability-field">
					<span>{{ t("polish.surfaces.capabilityScope") }}</span>
					<select id="capabilityScope" v-model="draft.scope" :aria-label="t('polish.surfaces.capabilityScopeAria')" :disabled="busy || mutationBusy || persisted">
						<option value="project">{{ t("capabilities.scopeProject") }}</option>
						<option value="global">{{ t("capabilities.scopeGlobal") }}</option>
					</select>
				</label>
			</div>

			<label class="capability-field">
				<span>{{ t("capabilities.editorDescription") }}</span>
				<input
					id="capabilityDescription"
					v-model="draft.description"
					:placeholder="t('capabilities.editorDescriptionPlaceholder')"
					autocomplete="off"
				>
			</label>

			<label class="capability-field">
				<span>{{ t("capabilities.editorContent") }}</span>
				<textarea
					id="capabilityContent"
					v-model="draft.content"
					rows="8"
					:placeholder="t('capabilities.editorContentPlaceholder')"
				></textarea>
			</label>

			<div class="capability-tools-grid">
				<div class="capability-tools-col">
					<div class="capability-tools-header-row">
						<span class="capability-tools-label">{{ t("capabilities.toolsAdd") }}</span>
						<ToolPicker
							data-capability-tools-add-picker

							:button-label="t('capabilities.chooseAddTools')"
							:resources="catalogTools"
							:loading="catalogLoading"
							:error="catalogError"
							can-refresh
							@refresh="loadCatalog"
							v-model="draft.toolsAdd"
						/>
					</div>
					<div class="capability-tag-list">
						<span
							v-for="(tool, index) in draft.toolsAdd"
							:key="tool"
							class="capability-tag add"
						>
							{{ tool }}
							<button type="button" class="capability-tag-remove" :title="t('capabilities.delete')" @click="removeTool('add', index)">×</button>
						</span>
					</div>
				</div>

				<div class="capability-tools-col">
					<div class="capability-tools-header-row">
						<span class="capability-tools-label">{{ t("capabilities.toolsRemove") }}</span>
						<ToolPicker
							data-capability-tools-remove-picker

							:button-label="t('capabilities.chooseRemoveTools')"
							:resources="catalogTools"
							:loading="catalogLoading"
							:error="catalogError"
							can-refresh
							@refresh="loadCatalog"
							v-model="draft.toolsRemove"
						/>
					</div>
					<div class="capability-tag-list">
						<span
							v-for="(tool, index) in draft.toolsRemove"
							:key="tool"
							class="capability-tag remove"
						>
							{{ tool }}
							<button type="button" class="capability-tag-remove" :title="t('capabilities.delete')" @click="removeTool('remove', index)">×</button>
						</span>
					</div>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
.capability-editor {
	display: flex;
	flex-direction: column;
	background: var(--pane);
	border: 1px solid var(--line);
	border-radius: var(--radius);
}

.capability-editor-head {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 14px 16px;
	border-bottom: 1px solid var(--line);
}

.capability-editor-title {
	font-size: 16px;
	font-weight: 600;
}

.capability-editor-selector {
	margin-top: 4px;
	font-size: 12px;
}

.capability-save-note {
	margin-top: 4px;
	font-size: 11px;
	color: var(--muted);
}

.capability-dirty-badge {
	align-self: center;
	padding: 2px 6px;
	font-size: 11px;
	border-radius: 3px;
	background: rgba(234, 179, 8, 0.2);
	color: #ca8a04;
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

.capability-form {
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.capability-form-row {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
}

.capability-field {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.capability-field span,
.capability-field span {
	font-size: 12px;
	font-weight: 600;
	color: var(--muted);
}

.capability-field input,
.capability-field select,
.capability-field textarea,
.capability-field textarea {
	font-family: inherit;
	font-size: 13px;
	padding: 8px 10px;
	border: 1px solid var(--line);
	border-radius: var(--radius);
	background: var(--bg);
	color: inherit;
}

.capability-field input:focus,
.capability-field select:focus,
.capability-field textarea:focus,
.capability-field textarea:focus {
	outline: none;
	border-color: var(--accent);
}

.capability-tools-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 16px;
	padding-top: 6px;
}

.capability-tools-col {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.capability-tools-header-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.capability-tools-label {
	font-size: 12px;
	font-weight: 600;
	color: var(--muted);
}

.capability-tag-list {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	min-height: 32px;
	padding: 6px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: var(--radius);
}

.capability-tag {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 2px 6px;
	font-size: 12px;
	font-family: monospace;
	border-radius: 3px;
}

.capability-tag.add,
.capability-tag.add {
	background: rgba(34, 197, 94, 0.15);
	color: #16a34a;
}

.capability-tag.remove,
.capability-tag.remove {
	background: rgba(220, 50, 50, 0.15);
	color: var(--error);
}

.capability-tag-remove {
	background: transparent;
	border: none;
	color: inherit;
	cursor: pointer;
	padding: 0;
	font-size: 14px;
	line-height: 1;
}

.action-spacer {
	flex: 1;
}
</style>
