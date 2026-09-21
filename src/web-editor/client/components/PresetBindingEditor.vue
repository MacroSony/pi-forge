<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { createEditorApi } from "../api.ts";
import { t } from "../i18n.ts";
import type {
	EditorPromptStack,
	EffectiveInstructionModeBinding,
	EffectiveInstructionModesResponse,
	InstructionModeBinding,
	InstructionModeCollection,
	InstructionModeEntry,
	WebEditorPolicyResource,
	WebEditorResources,
} from "../types.ts";
import ToolPicker from "./ToolPicker.vue";

const props = defineProps<{
	stack: EditorPromptStack;
	presetSelector: string;
	presetScope: "project" | "global";
}>();

const emit = defineEmits<{
	change: [];
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

const availableModes = ref<InstructionModeEntry[]>([]);
const modesLoading = ref(false);
const modesError = ref("");
const effectiveBindings = ref<EffectiveInstructionModeBinding[]>([]);
const previewLoading = ref(false);
const previewError = ref("");
const catalogTools = ref<WebEditorPolicyResource[]>([]);
const catalogLoading = ref(false);
const catalogError = ref("");
const expandedRows = ref<Record<number, boolean>>({});

function toggleRowAdvanced(index: number): void {
	expandedRows.value[index] = !expandedRows.value[index];
}

function isRowAdvancedOpen(index: number): boolean {
	return !!expandedRows.value[index];
}

function modeForRef(ref: string): InstructionModeEntry | undefined {
	return availableModes.value.find((m) => m.selector === ref || m.mode?.id === ref);
}

function modeName(ref: string): string {
	const entry = modeForRef(ref);
	return entry?.mode?.name || "";
}

function modeScope(ref: string): "project" | "global" | "" {
	const entry = modeForRef(ref);
	if (entry?.scope) return entry.scope;
	if (ref.startsWith("global:")) return "global";
	if (ref.startsWith("project:")) return "project";
	return "";
}

function bindingProblem(binding: InstructionModeBinding): string {
	if (!binding.ref) return t("binding.unresolvedRef");
	if (props.presetScope === "global" && (binding.ref.startsWith("project:") || modeScope(binding.ref) === "project")) {
		return t("binding.noGlobalModesHint");
	}
	if (availableModes.value.length > 0 && !modeForRef(binding.ref)) {
		return t("binding.unresolvedRef");
	}
	return "";
}

let isUnmounted = false;
let previewRequestId = 0;
let modesRequestId = 0;
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

onBeforeUnmount(() => {
	isUnmounted = true;
});

function isQualifiedRef(ref: string): boolean {
	return /^(project|global):[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref);
}

// Invalid persisted input must remain visible rather than crash the editor or
// get silently normalized into a different authorization grant.
const editableBindings = computed(() => props.stack.instructionModes === undefined ||
	(Array.isArray(props.stack.instructionModes) && props.stack.instructionModes.every(binding => {
		if (!binding || typeof binding !== "object" || Array.isArray(binding) || typeof binding.ref !== "string") return false;
		if (binding.modelCallable !== undefined && typeof binding.modelCallable !== "boolean") return false;
		const overrides = binding.overrides;
		if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides))) return false;
		const tools = overrides?.tools;
		if (tools !== undefined && (!tools || typeof tools !== "object" || Array.isArray(tools))) return false;
		return [tools?.add, tools?.remove].every(names => names === undefined || (Array.isArray(names) && names.every(name => typeof name === "string")));
	})));

const eligibleModes = computed(() => {
	const scoped = props.presetScope === "global"
		? availableModes.value.filter((m) => m.scope === "global")
		: availableModes.value;
	// Do not manufacture or offer bare/malformed refs. Existing invalid raw
	// values are rendered separately below and remain untouched.
	return scoped.filter((mode) => isQualifiedRef(mode.selector) && !mode.diagnostics?.some(d => d.level === "error"));
});

async function loadAvailableModes(): Promise<void> {
	const reqId = ++modesRequestId;
	modesLoading.value = true;
	modesError.value = "";
	try {
		const res = await api<InstructionModeCollection>("/api/instruction-modes");
		if (isUnmounted || reqId !== modesRequestId) return;
		availableModes.value = res.modes || [];
	} catch (err) {
		if (isUnmounted || reqId !== modesRequestId) return;
		modesError.value = err instanceof Error ? err.message : String(err);
	} finally {
		if (reqId === modesRequestId && !isUnmounted) {
			modesLoading.value = false;
		}
	}
}

const canAddBinding = computed(() => editableBindings.value && !modesLoading.value && !modesError.value && eligibleModes.value.length > 0);

async function refreshModes(): Promise<void> {
	await loadAvailableModes();
	if (!isUnmounted && !modesError.value) await fetchEffectivePreview();
}

const addBindingTitle = computed(() => {
	if (!editableBindings.value) return t("binding.invalidRaw");
	if (modesLoading.value) return t("binding.addDisabledLoading");
	if (modesError.value) return t("binding.addDisabledError");
	if (eligibleModes.value.length === 0) {
		return props.presetScope === "global"
			? t("binding.addDisabledGlobalScope")
			: t("binding.addDisabledEmpty");
	}
	return t("binding.addTitle");
});

async function fetchEffectivePreview(): Promise<void> {
	// Increment before the empty-list fast path too: removing the last
	// binding must invalidate an older in-flight response.
	const reqId = ++previewRequestId;
	const bindings = props.stack.instructionModes;
	if (!editableBindings.value) { effectiveBindings.value = []; previewLoading.value = false; previewError.value = t("binding.invalidRaw"); return; }
	if (!bindings || bindings.length === 0) {
		effectiveBindings.value = [];
		previewError.value = "";
		previewLoading.value = false;
		return;
	}

	previewLoading.value = true;
	previewError.value = "";

	try {
		const res = await api<EffectiveInstructionModesResponse>("/api/instruction-modes/effective", {
			method: "POST",
			body: {
				presetSelector: props.presetSelector,
				bindings,
			},
		});
		if (reqId !== previewRequestId || isUnmounted) return;
		effectiveBindings.value = res.bindings || [];
	} catch (err) {
		if (reqId !== previewRequestId || isUnmounted) return;
		previewError.value = err instanceof Error ? err.message : String(err);
	} finally {
		if (reqId === previewRequestId && !isUnmounted) {
			previewLoading.value = false;
		}
	}
}

onMounted(() => {
	void loadAvailableModes();
	void loadCatalog();
	void fetchEffectivePreview();
});

watch(
	() => props.stack.instructionModes,
	() => {
		void fetchEffectivePreview();
	},
	{ deep: true },
);

watch(
	() => props.presetSelector,
	() => {
		void fetchEffectivePreview();
	},
);

function ensureBindingsArray(): InstructionModeBinding[] {
	if (!Array.isArray(props.stack.instructionModes)) {
		props.stack.instructionModes = [];
	}
	return props.stack.instructionModes;
}

function addBinding(): void {
	if (!canAddBinding.value) return;
	const candidate = eligibleModes.value[0]?.selector;
	if (!candidate || !isQualifiedRef(candidate)) return;
	const list = ensureBindingsArray();
	list.push({
		ref: candidate,
		modelCallable: false,
	});
	emit("change");
	void fetchEffectivePreview();
}

function removeBinding(index: number): void {
	const list = ensureBindingsArray();
	list.splice(index, 1);
	emit("change");
	void fetchEffectivePreview();
}

function moveBinding(index: number, delta: number): void {
	const list = ensureBindingsArray();
	const target = index + delta;
	if (target < 0 || target >= list.length) return;
	const [item] = list.splice(index, 1);
	list.splice(target, 0, item);
	emit("change");
	void fetchEffectivePreview();
}

function setBindingRef(binding: InstructionModeBinding, value: string): void {
	// A malformed existing ref is intentionally preserved in its raw form;
	// only a qualified selector offered by this control can replace it.
	if (!isQualifiedRef(value) || !eligibleModes.value.some((mode) => mode.selector === value)) return;
	binding.ref = value;
	emit("change");
	void fetchEffectivePreview();
}

function setBindingId(binding: InstructionModeBinding, value: string): void {
	const trimmed = value.trim();
	if (trimmed) {
		binding.id = trimmed;
	} else {
		delete binding.id;
	}
	emit("change");
	void fetchEffectivePreview();
}

function setModelCallable(binding: InstructionModeBinding, value: boolean): void {
	if (value) {
		binding.modelCallable = true;
	} else {
		delete binding.modelCallable;
	}
	emit("change");
	void fetchEffectivePreview();
}

function cleanOverrides(binding: InstructionModeBinding): void {
	if (!binding.overrides) return;
	if (binding.overrides.tools) {
		if (binding.overrides.tools.add === undefined && binding.overrides.tools.remove === undefined) {
			delete binding.overrides.tools;
		}
	}
	if (
		binding.overrides.content === undefined
		&& binding.overrides.appendContent === undefined
		&& binding.overrides.tools === undefined
	) {
		delete binding.overrides;
	}
}

function contentOverrideMode(binding: InstructionModeBinding): "none" | "replace" | "append" {
	if (binding.overrides?.content !== undefined) return "replace";
	if (binding.overrides?.appendContent !== undefined) return "append";
	return "none";
}

function setContentOverrideMode(binding: InstructionModeBinding, mode: "none" | "replace" | "append"): void {
	if (mode === "none") {
		if (binding.overrides) {
			delete binding.overrides.content;
			delete binding.overrides.appendContent;
			cleanOverrides(binding);
		}
	} else if (mode === "replace") {
		binding.overrides = binding.overrides || {};
		delete binding.overrides.appendContent;
		if (binding.overrides.content === undefined) {
			binding.overrides.content = "";
		}
	} else if (mode === "append") {
		binding.overrides = binding.overrides || {};
		delete binding.overrides.content;
		if (binding.overrides.appendContent === undefined) {
			binding.overrides.appendContent = "";
		}
	}
	emit("change");
	void fetchEffectivePreview();
}

function setContentOverrideText(binding: InstructionModeBinding, text: string): void {
	if (!binding.overrides) binding.overrides = {};
	if (binding.overrides.content !== undefined) {
		binding.overrides.content = text;
	} else if (binding.overrides.appendContent !== undefined) {
		binding.overrides.appendContent = text;
	}
	emit("change");
	void fetchEffectivePreview();
}

function toolsOverrideMode(binding: InstructionModeBinding, kind: "add" | "remove"): "omitted" | "explicitEmpty" | "custom" {
	const list = binding.overrides?.tools?.[kind];
	if (list === undefined) return "omitted";
	if (Array.isArray(list) && list.length === 0) return "explicitEmpty";
	return "custom";
}

function setToolsOverrideMode(binding: InstructionModeBinding, kind: "add" | "remove", mode: "omitted" | "explicitEmpty" | "custom"): void {
	if (mode === "omitted") {
		if (binding.overrides?.tools) {
			delete binding.overrides.tools[kind];
			cleanOverrides(binding);
		}
	} else if (mode === "explicitEmpty") {
		binding.overrides = binding.overrides || {};
		binding.overrides.tools = binding.overrides.tools || {};
		binding.overrides.tools[kind] = [];
	} else if (mode === "custom") {
		binding.overrides = binding.overrides || {};
		binding.overrides.tools = binding.overrides.tools || {};
		if (!Array.isArray(binding.overrides.tools[kind])) {
			binding.overrides.tools[kind] = [];
		}
	}
	emit("change");
	void fetchEffectivePreview();
}

function toolsListString(binding: InstructionModeBinding, kind: "add" | "remove"): string {
	const list = binding.overrides?.tools?.[kind];
	return Array.isArray(list) ? list.join(", ") : "";
}

function setToolsListString(binding: InstructionModeBinding, kind: "add" | "remove", text: string): void {
	binding.overrides = binding.overrides || {};
	binding.overrides.tools = binding.overrides.tools || {};
	const parts = text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
	binding.overrides.tools[kind] = parts;
	emit("change");
	void fetchEffectivePreview();
}

function setToolsOverrideList(binding: InstructionModeBinding, kind: "add" | "remove", list: string[]): void {
	binding.overrides = binding.overrides || {};
	binding.overrides.tools = binding.overrides.tools || {};
	binding.overrides.tools[kind] = [...list];
	emit("change");
	void fetchEffectivePreview();
}
</script>

<template>
	<div class="preset-binding-editor">
		<div class="binding-header">
			<div>
				<span class="binding-title">{{ t("binding.title") }}</span>
				<div class="binding-meta">{{ t("binding.meta") }}</div>
			</div>
			<span class="action-spacer"></span>
			<button
				id="refreshModesBtn"
				type="button"
				data-binding-refresh-btn
				data-icon="↻"
				:disabled="modesLoading"
				:title="t('binding.refreshModesTitle')"
				@click="refreshModes"
			>
				{{ modesLoading ? t("binding.refreshingModes") : t("binding.refreshModes") }}
			</button>
			<button
				id="addBindingBtn"
				type="button"
				data-icon="+"
				:disabled="!canAddBinding"
				:title="addBindingTitle"
				@click="addBinding"
			>
				{{ t("binding.add") }}
			</button>
		</div>

		<div v-if="modesLoading" class="catalog-status-line" data-binding-catalog-loading>
			{{ t("binding.loadingModes") }}
		</div>
		<div v-else-if="modesError" class="catalog-error-line" data-binding-catalog-error>
			<span>{{ t("binding.loadModesError") }}: {{ modesError }}</span>
			<button type="button" class="inline-retry-btn" data-binding-retry-btn @click="refreshModes">
				{{ t("binding.retryLoadModes") }}
			</button>
		</div>
		<div v-else-if="eligibleModes.length === 0" class="catalog-hint-line" data-binding-no-eligible>
			{{ presetScope === 'global' && availableModes.length > 0 ? t('binding.noGlobalModesHint') : t('binding.noEligibleModesHint') }}
		</div>

		<div v-if="previewLoading" class="preview-status-line">
			{{ t("binding.previewLoading") }}
		</div>
		<div v-else-if="previewError" class="preview-error-line">
			{{ t("binding.previewError") }}: {{ previewError }}
		</div>

		<pre v-if="!editableBindings" class="binding-empty">{{ t("binding.invalidRaw") }}
{{ JSON.stringify(stack.instructionModes, null, 2) }}</pre>
		<div v-else-if="!stack.instructionModes || stack.instructionModes.length === 0" class="binding-empty">
			{{ t("binding.noBindings") }}
		</div>

		<div v-else class="binding-list">
			<div
				v-for="(binding, index) in stack.instructionModes"
				:key="index"
				class="binding-card"
				data-binding-row
				:data-binding-index="index"
			>
				<div class="binding-card-head">
					<span class="binding-card-idx">#{{ index + 1 }}</span>
					<span v-if="modeName(binding.ref)" class="binding-mode-name" data-binding-name>
						{{ modeName(binding.ref) }}
					</span>
					<div class="binding-ref-field">
						<label class="compact-label">{{ t("binding.ref") }}</label>
						<select
							data-binding-ref
							:value="binding.ref"
							@change="setBindingRef(binding, ($event.target as HTMLSelectElement).value)"
						>
							<option v-if="!eligibleModes.some(m => m.selector === binding.ref)" :value="binding.ref">
								{{ binding.ref }}
							</option>
							<option
								v-for="mode in eligibleModes"
								:key="mode.selector"
								:value="mode.selector"
							>
								{{ mode.selector }}{{ mode.mode.name ? ` (${mode.mode.name})` : '' }}
							</option>
						</select>
					</div>

					<span class="binding-scope-badge" data-binding-scope :data-scope="modeScope(binding.ref) || presetScope">
						{{ modeScope(binding.ref) || presetScope }}
					</span>

					<div class="binding-id-field">
						<label class="compact-label">{{ t("binding.id") }}</label>
						<input
							data-binding-id
							type="text"
							:value="binding.id || ''"
							:placeholder="t('binding.idPlaceholder')"
							@input="setBindingId(binding, ($event.target as HTMLInputElement).value)"
						>
					</div>

					<label class="binding-checkbox-label">
						<input
							data-binding-model-callable
							type="checkbox"
							:checked="binding.modelCallable === true"
							@change="setModelCallable(binding, ($event.target as HTMLInputElement).checked)"
						>
						<span :title="t('binding.modelCallableHint')">{{ t("binding.modelCallable") }}</span>
					</label>

					<span v-if="bindingProblem(binding)" class="binding-problem-badge" data-binding-problem :title="bindingProblem(binding)">
						⚠️ {{ bindingProblem(binding) }}
					</span>

					<span class="action-spacer"></span>

					<button
						type="button"
						class="binding-advanced-toggle-btn"
						data-binding-advanced-toggle
						:data-binding-index="index"
						:aria-expanded="isRowAdvancedOpen(index)"
						@click="toggleRowAdvanced(index)"
					>
						{{ isRowAdvancedOpen(index) ? t("binding.hideAdvanced") : t("binding.showAdvanced") }}
					</button>

					<button
						type="button"
						data-binding-up-btn
						:disabled="index === 0"
						:title="t('binding.up')"
						@click="moveBinding(index, -1)"
					>
						↑
					</button>
					<button
						type="button"
						data-binding-down-btn
						:disabled="index === stack.instructionModes.length - 1"
						:title="t('binding.down')"
						@click="moveBinding(index, 1)"
					>
						↓
					</button>
					<button
						type="button"
						class="danger"
						data-binding-delete-btn
						:title="t('binding.deleteTitle')"
						@click="removeBinding(index)"
					>
						×
					</button>
				</div>

				<div v-if="isRowAdvancedOpen(index)" class="binding-card-body" data-binding-advanced-body>
					<!-- Overrides Section -->
					<div class="overrides-section">
						<span class="overrides-title">{{ t("binding.overrides") }}</span>

						<!-- Content Override -->
						<div class="override-row">
							<div class="override-control">
								<label class="compact-label">{{ t("binding.contentOverride") }}</label>
								<select
									data-binding-content-mode
									:value="contentOverrideMode(binding)"
									@change="setContentOverrideMode(binding, ($event.target as HTMLSelectElement).value as any)"
								>
									<option value="none">{{ t("binding.contentModeNone") }}</option>
									<option value="replace">{{ t("binding.contentModeReplace") }}</option>
									<option value="append">{{ t("binding.contentModeAppend") }}</option>
								</select>
							</div>

							<div v-if="contentOverrideMode(binding) !== 'none'" class="override-input-wrap">
								<textarea
									v-if="contentOverrideMode(binding) === 'replace'"
									data-binding-content
									rows="3"
									:value="binding.overrides?.content ?? ''"
									:placeholder="t('binding.contentPlaceholder')"
									@input="setContentOverrideText(binding, ($event.target as HTMLTextAreaElement).value)"
								></textarea>
								<textarea
									v-else-if="contentOverrideMode(binding) === 'append'"
									data-binding-append-content
									rows="3"
									:value="binding.overrides?.appendContent ?? ''"
									:placeholder="t('binding.appendContentPlaceholder')"
									@input="setContentOverrideText(binding, ($event.target as HTMLTextAreaElement).value)"
								></textarea>
							</div>
						</div>

						<!-- Tool Overrides: Add / Remove -->
						<div class="override-tools-grid">
							<div class="override-tool-col">
								<div class="override-tool-label-row">
									<label class="compact-label">{{ t("binding.toolsAddMode") }}</label>
									<ToolPicker
										v-if="toolsOverrideMode(binding, 'add') === 'custom'"
										data-binding-tools-add-picker
										:button-label="t('tools.chooseTools')"
										:resources="catalogTools"
										:loading="catalogLoading"
										:error="catalogError"
										:model-value="binding.overrides?.tools?.add || []"
										@update:model-value="(tools) => setToolsOverrideList(binding, 'add', tools)"
									/>
								</div>
								<select
									data-binding-tools-add-mode
									:value="toolsOverrideMode(binding, 'add')"
									@change="setToolsOverrideMode(binding, 'add', ($event.target as HTMLSelectElement).value as any)"
								>
									<option value="omitted">{{ t("binding.toolsOmitted") }}</option>
									<option value="explicitEmpty">{{ t("binding.toolsExplicitEmpty") }}</option>
									<option value="custom">{{ t("binding.toolsCustom") }}</option>
								</select>
								<input
									v-if="toolsOverrideMode(binding, 'add') === 'custom'"
									data-binding-tools-add-input
									type="text"
									:value="toolsListString(binding, 'add')"
									placeholder="tool1, tool2"
									@input="setToolsListString(binding, 'add', ($event.target as HTMLInputElement).value)"
								>
							</div>

							<div class="override-tool-col">
								<div class="override-tool-label-row">
									<label class="compact-label">{{ t("binding.toolsRemoveMode") }}</label>
									<ToolPicker
										v-if="toolsOverrideMode(binding, 'remove') === 'custom'"
										data-binding-tools-remove-picker
										:button-label="t('tools.chooseTools')"
										:resources="catalogTools"
										:loading="catalogLoading"
										:error="catalogError"
										:model-value="binding.overrides?.tools?.remove || []"
										@update:model-value="(tools) => setToolsOverrideList(binding, 'remove', tools)"
									/>
								</div>
								<select
									data-binding-tools-remove-mode
									:value="toolsOverrideMode(binding, 'remove')"
									@change="setToolsOverrideMode(binding, 'remove', ($event.target as HTMLSelectElement).value as any)"
								>
									<option value="omitted">{{ t("binding.toolsOmitted") }}</option>
									<option value="explicitEmpty">{{ t("binding.toolsExplicitEmpty") }}</option>
									<option value="custom">{{ t("binding.toolsCustom") }}</option>
								</select>
								<input
									v-if="toolsOverrideMode(binding, 'remove') === 'custom'"
									data-binding-tools-remove-input
									type="text"
									:value="toolsListString(binding, 'remove')"
									placeholder="tool1, tool2"
									@input="setToolsListString(binding, 'remove', ($event.target as HTMLInputElement).value)"
								>
							</div>
						</div>
					</div>

					<!-- Server Effective Preview -->
					<div
						v-if="effectiveBindings[index]"
						class="effective-preview-box"
						data-binding-preview
					>
						<span class="preview-heading">{{ t("binding.previewTitle") }}</span>

						<div class="preview-content-grid">
							<div class="preview-column">
								<span class="preview-column-title">{{ t("binding.sourceContent") }}</span>
								<pre class="preview-pre" data-binding-source-content>{{ effectiveBindings[index].source.content || '(' + t('modes.noContent') + ')' }}</pre>
							</div>
							<div class="preview-column">
								<span class="preview-column-title">{{ t("binding.effectiveContent") }}</span>
								<pre class="preview-pre" data-binding-effective-content>{{ effectiveBindings[index].effective.content || '(' + t('modes.noContent') + ')' }}</pre>
							</div>
						</div>

						<div class="preview-tool-diff" data-binding-tool-diff>
							<span class="preview-column-title">{{ t("binding.toolDiff") }}:</span>
							<div class="tool-diff-lines">
								<div>
									<span class="diff-tag">{{ t("binding.sourceTools") }}:</span>
									<span>+[{{ (effectiveBindings[index].source.tools?.add || []).join(', ') }}]</span>
									<span>-[{{ (effectiveBindings[index].source.tools?.remove || []).join(', ') }}]</span>
								</div>
								<div>
									<span class="diff-tag">{{ t("binding.effectiveTools") }}:</span>
									<span class="effective-add">+[{{ (effectiveBindings[index].effective.tools?.add || []).join(', ') }}]</span>
									<span class="effective-remove">-[{{ (effectiveBindings[index].effective.tools?.remove || []).join(', ') }}]</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.preset-binding-editor {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 8px 0;
}

.binding-header {
	display: flex;
	align-items: center;
	gap: 12px;
}

.binding-title {
	font-weight: 700;
	font-size: 14px;
}

.binding-meta {
	font-size: 12px;
	color: var(--muted);
	margin-top: 2px;
}

.action-spacer {
	flex: 1;
}

.preview-status-line {
	font-size: 12px;
	color: var(--muted);
	font-style: italic;
}

.preview-error-line {
	font-size: 12px;
	color: var(--error);
}

.catalog-status-line {
	font-size: 12px;
	color: var(--muted);
	font-style: italic;
}

.catalog-error-line {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 12px;
	color: var(--error);
}

.inline-retry-btn {
	padding: 2px 8px;
	font-size: 11px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--bg);
	color: var(--fg);
	cursor: pointer;
}

.catalog-hint-line {
	font-size: 12px;
	color: var(--muted);
	padding: 4px 8px;
	background: var(--pane-soft);
	border: 1px solid var(--line);
	border-radius: 4px;
}

.binding-header button:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.binding-empty {
	padding: 12px;
	border: 1px dashed var(--line);
	border-radius: 4px;
	font-size: 13px;
	color: var(--muted);
	text-align: center;
}

.binding-list {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.binding-card {
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane-soft);
	overflow: hidden;
}

.binding-card-head {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 12px;
	background: var(--pane);
	border-bottom: 1px solid var(--line);
}

.binding-card-idx {
	font-weight: 700;
	font-size: 12px;
	color: var(--muted);
}

.binding-ref-field,
.binding-id-field {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.compact-label {
	font-size: 10px;
	font-weight: 600;
	color: var(--muted);
	text-transform: uppercase;
}

.binding-card-head select,
.binding-card-head input[type="text"] {
	padding: 4px 8px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--bg);
	color: var(--fg);
	font-size: 12px;
}

.binding-checkbox-label {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	cursor: pointer;
	margin-left: 6px;
}

.binding-card-head button {
	padding: 2px 8px;
	min-height: 24px;
	font-size: 12px;
}

.binding-card-body {
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.overrides-section {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.overrides-title {
	font-size: 11px;
	font-weight: 700;
	color: var(--muted);
	text-transform: uppercase;
}

.override-row {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.override-control {
	display: flex;
	align-items: center;
	gap: 8px;
}

.override-control select {
	padding: 3px 6px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--bg);
	color: var(--fg);
	font-size: 12px;
}

.override-input-wrap textarea {
	width: 100%;
	padding: 6px 8px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--bg);
	color: var(--fg);
	font-family: monospace;
	font-size: 12px;
}

.override-tool-label-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 6px;
}

.override-tools-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
}

.override-tool-col {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.override-tool-col select,
.override-tool-col input {
	padding: 3px 6px;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--bg);
	color: var(--fg);
	font-size: 12px;
}

.effective-preview-box {
	border-top: 1px solid var(--line);
	padding-top: 10px;
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.preview-heading {
	font-size: 11px;
	font-weight: 700;
	color: var(--muted);
	text-transform: uppercase;
}

.preview-content-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 10px;
}

.preview-column {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.preview-column-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--muted);
}

.preview-pre {
	margin: 0;
	padding: 6px 8px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 4px;
	font-family: monospace;
	font-size: 11px;
	white-space: pre-wrap;
	word-break: break-word;
	max-height: 120px;
	overflow-y: auto;
}

.preview-tool-diff {
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-size: 12px;
	font-family: monospace;
}

.tool-diff-lines {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 4px 8px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 4px;
}

.diff-tag {
	font-weight: 600;
	color: var(--muted);
	margin-right: 6px;
}

.effective-add {
	color: #28a745;
	font-weight: 600;
}

.effective-remove {
	color: #dc3545;
	font-weight: 600;
}

.binding-mode-name {
	font-weight: 600;
	font-size: 12px;
	color: var(--text);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 140px;
}

.binding-scope-badge {
	font-size: 10px;
	padding: 1px 5px;
	border-radius: 3px;
	background: var(--pane);
	border: 1px solid var(--line);
	color: var(--muted);
	text-transform: uppercase;
	font-weight: 600;
}

.binding-problem-badge {
	font-size: 11px;
	color: var(--error, #ef4444);
	background: color-mix(in srgb, var(--error, #ef4444) 10%, transparent);
	padding: 1px 6px;
	border-radius: 3px;
	border: 1px solid color-mix(in srgb, var(--error, #ef4444) 30%, transparent);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 200px;
}

.binding-advanced-toggle-btn {
	padding: 2px 8px;
	font-size: 11px;
	border-radius: 3px;
	border: 1px solid var(--line);
	background: var(--pane);
	color: var(--text);
	cursor: pointer;
}

.binding-advanced-toggle-btn:hover {
	background: var(--pane-soft);
	border-color: var(--accent);
}
</style>
