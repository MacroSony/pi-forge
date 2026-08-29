<script setup lang="ts">
import { ref, watch } from "vue";

import type { PromptVariableValue } from "../../../types.ts";
import { t } from "../i18n.ts";
import type { EditorPromptStack, WebEditorResources } from "../types.ts";

interface VariableRow {
	key: number;
	name: string;
	value: string;
	format: "text" | "json";
}

const props = defineProps<{
	stack: EditorPromptStack;
	resources: WebEditorResources;
	copyText: (text: string) => void | Promise<void>;
}>();

const emit = defineEmits<{
	apply: [];
	change: [error: string];
	status: [text: string, tone?: string];
}>();

let nextVariableKey = 1;
const variableRows = ref(readVariableRows());
const stackError = ref("");
const rawJsonText = ref(displayStackJson());
const rawJsonStatus = ref(t("stackTab.rawDraft"));
// Local reactive mirror: the draft prop is a plain JSON clone, so nested
// context mutations do not trigger re-rendering on their own.
const mergeEnabled = ref(props.stack.context?.mergeConsecutiveRoles === true);
const customSeparatorEnabled = ref(Object.hasOwn(props.stack.context ?? {}, "mergeSeparator"));

watch(
	() => props.stack,
	() => reset(),
);

function reset(): void {
	variableRows.value = readVariableRows();
	stackError.value = "";
	rawJsonText.value = displayStackJson();
	rawJsonStatus.value = t("stackTab.rawDraft");
	mergeEnabled.value = props.stack.context?.mergeConsecutiveRoles === true;
	customSeparatorEnabled.value = Object.hasOwn(props.stack.context ?? {}, "mergeSeparator");
}

function readVariableRows(): VariableRow[] {
	const values = props.stack.schemaVersion === 2
		? props.stack.parameters || {}
		: props.stack.variables || {};
	return Object.entries(values)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => ({
			key: nextVariableKey++,
			name,
			value: props.stack.schemaVersion === 2 && typeof value !== "string"
				? JSON.stringify(value)
				: String(value ?? ""),
			format: props.stack.schemaVersion === 2 && typeof value !== "string" ? "json" : "text",
		}));
}

function setAllowDuplicateChatHistory(event: Event): void {
	const checked = (event.target as HTMLInputElement).checked;
	const context = {
		...((props.stack.context && typeof props.stack.context === "object")
			? props.stack.context
			: {}),
	} as Record<string, unknown>;
	if (checked) context.allowDuplicateChatHistory = true;
	else delete context.allowDuplicateChatHistory;
	if (Object.keys(context).length > 0) props.stack.context = context;
	else delete props.stack.context;
	emit("change", stackError.value);
}

function updateContext(mutate: (context: Record<string, unknown>) => void): void {
	const context = {
		...((props.stack.context && typeof props.stack.context === "object")
			? props.stack.context
			: {}),
	} as Record<string, unknown>;
	mutate(context);
	if (Object.keys(context).length > 0) props.stack.context = context;
	else delete props.stack.context;
	emit("change", stackError.value);
}

function setMergeConsecutiveRoles(event: Event): void {
	const checked = (event.target as HTMLInputElement).checked;
	mergeEnabled.value = checked;
	updateContext((context) => {
		if (checked) context.mergeConsecutiveRoles = true;
		else delete context.mergeConsecutiveRoles;
	});
}

function setMergeSeparator(event: Event): void {
	const value = (event.target as HTMLInputElement).value;
	updateContext((context) => {
		context.mergeSeparator = value;
	});
}

function setCustomMergeSeparator(event: Event): void {
	const checked = (event.target as HTMLInputElement).checked;
	customSeparatorEnabled.value = checked;
	updateContext((context) => {
		if (checked) {
			if (typeof context.mergeSeparator !== "string") context.mergeSeparator = "\n\n";
		} else {
			delete context.mergeSeparator;
		}
	});
}

function addVariable(): void {
	variableRows.value.push({
		key: nextVariableKey++,
		name: uniqueVariableName(),
		value: "",
		format: "text",
	});
	syncVariables();
}

function deleteVariable(index: number): void {
	variableRows.value.splice(index, 1);
	syncVariables();
}

function uniqueVariableName(): string {
	const existing = new Set(
		variableRows.value
			.map((row) => row.name.trim())
			.filter(Boolean),
	);
	let index = existing.size + 1;
	let name = `var${index}`;
	while (existing.has(name)) name = `var${++index}`;
	return name;
}

function syncVariables(): void {
	const variables: Record<string, PromptVariableValue> = {};
	const seen = new Set<string>();
	let duplicate = false;
	let jsonError = "";
	for (const row of variableRows.value) {
		const name = row.name.trim();
		if (!name) continue;
		if (seen.has(name)) duplicate = true;
		seen.add(name);
		if (props.stack.schemaVersion === 2 && row.format === "json") {
			try {
				variables[name] = JSON.parse(row.value);
			} catch {
				jsonError ||= t("stackTab.invalidParameterJson", { name });
			}
		} else {
			variables[name] = row.value;
		}
	}
	if (!jsonError && props.stack.schemaVersion === 2) {
		if (Object.keys(variables).length > 0) props.stack.parameters = variables;
		else delete props.stack.parameters;
	} else if (props.stack.schemaVersion !== 2) {
		if (Object.keys(variables).length > 0) props.stack.variables = variables as Record<string, string>;
		else delete props.stack.variables;
	}
	stackError.value = duplicate ? t("stackTab.duplicateVarNames") : jsonError;
	emit("change", stackError.value);
}

function setVariableFormat(row: VariableRow, format: "text" | "json"): void {
	if (format === row.format) return;
	if (format === "json") row.value = JSON.stringify(row.value);
	else {
		try {
			const parsed = JSON.parse(row.value) as unknown;
			row.value = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
		} catch {
			// Keep the current text; changing to text makes it a valid string value.
		}
	}
	row.format = format;
	syncVariables();
}

function displayStackJson(): string {
	const stack = cloneJson(props.stack);
	if (!stack.type) stack.type = "pi-forge.prompt-stack";
	if (!stack.schemaVersion) stack.schemaVersion = 1;
	return JSON.stringify(stack, null, 2);
}

async function copyRawJson(): Promise<void> {
	try {
		await props.copyText(rawJsonText.value);
		rawJsonStatus.value = t("stackTab.copiedJson");
		emit("status", t("stackTab.copiedJsonStatus"), "success");
	} catch (error) {
		const message = errorMessage(error);
		rawJsonStatus.value = message;
		emit("status", message, "error");
	}
}

function applyRawJson(): void {
	try {
		const parsed = JSON.parse(rawJsonText.value) as unknown;
		validateRawStackJson(parsed);
		const stack = parsed as EditorPromptStack;
		if (!stack.schemaVersion) stack.schemaVersion = 1;
		if (!stack.type) stack.type = "pi-forge.prompt-stack";
		replaceObject(props.stack, stack);
		rawJsonStatus.value = t("stackTab.appliedJson");
		emit("apply");
	} catch (error) {
		const message = errorMessage(error);
		rawJsonStatus.value = message;
		emit("status", message, "error");
	}
}

function validateRawStackJson(stack: unknown): asserts stack is EditorPromptStack {
	if (!stack || typeof stack !== "object" || Array.isArray(stack)) {
		throw new Error(t("error.stackJsonNotObject"));
	}
	const candidate = stack as Record<string, unknown>;
	if (typeof candidate.id !== "string" || !candidate.id.trim()) {
		throw new Error(t("error.stackJsonNoId"));
	}
	if (!Array.isArray(candidate.items)) {
		throw new Error(t("error.stackJsonNoItems"));
	}
	candidate.items.forEach((item, index) => {
		const label = t("error.itemLabel", { index: index + 1 });
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(t("error.itemNotObject", { label }));
		}
		const candidateItem = item as Record<string, unknown>;
		if (candidateItem.kind !== "block" && candidateItem.kind !== "slot") {
			throw new Error(t("error.itemKind", { label }));
		}
		if (typeof candidateItem.id !== "string" || !candidateItem.id.trim()) {
			throw new Error(t("error.itemNoId", { label }));
		}
		if (candidateItem.kind === "block" && typeof candidateItem.content !== "string") {
			throw new Error(t("error.itemContent", { label }));
		}
		if (candidateItem.kind === "slot" && typeof candidateItem.slot !== "string") {
			throw new Error(t("error.itemSlot", { label }));
		}
	});
}

function replaceObject(target: EditorPromptStack, source: EditorPromptStack): void {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, source);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

defineExpose({
	getError: () => stackError.value,
	reset,
});
</script>

<template>
	<div class="tab-section">
		<div class="tab-section-title">{{ t("stackTab.contextOptions") }}</div>
		<div class="tab-section-meta">
			{{ t("stackTab.contextMeta") }}
		</div>
		<label
			class="checkline"
			:title="t('stackTab.allowDuplicateTitle')"
		>
			<input
				id="allowDuplicateChatHistoryInput"
				type="checkbox"
				:checked="props.stack.context?.allowDuplicateChatHistory === true"
				@change="setAllowDuplicateChatHistory"
			>
			{{ t("stackTab.allowDuplicate") }}
		</label>
		<div class="option-note">
			{{ t("stackTab.allowDuplicateNote") }}
		</div>
		<label
			class="checkline"
			:title="t('stackTab.mergeTitle')"
		>
			<input
				id="mergeConsecutiveRolesInput"
				type="checkbox"
				:checked="props.stack.context?.mergeConsecutiveRoles === true"
				@change="setMergeConsecutiveRoles"
			>
			{{ t("stackTab.merge") }}
		</label>
		<div class="option-note">
			{{ t("stackTab.mergeNote") }}
		</div>
		<template v-if="mergeEnabled">
			<label
				class="checkline"
				:title="t('stackTab.customMergeSeparatorTitle')"
			>
				<input
					id="customMergeSeparatorInput"
					type="checkbox"
					:checked="customSeparatorEnabled"
					@change="setCustomMergeSeparator"
				>
				{{ t("stackTab.customMergeSeparator") }}
			</label>
			<label class="field" for="mergeSeparatorInput">
				<span class="field-label">{{ t("stackTab.mergeSeparator") }}</span>
				<textarea
					id="mergeSeparatorInput"
					rows="2"
					:placeholder="t('stackTab.mergeSeparatorPlaceholder')"
					:value="props.stack.context?.mergeSeparator ?? '\n\n'"
					:disabled="!customSeparatorEnabled"
					@change="setMergeSeparator"
				></textarea>
			</label>
			<div class="option-note">
				{{ t("stackTab.mergeSeparatorNote") }}
			</div>
		</template>
	</div>

	<div class="tab-section">
		<div class="tab-section-title">{{ t("stackTab.extensions") }}</div>
		<div class="tab-section-meta">{{ t("stackTab.extensionsMeta") }}</div>
		<div class="extension-catalog-grid">
			<div id="macroCatalog" class="extension-catalog">
				<strong>{{ t("stackTab.registeredMacros") }}</strong>
				<div v-if="props.resources.macros.length === 0" class="option-note">{{ t("common.none") }}</div>
				<div v-for="macro in props.resources.macros" :key="macro.name" class="extension-catalog-entry">
					<code v-text="`{{ extensions.${macro.name} }}`"></code>
					<span>{{ macro.description || macro.source || "" }}</span>
				</div>
			</div>
			<div id="slotCatalog" class="extension-catalog">
				<strong>{{ t("stackTab.availableSlots") }}</strong>
				<div v-if="props.resources.slots.length === 0" class="option-note">{{ t("common.none") }}</div>
				<div v-for="slot in props.resources.slots" :key="slot.name" class="extension-catalog-entry">
					<code>{{ slot.name }}</code>
					<span>{{ slot.description || slot.source || "" }}</span>
				</div>
			</div>
		</div>
	</div>

	<div class="tab-section">
		<div class="tab-section-title">{{ t("stackTab.parameters") }}</div>
		<div class="tab-section-meta">
			{{ t("stackTab.parametersMetaPre") }}<code>parameters</code>{{ t("stackTab.parametersMetaMid") }}<code>variables</code>{{ t("stackTab.parametersMetaPost") }}
		</div>
		<div class="modal-toolbar">
			<button id="addVariableBtn" data-icon="+" :title="t('stackTab.addVariableTitle')" type="button" @click="addVariable">
				{{ t("stackTab.addVariable") }}
			</button>
			<span class="modal-spacer"></span>
			<span class="modal-meta">{{ t("stackTab.variablesSavedNote") }}</span>
		</div>
		<div id="variablesRows" class="data-table">
			<div :class="['data-row', 'header', 'variable-row', { 'parameter-row': props.stack.schemaVersion === 2 }]">
				<div>{{ t("item.name") }}</div>
				<div>{{ t("stackTab.value") }}</div>
				<div v-if="props.stack.schemaVersion === 2">{{ t("stackTab.valueType") }}</div>
				<div></div>
			</div>
			<div
				v-for="(row, index) in variableRows"
				:key="row.key"
				:class="['data-row', 'variable-row', { 'parameter-row': props.stack.schemaVersion === 2 }]"
				data-var-row
			>
				<input v-model="row.name" data-var-name placeholder="char" @input="syncVariables">
				<input v-model="row.value" data-var-value placeholder="泉此方" @input="syncVariables">
				<select
					v-if="props.stack.schemaVersion === 2"
					data-var-format
					:value="row.format"
					@change="setVariableFormat(row, ($event.target as HTMLSelectElement).value as 'text' | 'json')"
				>
					<option value="text">{{ t("stackTab.textValue") }}</option>
					<option value="json">JSON</option>
				</select>
				<button
					type="button"
					class="danger"
					data-delete-row="true"
					data-icon="×"
					:title="t('stackTab.deleteVariableTitle')"
					@click="deleteVariable(index)"
				>
					{{ t("stackTab.deleteVariable") }}
				</button>
			</div>
		</div>
	</div>

	<div class="tab-section">
		<div class="tab-section-title">{{ t("stackTab.stackJson") }}</div>
		<div class="tab-section-meta">
			{{ t("stackTab.stackJsonMeta") }}
		</div>
		<div class="modal-toolbar">
			<button id="copyStackJsonBtn" data-icon="□" :title="t('stackTab.copyJsonTitle')" type="button" @click="copyRawJson">
				{{ t("inspector.copy") }}
			</button>
			<button
				id="applyStackJsonBtn"
				class="primary"
				data-icon="✓"
				:title="t('stackTab.applyJsonTitle')"
				type="button"
				@click="applyRawJson"
			>
				{{ t("stackTab.applyJson") }}
			</button>
			<span class="modal-spacer"></span>
			<span id="stackJsonStatus" class="modal-meta">{{ rawJsonStatus }}</span>
		</div>
		<textarea
			id="stackJsonText"
			v-model="rawJsonText"
			class="raw-json-editor"
			spellcheck="false"
		></textarea>
	</div>
</template>
