<script setup lang="ts">
import { ref, watch } from "vue";

import type { EditorPromptStack } from "../types.ts";

interface VariableRow {
	key: number;
	name: string;
	value: string;
}

const props = defineProps<{
	stack: EditorPromptStack;
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
const rawJsonStatus = ref("Unsaved stack JSON draft.");

watch(
	() => props.stack,
	() => reset(),
);

function reset(): void {
	variableRows.value = readVariableRows();
	stackError.value = "";
	rawJsonText.value = displayStackJson();
	rawJsonStatus.value = "Unsaved stack JSON draft.";
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
			value: String(value ?? ""),
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

function addVariable(): void {
	variableRows.value.push({
		key: nextVariableKey++,
		name: uniqueVariableName(),
		value: "",
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
	const variables: Record<string, string> = {};
	const seen = new Set<string>();
	let duplicate = false;
	for (const row of variableRows.value) {
		const name = row.name.trim();
		if (!name) continue;
		if (seen.has(name)) duplicate = true;
		seen.add(name);
		variables[name] = row.value;
	}
	if (props.stack.schemaVersion === 2) {
		if (Object.keys(variables).length > 0) props.stack.parameters = variables;
		else delete props.stack.parameters;
	} else {
		if (Object.keys(variables).length > 0) props.stack.variables = variables;
		else delete props.stack.variables;
	}
	stackError.value = duplicate ? "Duplicate stack variable names." : "";
	emit("change", stackError.value);
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
		rawJsonStatus.value = "Copied JSON.";
		emit("status", "Copied stack JSON", "success");
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
		rawJsonStatus.value = "Applied stack JSON to editor.";
		emit("apply");
	} catch (error) {
		const message = errorMessage(error);
		rawJsonStatus.value = message;
		emit("status", message, "error");
	}
}

function validateRawStackJson(stack: unknown): asserts stack is EditorPromptStack {
	if (!stack || typeof stack !== "object" || Array.isArray(stack)) {
		throw new Error("Stack JSON must be an object.");
	}
	const candidate = stack as Record<string, unknown>;
	if (typeof candidate.id !== "string" || !candidate.id.trim()) {
		throw new Error("Stack JSON needs a non-empty string id.");
	}
	if (!Array.isArray(candidate.items)) {
		throw new Error("Stack JSON needs an items array.");
	}
	candidate.items.forEach((item, index) => {
		const label = `Item ${index + 1}`;
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`${label} must be an object.`);
		}
		const candidateItem = item as Record<string, unknown>;
		if (candidateItem.kind !== "block" && candidateItem.kind !== "slot") {
			throw new Error(`${label} kind must be block or slot.`);
		}
		if (typeof candidateItem.id !== "string" || !candidateItem.id.trim()) {
			throw new Error(`${label} needs a non-empty string id.`);
		}
		if (candidateItem.kind === "block" && typeof candidateItem.content !== "string") {
			throw new Error(`${label} block content must be a string.`);
		}
		if (candidateItem.kind === "slot" && typeof candidateItem.slot !== "string") {
			throw new Error(`${label} slot must be a string.`);
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
		<div class="tab-section-title">Context options</div>
		<div class="tab-section-meta">
			Stack-level behavior for how pi-forge rewrites Pi conversation context.
		</div>
		<label
			class="checkline"
			title="Allow multiple enabled chat-history slots. When off, only the first enabled chat-history slot is expanded."
		>
			<input
				id="allowDuplicateChatHistoryInput"
				type="checkbox"
				:checked="props.stack.context?.allowDuplicateChatHistory === true"
				@change="setAllowDuplicateChatHistory"
			>
			Allow duplicate chat-history slots
		</label>
		<div class="option-note">
			Keep this off unless you intentionally want the same conversation history injected more than once.
		</div>
	</div>

	<div class="tab-section">
		<div class="tab-section-title">Stack parameters</div>
		<div class="tab-section-meta">
			Immutable static values; schema v2 uses <code>parameters</code>, v1 uses <code>variables</code>.
		</div>
		<div class="modal-toolbar">
			<button id="addVariableBtn" data-icon="+" title="Add a static stack variable" type="button" @click="addVariable">
				Add variable
			</button>
			<span class="modal-spacer"></span>
			<span class="modal-meta">Saved in stack.parameters (v2) / stack.variables (v1).</span>
		</div>
		<div id="variablesRows" class="data-table">
			<div class="data-row header variable-row">
				<div>Name</div>
				<div>Value</div>
				<div></div>
			</div>
			<div
				v-for="(row, index) in variableRows"
				:key="row.key"
				class="data-row variable-row"
				data-var-row
			>
				<input v-model="row.name" data-var-name placeholder="char" @input="syncVariables">
				<input v-model="row.value" data-var-value placeholder="泉此方" @input="syncVariables">
				<button
					type="button"
					class="danger"
					data-delete-row="true"
					data-icon="×"
					title="Delete this stack variable"
					@click="deleteVariable(index)"
				>
					Delete
				</button>
			</div>
		</div>
	</div>

	<div class="tab-section">
		<div class="tab-section-title">Stack JSON</div>
		<div class="tab-section-meta">
			Raw recovery view for advanced fields. Apply updates the editor; Save writes to disk.
		</div>
		<div class="modal-toolbar">
			<button id="copyStackJsonBtn" data-icon="□" title="Copy this JSON to the clipboard" type="button" @click="copyRawJson">
				Copy
			</button>
			<button
				id="applyStackJsonBtn"
				class="primary"
				data-icon="✓"
				title="Apply this JSON to the editor without saving"
				type="button"
				@click="applyRawJson"
			>
				Apply to editor
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
