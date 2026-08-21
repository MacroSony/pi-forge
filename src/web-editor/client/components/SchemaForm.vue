<script setup lang="ts">
import { reactive, ref, watch } from "vue";

import type { FormSchema, FormValues, SchemaField } from "../../schema-form.ts";
import {
	defaultValueForField,
	enumOptions,
	isPlainObject,
	validateValues,
} from "../../schema-form.ts";

interface RecordRow {
	__id: number;
	key: string;
	value: Record<string, unknown>;
}

const props = defineProps<{
	schema: FormSchema;
	values: FormValues;
}>();

const emit = defineEmits<{
	change: [error: string, values: FormValues];
	status: [text: string, tone?: string];
}>();

const recordRows = reactive<Record<string, RecordRow[]>>({});
const recordCollisions = reactive<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
let nextRecordId = 1;

function recordRowsForField(field: SchemaField): RecordRow[] {
	const record = props.values[field.key];
	const rows: RecordRow[] = [];
	if (isPlainObject(record)) {
		for (const [key, value] of Object.entries(record)) {
			rows.push({
				__id: nextRecordId++,
				key,
				value: isPlainObject(value) ? { ...value } : {},
			});
		}
	}
	return rows;
}

function initRecordRows(): void {
	for (const field of props.schema.fields) {
		if (field.type === "record") {
			recordRows[field.key] = recordRowsForField(field);
		}
	}
}
initRecordRows();

function report(): void {
	const validation = validateValues(props.schema, props.values);
	const merged: Record<string, string> = { ...validation.errors };
	for (const [key, message] of Object.entries(recordCollisions)) {
		if (message) merged[key] = message;
	}
	errors.value = merged;
	const first = Object.keys(merged)[0] ? merged[Object.keys(merged)[0]!] : "";
	emit("change", first, props.values);
}

watch(
	() => props.values,
	() => report(),
	{ deep: true, flush: "sync" },
);

// Initial validation only — the host treats the freshly mounted form as clean
// until the first real edit.
errors.value = { ...validateValues(props.schema, props.values).errors };

// --- scalar controls ---------------------------------------------------------

function setBoolean(field: SchemaField, event: Event): void {
	props.values[field.key] = (event.target as HTMLInputElement).checked;
}

function setString(field: SchemaField, event: Event): void {
	props.values[field.key] = (event.target as HTMLInputElement).value;
}

function setNumber(field: SchemaField, event: Event): void {
	const raw = (event.target as HTMLInputElement).value;
	const num = Number(raw);
	props.values[field.key] = raw === "" ? "" : Number.isFinite(num) ? num : raw;
}

function setEnum(field: SchemaField, event: Event): void {
	props.values[field.key] = (event.target as HTMLSelectElement).value;
}

function stringValue(field: SchemaField): string {
	const value = props.values[field.key];
	return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function numberValue(field: SchemaField): string | number {
	const value = props.values[field.key];
	if (value === undefined || value === null || value === "") return "";
	return String(value);
}

function enumValue(field: SchemaField): string {
	const value = props.values[field.key];
	return typeof value === "string" ? value : (enumOptions(field)[0]?.value ?? "");
}

function booleanValue(field: SchemaField): boolean {
	return props.values[field.key] === true;
}

function placeholder(field: SchemaField): string {
	return field.placeholder ?? "";
}

// --- record (per-profile table) controls -------------------------------------

function recordKeyLabel(field: SchemaField): string {
	return field.keyLabel ?? "Key";
}

function addRecordRow(field: SchemaField): void {
	const rows = (recordRows[field.key] ??= []);
	const base = field.keyPlaceholder || "entry";
	const existing = new Set(rows.map((row) => row.key.trim()).filter(Boolean));
	let key = base;
	let suffix = 2;
	while (existing.has(key)) key = `${base}-${suffix++}`;
	const value: Record<string, unknown> = {};
	for (const rowField of field.recordFields ?? []) {
		value[rowField.key] = defaultValueForField(rowField);
	}
	rows.push({ __id: nextRecordId++, key, value });
	syncRecord(field);
}

function removeRecordRow(field: SchemaField, index: number): void {
	const rows = recordRows[field.key];
	if (!rows) return;
	rows.splice(index, 1);
	syncRecord(field);
}

function setRecordRowKey(field: SchemaField, index: number, event: Event): void {
	const rows = recordRows[field.key];
	if (!rows) return;
	rows[index]!.key = (event.target as HTMLInputElement).value;
	syncRecord(field);
}

function syncRecord(field: SchemaField): void {
	const rows = recordRows[field.key] ?? [];
	const next: Record<string, unknown> = {};
	const seen = new Set<string>();
	let collision = "";
	for (const row of rows) {
		const key = row.key.trim();
		if (!key) {
			collision ||= "Every entry needs a key.";
			continue;
		}
		if (seen.has(key)) {
			collision ||= "Entry keys must be unique.";
			continue;
		}
		seen.add(key);
		next[key] = { ...row.value };
	}
	if (collision) {
		// No values mutation happened, so report the collision directly.
		recordCollisions[field.key] = collision;
		report();
		return;
	}
	delete recordCollisions[field.key];
	// Committing the rebuilt table mutates props.values; the deep watcher
	// revalidates and emits the change.
	props.values[field.key] = next;
}

function recordCellText(row: RecordRow, rowField: SchemaField): string | number {
	const value = row.value[rowField.key];
	if (value === undefined || value === null || value === "") return "";
	return String(value);
}

function recordCellBoolean(row: RecordRow, rowField: SchemaField): boolean {
	return row.value[rowField.key] === true;
}

function recordCellEnum(row: RecordRow, rowField: SchemaField): string {
	const value = row.value[rowField.key];
	return typeof value === "string" ? value : (enumOptions(rowField)[0]?.value ?? "");
}

function setRecordCellString(field: SchemaField, row: RecordRow, rowField: SchemaField, event: Event): void {
	row.value[rowField.key] = (event.target as HTMLInputElement).value;
	syncRecord(field);
}

function setRecordCellNumber(field: SchemaField, row: RecordRow, rowField: SchemaField, event: Event): void {
	const raw = (event.target as HTMLInputElement).value;
	const num = Number(raw);
	row.value[rowField.key] = raw === "" ? "" : Number.isFinite(num) ? num : raw;
	syncRecord(field);
}

function setRecordCellEnum(field: SchemaField, row: RecordRow, rowField: SchemaField, event: Event): void {
	row.value[rowField.key] = (event.target as HTMLSelectElement).value;
	syncRecord(field);
}

function setRecordCellBoolean(field: SchemaField, row: RecordRow, rowField: SchemaField, event: Event): void {
	row.value[rowField.key] = (event.target as HTMLInputElement).checked;
	syncRecord(field);
}

function recordRowError(field: SchemaField, row: RecordRow, rowField: SchemaField): string {
	return errors.value[`${field.key}.${row.key}.${rowField.key}`] ?? "";
}
</script>

<template>
	<div class="schema-form">
		<div>
			<div v-if="props.schema.title" class="tab-section-title">{{ props.schema.title }}</div>
			<div v-if="props.schema.description" class="tab-section-meta">{{ props.schema.description }}</div>
		</div>

		<div
			v-for="field in props.schema.fields"
			:key="field.key"
			class="tab-section schema-field"
			:data-field="field.key"
		>
			<div v-if="field.description" class="tab-section-meta">{{ field.description }}</div>

			<!-- boolean -->
			<div v-if="field.type === 'boolean'" class="field">
				<label class="checkline">
					<input
						type="checkbox"
						:data-field-input="field.key"
						:checked="booleanValue(field)"
						@change="setBoolean(field, $event)"
					>
					{{ field.label }}
				</label>
			</div>

			<!-- string -->
			<div v-else-if="field.type === 'string'" class="field">
				<label>{{ field.label }}</label>
				<input
					type="text"
					:data-field-input="field.key"
					:value="stringValue(field)"
					:placeholder="placeholder(field)"
					@input="setString(field, $event)"
				>
				<div v-if="errors[field.key]" class="schema-field-error" data-field-error>{{ errors[field.key] }}</div>
			</div>

			<!-- number -->
			<div v-else-if="field.type === 'number'" class="field">
				<label>{{ field.label }}</label>
				<input
					type="number"
					:data-field-input="field.key"
					:value="numberValue(field)"
					:min="field.min"
					:max="field.max"
					:placeholder="placeholder(field)"
					@input="setNumber(field, $event)"
				>
				<div v-if="errors[field.key]" class="schema-field-error" data-field-error>{{ errors[field.key] }}</div>
			</div>

			<!-- enum -->
			<div v-else-if="field.type === 'enum'" class="field">
				<label>{{ field.label }}</label>
				<select
					:data-field-input="field.key"
					:value="enumValue(field)"
					@change="setEnum(field, $event)"
				>
					<option
						v-for="option in enumOptions(field)"
						:key="option.value"
						:value="option.value"
					>{{ option.label || option.value }}</option>
				</select>
				<div v-if="errors[field.key]" class="schema-field-error" data-field-error>{{ errors[field.key] }}</div>
			</div>

			<!-- record (per-profile table) -->
			<div v-else-if="field.type === 'record'" class="field">
				<label>{{ field.label }}</label>
				<div class="modal-toolbar">
					<button
						type="button"
						data-icon="+"
						:data-add-record="field.key"
						:title="`Add a ${recordKeyLabel(field).toLowerCase()} entry`"
						@click="addRecordRow(field)"
					>
						Add entry
					</button>
					<span class="modal-spacer"></span>
					<span class="modal-meta">One entry per {{ recordKeyLabel(field).toLowerCase() }}.</span>
				</div>
				<div v-if="errors[field.key]" class="schema-field-error" data-field-error>{{ errors[field.key] }}</div>
				<div class="data-table" :data-record-table="field.key">
					<div class="data-row header schema-record-row">
						<div>{{ recordKeyLabel(field) }}</div>
						<div
							v-for="rowField in field.recordFields ?? []"
							:key="rowField.key"
						>{{ rowField.label }}</div>
						<div></div>
					</div>
					<div
						v-for="(row, index) in recordRows[field.key] ?? []"
						:key="row.__id"
						class="data-row schema-record-row"
						:data-record-row="index"
					>
						<div class="field">
							<input
								type="text"
								:data-record-key="field.key"
								:value="row.key"
								:placeholder="field.keyPlaceholder"
								@input="setRecordRowKey(field, index, $event)"
							>
						</div>
						<div
							v-for="rowField in field.recordFields ?? []"
							:key="rowField.key"
							class="field"
						>
							<label v-if="rowField.type === 'boolean'" class="checkline">
								<input
									type="checkbox"
									:data-record-input="`${field.key}.${row.key}.${rowField.key}`"
									:checked="recordCellBoolean(row, rowField)"
									@change="setRecordCellBoolean(field, row, rowField, $event)"
								>
								{{ rowField.label }}
							</label>
							<select
								v-else-if="rowField.type === 'enum'"
								:data-record-input="`${field.key}.${row.key}.${rowField.key}`"
								:value="recordCellEnum(row, rowField)"
								@change="setRecordCellEnum(field, row, rowField, $event)"
							>
								<option
									v-for="option in enumOptions(rowField)"
									:key="option.value"
									:value="option.value"
								>{{ option.label || option.value }}</option>
							</select>
							<input
								v-else-if="rowField.type === 'number'"
								type="number"
								:data-record-input="`${field.key}.${row.key}.${rowField.key}`"
								:value="recordCellText(row, rowField)"
								:min="rowField.min"
								:max="rowField.max"
								@input="setRecordCellNumber(field, row, rowField, $event)"
							>
							<input
								v-else
								type="text"
								:data-record-input="`${field.key}.${row.key}.${rowField.key}`"
								:value="recordCellText(row, rowField)"
								:placeholder="rowField.placeholder"
								@input="setRecordCellString(field, row, rowField, $event)"
							>
							<div
								v-if="recordRowError(field, row, rowField)"
								class="schema-field-error"
								data-field-error
							>{{ recordRowError(field, row, rowField) }}</div>
						</div>
						<div>
							<button
								type="button"
								class="danger"
								data-icon="×"
								:data-delete-record="field.key"
								:title="`Delete this entry`"
								@click="removeRecordRow(field, index)"
							>
								Delete
							</button>
						</div>
					</div>
					<div v-if="!(recordRows[field.key] ?? []).length" class="record-empty">
						No entries yet.
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.schema-record-row {
	grid-template-columns: minmax(150px, 220px) repeat(auto-fit, minmax(150px, 1fr)) 92px;
}

.record-empty {
	color: var(--muted);
	font-size: 12px;
	padding: 8px 0;
}

.schema-field-error {
	color: var(--error);
	font-size: 12px;
	margin-top: 4px;
}
</style>
