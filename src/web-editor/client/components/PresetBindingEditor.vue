<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import { createEditorApi } from "../api.ts";
import { t } from "../i18n.ts";
import type {
	EditorPromptStack,
	EffectiveCapabilityBinding,
	EffectiveCapabilitiesResponse,
	CapabilityBinding,
	CapabilityCollection,
	CapabilityEntry,
	WebEditorPolicyResource,
	WebEditorResources,
} from "../types.ts";
import ToolPicker from "./ToolPicker.vue";

const props = defineProps<{
	stack: EditorPromptStack;
	presetSelector: string;
	presetScope: "project" | "global";
}>();

const bindingRoot = ref<HTMLElement>();

const emit = defineEmits<{
	change: [];
}>();

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);

const availableCapabilities = ref<CapabilityEntry[]>([]);
const capabilitiesLoading = ref(false);
const capabilitiesError = ref("");
const effectiveBindings = ref<EffectiveCapabilityBinding[]>([]);
const previewLoading = ref(false);
const previewError = ref("");
const catalogTools = ref<WebEditorPolicyResource[]>([]);
const catalogLoading = ref(false);
const catalogError = ref("");
// The host draft is plain: do not proxy stored identities when filtering this view state.
const expandedBindings = shallowRef<CapabilityBinding[]>([]);
const bindingKeys = new WeakMap<CapabilityBinding, string>();
let nextBindingKey = 0;

function bindingKey(binding: CapabilityBinding): string {
	let key = bindingKeys.get(binding);
	if (!key) {
		key = `binding-${++nextBindingKey}`;
		bindingKeys.set(binding, key);
	}
	return key;
}

function toggleRowAdvanced(binding: CapabilityBinding): void {
	if (expandedBindings.value.includes(binding)) {
		expandedBindings.value = expandedBindings.value.filter((item) => item !== binding);
	} else {
		expandedBindings.value = [...expandedBindings.value, binding];
	}
}

function isRowAdvancedOpen(binding: CapabilityBinding): boolean {
	return expandedBindings.value.includes(binding);
}

function modeForRef(ref: string): CapabilityEntry | undefined {
	return availableCapabilities.value.find((m) => m.selector === ref || m.capability?.id === ref);
}

function modeName(ref: string): string {
	const entry = modeForRef(ref);
	return entry?.capability?.name || "";
}

function modeScope(ref: string): "project" | "global" | "" {
	const entry = modeForRef(ref);
	if (entry?.scope) return entry.scope;
	if (ref.startsWith("global:")) return "global";
	if (ref.startsWith("project:")) return "project";
	return "";
}

function bindingProblem(binding: CapabilityBinding): string {
	if (!binding.ref) return t("binding.unresolvedRef");
	if (props.presetScope === "global" && (binding.ref.startsWith("project:") || modeScope(binding.ref) === "project")) {
		return t("binding.noGlobalCapabilitiesHint");
	}
	if (availableCapabilities.value.length > 0 && !modeForRef(binding.ref)) {
		return t("binding.unresolvedRef");
	}
	return "";
}

let isUnmounted = false;
let previewGeneration = 0;
let previewRequestId = 0;
let capabilitiesRequestId = 0;
let catalogRequestId = 0;

function teardown(): void {
	isUnmounted = true;
	previewGeneration++;
	previewRequestId++;
	capabilitiesRequestId++;
	catalogRequestId++;
}

onBeforeUnmount(() => {
	teardown();
});

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

function isQualifiedRef(ref: string): boolean {
	return /^(project|global):[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref);
}

// Invalid persisted input must remain visible rather than crash the editor or
// get silently normalized into a different authorization grant.
const editableBindings = computed(() => props.stack.capabilities === undefined ||
	(Array.isArray(props.stack.capabilities) && props.stack.capabilities.every(binding => {
		if (!binding || typeof binding !== "object" || Array.isArray(binding) || typeof binding.ref !== "string") return false;
		if (binding.modelCallable !== undefined && typeof binding.modelCallable !== "boolean") return false;
		const overrides = binding.overrides;
		if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides))) return false;
		const tools = overrides?.tools;
		if (tools !== undefined && (!tools || typeof tools !== "object" || Array.isArray(tools))) return false;
		return [tools?.add, tools?.remove].every(names => names === undefined || (Array.isArray(names) && names.every(name => typeof name === "string")));
	})));

const eligibleCapabilities = computed(() => {
	const scoped = props.presetScope === "global"
		? availableCapabilities.value.filter((m) => m.scope === "global")
		: availableCapabilities.value;
	// Do not manufacture or offer bare/malformed refs. Existing invalid raw
	// values are rendered separately below and remain untouched.
	return scoped.filter((mode) => isQualifiedRef(mode.selector) && !mode.diagnostics?.some(d => d.level === "error"));
});

async function loadAvailableCapabilities(): Promise<void> {
	const reqId = ++capabilitiesRequestId;
	capabilitiesLoading.value = true;
	capabilitiesError.value = "";
	try {
		const res = await api<CapabilityCollection>("/api/capabilities");
		if (isUnmounted || reqId !== capabilitiesRequestId) return;
		availableCapabilities.value = res.capabilities || [];
	} catch (err) {
		if (isUnmounted || reqId !== capabilitiesRequestId) return;
		capabilitiesError.value = err instanceof Error ? err.message : String(err);
	} finally {
		if (reqId === capabilitiesRequestId && !isUnmounted) {
			capabilitiesLoading.value = false;
		}
	}
}

const canAddBinding = computed(() => editableBindings.value && !capabilitiesLoading.value && !capabilitiesError.value && eligibleCapabilities.value.length > 0);

let previewCoalescePending = false;

function scheduleEffectivePreview(): void {
	if (isUnmounted) return;
	if (previewCoalescePending) return;
	previewCoalescePending = true;
	const scheduledGen = previewGeneration;
	queueMicrotask(() => {
		previewCoalescePending = false;
		if (!isUnmounted && scheduledGen === previewGeneration) {
			void fetchEffectivePreview();
		}
	});
}

async function refreshCapabilities(): Promise<void> {
	await loadAvailableCapabilities();
	if (!isUnmounted && !capabilitiesError.value) scheduleEffectivePreview();
}

const addBindingTitle = computed(() => {
	if (!editableBindings.value) return t("binding.invalidRaw");
	if (capabilitiesLoading.value) return t("binding.addDisabledLoading");
	if (capabilitiesError.value) return t("binding.addDisabledError");
	if (eligibleCapabilities.value.length === 0) {
		return props.presetScope === "global"
			? t("binding.addDisabledGlobalScope")
			: t("binding.addDisabledEmpty");
	}
	return t("binding.addTitle");
});

async function fetchEffectivePreview(): Promise<void> {
	if (isUnmounted) return;
	// Increment before the empty-list fast path too: removing the last
	// binding must invalidate an older in-flight response.
	const reqId = ++previewRequestId;
	const currentGen = previewGeneration;
	const bindings = props.stack.capabilities;
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
		const res = await api<EffectiveCapabilitiesResponse>("/api/capabilities/effective", {
			method: "POST",
			body: {
				presetSelector: props.presetSelector,
				bindings,
			},
		});
		if (reqId !== previewRequestId || isUnmounted || currentGen !== previewGeneration) return;
		effectiveBindings.value = res.bindings || [];
	} catch (err) {
		if (reqId !== previewRequestId || isUnmounted || currentGen !== previewGeneration) return;
		previewError.value = err instanceof Error ? err.message : String(err);
	} finally {
		if (reqId === previewRequestId && !isUnmounted && currentGen === previewGeneration) {
			previewLoading.value = false;
		}
	}
}

onMounted(() => {
	void loadAvailableCapabilities();
	void loadCatalog();
	scheduleEffectivePreview();
});

watch(
	() => props.stack.capabilities,
	() => {
		scheduleEffectivePreview();
	},
	{ deep: true },
);

watch(
	() => props.presetSelector,
	() => {
		scheduleEffectivePreview();
	},
);

function ensureBindingsArray(): CapabilityBinding[] {
	if (!Array.isArray(props.stack.capabilities)) {
		props.stack.capabilities = [];
	}
	return props.stack.capabilities;
}

function addBinding(): void {
	if (!canAddBinding.value) return;
	const candidate = eligibleCapabilities.value[0]?.selector;
	if (!candidate || !isQualifiedRef(candidate)) return;
	const list = ensureBindingsArray();
	list.push({
		ref: candidate,
		modelCallable: false,
	});
	emit("change");
	scheduleEffectivePreview();
	void nextTick(() => {
		bindingRoot.value?.querySelector<HTMLSelectElement>("[data-binding-row]:last-child [data-binding-ref]")?.focus();
	});
}

function removeBinding(binding: CapabilityBinding): void {
	const list = ensureBindingsArray();
	const index = list.indexOf(binding);
	if (index < 0) return;
	const label = modeName(binding.ref) || binding.ref || binding.id || `#${index + 1}`;
	if (!window.confirm(t("polish.forms.binding.confirmDelete", { name: label }))) return;
	list.splice(index, 1);
	expandedBindings.value = expandedBindings.value.filter((item) => item !== binding);
	emit("change");
	scheduleEffectivePreview();
}

function setBindingRef(binding: CapabilityBinding, value: string): void {
	// A malformed existing ref is intentionally preserved in its raw form;
	// only a qualified selector offered by this control can replace it.
	if (!isQualifiedRef(value) || !eligibleCapabilities.value.some((mode) => mode.selector === value)) return;
	binding.ref = value;
	emit("change");
	scheduleEffectivePreview();
}

function setBindingId(binding: CapabilityBinding, value: string): void {
	const trimmed = value.trim();
	if (trimmed) {
		binding.id = trimmed;
	} else {
		delete binding.id;
	}
	emit("change");
	scheduleEffectivePreview();
}

function setModelCallable(binding: CapabilityBinding, value: boolean): void {
	if (value) {
		binding.modelCallable = true;
	} else {
		delete binding.modelCallable;
	}
	emit("change");
	scheduleEffectivePreview();
}

function cleanOverrides(binding: CapabilityBinding): void {
	if (!binding.overrides) return;
	if (binding.overrides.tools) {
		if (
			binding.overrides.tools.add === undefined
			&& binding.overrides.tools.remove === undefined
			&& !Object.keys(binding.overrides.tools).some((key) => key !== "add" && key !== "remove")
		) {
			delete binding.overrides.tools;
		}
	}
	if (
		binding.overrides.content === undefined
		&& binding.overrides.appendContent === undefined
		&& binding.overrides.tools === undefined
		&& !Object.keys(binding.overrides).some((key) => key !== "content" && key !== "appendContent" && key !== "tools")
	) {
		delete binding.overrides;
	}
}

function contentOverrideMode(binding: CapabilityBinding): "none" | "replace" | "append" {
	if (binding.overrides?.content !== undefined) return "replace";
	if (binding.overrides?.appendContent !== undefined) return "append";
	return "none";
}

function setContentOverrideMode(binding: CapabilityBinding, mode: "none" | "replace" | "append"): void {
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
	scheduleEffectivePreview();
}

function setContentOverrideText(binding: CapabilityBinding, text: string): void {
	if (!binding.overrides) binding.overrides = {};
	if (binding.overrides.content !== undefined) {
		binding.overrides.content = text;
	} else if (binding.overrides.appendContent !== undefined) {
		binding.overrides.appendContent = text;
	}
	emit("change");
	scheduleEffectivePreview();
}

function toolsOverrideMode(binding: CapabilityBinding, kind: "add" | "remove"): "omitted" | "custom" {
	return binding.overrides?.tools?.[kind] === undefined ? "omitted" : "custom";
}

function toolsOverrideIsEmpty(binding: CapabilityBinding, kind: "add" | "remove"): boolean {
	return binding.overrides?.tools?.[kind]?.length === 0;
}

function setToolsOverrideMode(binding: CapabilityBinding, kind: "add" | "remove", mode: "omitted" | "custom"): void {
	if (mode === "omitted") {
		if (binding.overrides?.tools) {
			delete binding.overrides.tools[kind];
			cleanOverrides(binding);
		}
	} else {
		binding.overrides = binding.overrides || {};
		binding.overrides.tools = binding.overrides.tools || {};
		// [] is a meaningful custom override: preserve it as an explicit wire value.
		if (binding.overrides.tools[kind] === undefined) {
			binding.overrides.tools[kind] = [];
		}
	}
	emit("change");
	scheduleEffectivePreview();
}

function toolsListString(binding: CapabilityBinding, kind: "add" | "remove"): string {
	const list = binding.overrides?.tools?.[kind];
	return Array.isArray(list) ? list.join(", ") : "";
}

function setToolsListString(binding: CapabilityBinding, kind: "add" | "remove", text: string): void {
	binding.overrides = binding.overrides || {};
	binding.overrides.tools = binding.overrides.tools || {};
	const parts = text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
	binding.overrides.tools[kind] = parts;
	emit("change");
	scheduleEffectivePreview();
}

function setToolsOverrideList(binding: CapabilityBinding, kind: "add" | "remove", list: string[]): void {
	binding.overrides = binding.overrides || {};
	binding.overrides.tools = binding.overrides.tools || {};
	binding.overrides.tools[kind] = [...list];
	emit("change");
	scheduleEffectivePreview();
}
</script>

<template>
	<div ref="bindingRoot" class="preset-binding-editor">
		<div class="binding-header">
			<div>
				<span class="binding-title">{{ t("binding.title") }}</span>
				<div class="binding-meta">{{ t("polish.forms.binding.saveHint") }}</div>
			</div>
			<span class="action-spacer"></span>
			<button
				id="refreshCapabilitiesBtn"
                class="icon"
                :aria-label="t('binding.refreshCapabilitiesTitle')"
				type="button"
				data-binding-refresh-btn
				data-icon="↻"
				:disabled="capabilitiesLoading"
				:title="t('binding.refreshCapabilitiesTitle')"
				@click="refreshCapabilities"
			>
			</button>
		</div>

		<div v-if="capabilitiesLoading" class="catalog-status-line" data-binding-catalog-loading>
			{{ t("binding.loadingCapabilities") }}
		</div>
		<div v-else-if="capabilitiesError" class="catalog-error-line" data-binding-catalog-error>
			<span>{{ t("binding.loadCapabilitiesError") }}: {{ capabilitiesError }}</span>
			<button type="button" class="inline-retry-btn" data-binding-retry-btn @click="refreshCapabilities">
				{{ t("binding.retryLoadCapabilities") }}
			</button>
		</div>
		<div v-else-if="eligibleCapabilities.length === 0" class="catalog-hint-line" data-binding-no-eligible>
			{{ presetScope === 'global' && availableCapabilities.length > 0 ? t('binding.noGlobalCapabilitiesHint') : t('binding.noEligibleCapabilitiesHint') }}
		</div>

		<div v-if="previewLoading" class="preview-status-line">
			{{ t("binding.previewLoading") }}
		</div>
		<div v-else-if="previewError" class="preview-error-line">
			{{ t("binding.previewError") }}: {{ previewError }}
		</div>

		<pre v-if="!editableBindings" class="binding-empty">{{ t("binding.invalidRaw") }}
{{ JSON.stringify(stack.capabilities, null, 2) }}</pre>
		<div v-else-if="!stack.capabilities || stack.capabilities.length === 0" class="binding-empty">
			{{ t("binding.noBindings") }}
		</div>

		<div v-else class="binding-list">
			<div
				v-for="(binding, index) in stack.capabilities"
				:key="bindingKey(binding)"
				class="binding-card"
				data-binding-row
				:data-binding-index="index"
			>
				<div class="binding-card-head">
					<label class="binding-ref-field">
						<span class="compact-label">{{ t("binding.ref") }}</span>
						<select
							data-binding-ref
							:value="binding.ref"
							:title="binding.ref"
							@change="setBindingRef(binding, ($event.target as HTMLSelectElement).value)"
						>
							<option v-if="!eligibleCapabilities.some(m => m.selector === binding.ref)" :value="binding.ref">
								{{ binding.ref }}
							</option>
							<option
								v-for="mode in eligibleCapabilities"
								:key="mode.selector"
								:value="mode.selector"
							>
								{{ mode.selector }}{{ mode.capability.name ? ` (${mode.capability.name})` : '' }}
							</option>
						</select>
					</label>
					<div class="binding-actions">
						<label class="binding-checkbox-label">
							<input
								data-binding-model-callable
								type="checkbox"
								:checked="binding.modelCallable === true"
								@change="setModelCallable(binding, ($event.target as HTMLInputElement).checked)"
							>
							<span :title="t('binding.modelCallableHint')">{{ t("binding.modelCallable") }}</span>
						</label>
						<button
							type="button"
							class="binding-advanced-toggle-btn"
							data-binding-advanced-toggle
							:data-binding-index="index"
							:aria-expanded="isRowAdvancedOpen(binding)"
							@click="toggleRowAdvanced(binding)"
						>
						{{ isRowAdvancedOpen(binding) ? t("binding.hideAdvanced") : t("binding.showAdvanced") }}
						</button>

						<button
							type="button"
							class="binding-remove-btn"
							data-binding-delete-btn
							:title="t('binding.deleteTitle')"
							:aria-label="t('binding.deleteTitle')"
							@click="removeBinding(binding)"
						>
						×
						</button>
					</div>
					<span v-if="bindingProblem(binding)" class="binding-problem-badge" data-binding-problem :title="bindingProblem(binding)">
						⚠️ {{ bindingProblem(binding) }}
					</span>
				</div>
				<div v-if="isRowAdvancedOpen(binding)" class="binding-card-body" data-binding-advanced-body>
					<label class="binding-id-field">
						<span class="compact-label">{{ t("binding.id") }}</span>
						<input
							data-binding-id
							type="text"
							:value="binding.id || ''"
							:placeholder="t('binding.idPlaceholder')"
							@input="setBindingId(binding, ($event.target as HTMLInputElement).value)"
						>
					</label>
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
										can-refresh
										@refresh="loadCatalog"
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
								<div v-if="toolsOverrideIsEmpty(binding, 'add')" class="override-empty-hint" data-binding-tools-add-empty>
									{{ t("binding.toolsAddEmptyHint") }}
								</div>
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
										can-refresh
										@refresh="loadCatalog"
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
								<div v-if="toolsOverrideIsEmpty(binding, 'remove')" class="override-empty-hint" data-binding-tools-remove-empty>
									{{ t("binding.toolsRemoveEmptyHint") }}
								</div>
							</div>
						</div>
					</div>

					<!-- Server Effective Preview: independent disclosure, never a second draft. -->
					<details
						v-if="effectiveBindings[index] && !previewLoading && !previewError"
						class="effective-preview-box"
						data-binding-preview
					>
						<summary class="preview-heading">{{ t("binding.previewTitle") }}</summary>

						<div class="preview-content-grid">
							<div class="preview-column">
								<span class="preview-column-title">{{ t("binding.sourceContent") }}</span>
								<pre class="preview-pre" data-binding-source-content>{{ effectiveBindings[index].source.content || '(' + t('capabilities.noContent') + ')' }}</pre>
							</div>
							<div class="preview-column">
								<span class="preview-column-title">{{ t("binding.effectiveContent") }}</span>
								<pre class="preview-pre" data-binding-effective-content>{{ effectiveBindings[index].effective.content || '(' + t('capabilities.noContent') + ')' }}</pre>
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
					</details>
				</div>
			</div>
		</div>
		<button
			id="addBindingBtn"
			class="binding-add-row"
			data-icon="+"
			type="button"
			:disabled="!canAddBinding"
			:title="addBindingTitle"
			@click="addBinding"
		>
			{{ t("binding.add") }}
		</button>
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

.binding-add-row {
	width: 100%;
	padding: 9px;
	border: 1px dashed var(--accent);
	border-radius: 6px;
	background: transparent;
	color: var(--accent);
	font-weight: 650;
}

.binding-add-row:hover:not(:disabled) {
	background: var(--accent-bg);
}

.binding-card {
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--pane-soft);
	overflow: hidden;
}

.binding-card-head { display:flex; flex-wrap:wrap; align-items:end; gap:12px; padding:12px; background:var(--pane); }


.binding-ref-field,
.binding-id-field {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.compact-label { font-size:12px; font-weight:500; color:var(--muted); }

.binding-card-head select,
.binding-card-head input[type="text"] { min-width:0; min-height:32px; font-size:13px; }

.binding-checkbox-label { display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; }

.binding-card-head button {
	padding: 2px 8px;
	min-height: 24px;
	font-size: 12px;
}

.binding-remove-btn {
	min-width: 24px;
	padding: 2px 6px;
	border: 1px solid color-mix(in srgb, var(--error, #dc3545) 45%, var(--line));
	border-radius: 4px;
	background: transparent;
	color: var(--error, #dc3545);
	font-size: 15px;
	line-height: 18px;
	cursor: pointer;
}

.binding-remove-btn:hover {
	background: color-mix(in srgb, var(--error, #dc3545) 10%, transparent);
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
    flex-direction:column;
	align-items: stretch;
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

.override-tools-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(250px,100%),1fr)); gap:12px; }

.override-tool-col {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.override-empty-hint {
	font-size: 11px;
	color: var(--muted);
	line-height: 1.35;
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

.preview-content-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(250px,100%),1fr)); gap:12px; margin-top:10px; }

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
.binding-checkbox-label { white-space: nowrap; }
.binding-checkbox-label input[type="checkbox"] { width: 14px; height: 14px; min-width: 14px; padding: 0; margin: 0; flex: 0 0 14px; }
.binding-ref-field { flex:1 1 260px; min-width:0; }
.binding-id-field { width:min(100%,360px); }
.binding-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.binding-problem-badge { flex-basis:100%; max-width:100%; white-space:normal; }
.preview-heading { cursor:pointer; }
</style>
