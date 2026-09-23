<script setup lang="ts">
import { reactive, ref, useId, watch } from "vue";

import { t } from "../i18n.ts";
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
	return field.keyLabel ?? t("schema.key");
}

function recordKeyOptions(field: SchemaField, row?: RecordRow): Array<{ value: string; label: string }> {
	const rows = recordRows[field.key] ?? [];
	const used = new Set(rows.filter((candidate) => candidate !== row).map((candidate) => candidate.key));
	const options = (field.keyOptions ?? []).map((option) => typeof option === "string"
		? { value: option, label: option }
		: { value: option.value, label: option.label ?? option.value });
	if (row?.key && !options.some((option) => option.value === row.key)) {
		options.push({ value: row.key, label: t("schema.keyUnavailable", { key: row.key }) });
	}
	return options.filter((option) => !used.has(option.value));
}

function canAddRecordRow(field: SchemaField): boolean {
	return field.keyOptions === undefined || recordKeyOptions(field).length > 0;
}

function addRecordRow(field: SchemaField): void {
	const rows = (recordRows[field.key] ??= []);
	const existing = new Set(rows.map((row) => row.key.trim()).filter(Boolean));
	let key: string;
	if (field.keyOptions !== undefined) {
		const option = recordKeyOptions(field)[0];
		if (!option) {
			emit("status", t("schema.allHaveEntries", { key: recordKeyLabel(field).toLowerCase() }), "error");
			return;
		}
		key = option.value;
	} else {
		const base = field.keyPlaceholder || "entry";
		key = base;
		let suffix = 2;
		while (existing.has(key)) key = `${base}-${suffix++}`;
	}
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
			collision ||= t("schema.needKey");
			continue;
		}
		if (seen.has(key)) {
			collision ||= t("schema.uniqueKeys");
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

const baseId = useId();

function fieldId(key: string): string {
	return `${baseId}-fld-${encodeURIComponent(key)}`;
}

function errorId(key: string): string {
	return `${baseId}-err-${encodeURIComponent(key)}`;
}

function recordRowFieldId(fieldKey: string, rowId: number, rowFieldKey: string): string {
	return `${baseId}-rec-${encodeURIComponent(JSON.stringify([fieldKey, rowId, rowFieldKey]))}`;
}

function recordRowErrorId(fieldKey: string, rowId: number, rowFieldKey: string): string {
	return `${baseId}-rec-err-${encodeURIComponent(JSON.stringify([fieldKey, rowId, rowFieldKey]))}`;
}

function recordRowKeyId(fieldKey: string, rowId: number): string {
	return `${baseId}-rec-key-${encodeURIComponent(JSON.stringify([fieldKey, rowId]))}`;
}
</script>

<template>
	<div class="schema-form">
		<div class="schema-form-header">
			<div>
				<div v-if="props.schema.title" class="tab-section-title">{{ props.schema.title }}</div>
				<div v-if="props.schema.description" class="tab-section-meta">{{ props.schema.description }}</div>
			</div>
			<div class="schema-autosave-note">
				<span class="schema-autosave-dot">●</span>
				{{ t("polish.surfaces.settingsAutosaveNotice") }}
			</div>
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
				<label class="checkline" :for="fieldId(field.key)">
					<input
						:id="fieldId(field.key)"
						type="checkbox"
						:data-field-input="field.key"
						:checked="booleanValue(field)"
						:aria-invalid="errors[field.key] ? 'true' : undefined"
						:aria-describedby="errors[field.key] ? errorId(field.key) : undefined"
						@change="setBoolean(field, $event)"
					>
					{{ field.label }}
				</label>
				<div :id="errorId(field.key)" v-if="errors[field.key]" class="schema-field-error" data-field-error role="alert">{{ errors[field.key] }}</div>
			</div>

			<!-- string -->
			<div v-else-if="field.type === 'string'" class="field">
				<label :for="fieldId(field.key)">{{ field.label }}</label>
				<input
					:id="fieldId(field.key)"
					type="text"
					:data-field-input="field.key"
					:value="stringValue(field)"
					:placeholder="placeholder(field)"
					:aria-invalid="errors[field.key] ? 'true' : undefined"
					:aria-describedby="errors[field.key] ? errorId(field.key) : undefined"
					@input="setString(field, $event)"
				>
				<div :id="errorId(field.key)" v-if="errors[field.key]" class="schema-field-error" data-field-error role="alert">{{ errors[field.key] }}</div>
			</div>

			<!-- number -->
			<div v-else-if="field.type === 'number'" class="field">
				<label :for="fieldId(field.key)">{{ field.label }}</label>
				<input
					:id="fieldId(field.key)"
					type="number"
					:data-field-input="field.key"
					:value="numberValue(field)"
					:min="field.min"
					:max="field.max"
					:placeholder="placeholder(field)"
					:aria-invalid="errors[field.key] ? 'true' : undefined"
					:aria-describedby="errors[field.key] ? errorId(field.key) : undefined"
					@input="setNumber(field, $event)"
				>
				<div :id="errorId(field.key)" v-if="errors[field.key]" class="schema-field-error" data-field-error role="alert">{{ errors[field.key] }}</div>
			</div>

			<!-- enum -->
			<div v-else-if="field.type === 'enum'" class="field">
				<label :for="fieldId(field.key)">{{ field.label }}</label>
				<select
					:id="fieldId(field.key)"
					:data-field-input="field.key"
					:value="enumValue(field)"
					:aria-invalid="errors[field.key] ? 'true' : undefined"
					:aria-describedby="errors[field.key] ? errorId(field.key) : undefined"
					@change="setEnum(field, $event)"
				>
					<option
						v-for="option in enumOptions(field)"
						:key="option.value"
						:value="option.value"
					>{{ option.label || option.value }}</option>
				</select>
				<div :id="errorId(field.key)" v-if="errors[field.key]" class="schema-field-error" data-field-error role="alert">{{ errors[field.key] }}</div>
			</div>

			<!-- record (per-profile table) -->
			<div v-else-if="field.type === 'record'" class="field">
				<label>{{ field.label }}</label>
				<div class="modal-toolbar">
					<button
						type="button"
						data-icon="+"
						:data-add-record="field.key"
						:title="t('schema.addEntryTitle', { key: recordKeyLabel(field).toLowerCase() })"
						:disabled="!canAddRecordRow(field)"
						@click="addRecordRow(field)"
					>
						{{ t("schema.addEntry") }}
					</button>
					<span class="modal-spacer"></span>
					<span class="modal-meta">{{ t("schema.oneEntryPer", { key: recordKeyLabel(field).toLowerCase() }) }}</span>
				</div>
				<div :id="errorId(field.key)" v-if="errors[field.key]" class="schema-field-error" data-field-error role="alert">{{ errors[field.key] }}</div>
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
						<select
							v-if="field.keyOptions !== undefined"
							:id="recordRowKeyId(field.key, row.__id)"
							:data-record-key="field.key"
							:aria-label="recordKeyLabel(field)"
							:value="row.key"
							@change="setRecordRowKey(field, index, $event)"
						>
							<option
								v-for="option in recordKeyOptions(field, row)"
								:key="option.value"
								:value="option.value"
							>{{ option.label }}</option>
						</select>
						<input
							v-else
							type="text"
								:id="recordRowKeyId(field.key, row.__id)"
								:data-record-key="field.key"
								:aria-label="recordKeyLabel(field)"
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
							<label v-if="rowField.type !== 'boolean'" class="record-cell-label" :for="recordRowFieldId(field.key, row.__id, rowField.key)">{{ rowField.label }}</label>
							<label v-if="rowField.type === 'boolean'" class="checkline" :for="recordRowFieldId(field.key, row.__id, rowField.key)">
								<input
									:id="recordRowFieldId(field.key, row.__id, rowField.key)"
									type="checkbox"
									:data-record-input="`${field.key}.${row.key}.${rowField.key}`"
									:checked="recordCellBoolean(row, rowField)"
									:aria-invalid="recordRowError(field, row, rowField) ? 'true' : undefined"
									:aria-describedby="recordRowError(field, row, rowField) ? recordRowErrorId(field.key, row.__id, rowField.key) : undefined"
									@change="setRecordCellBoolean(field, row, rowField, $event)"
								>
								{{ rowField.label }}
							</label>
							<select
								v-else-if="rowField.type === 'enum'"
								:id="recordRowFieldId(field.key, row.__id, rowField.key)"
								:data-record-input="`${field.key}.${row.key}.${rowField.key}`"
								:value="recordCellEnum(row, rowField)"
								:aria-invalid="recordRowError(field, row, rowField) ? 'true' : undefined"
								:aria-describedby="recordRowError(field, row, rowField) ? recordRowErrorId(field.key, row.__id, rowField.key) : undefined"
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
								:id="recordRowFieldId(field.key, row.__id, rowField.key)"
								type="number"
								:data-record-input="`${field.key}.${row.key}.${rowField.key}`"
								:value="recordCellText(row, rowField)"
								:min="rowField.min"
								:max="rowField.max"
								:aria-invalid="recordRowError(field, row, rowField) ? 'true' : undefined"
								:aria-describedby="recordRowError(field, row, rowField) ? recordRowErrorId(field.key, row.__id, rowField.key) : undefined"
								@input="setRecordCellNumber(field, row, rowField, $event)"
							>
							<input
								v-else
								:id="recordRowFieldId(field.key, row.__id, rowField.key)"
								type="text"
								:data-record-input="`${field.key}.${row.key}.${rowField.key}`"
								:value="recordCellText(row, rowField)"
								:placeholder="rowField.placeholder"
								:aria-invalid="recordRowError(field, row, rowField) ? 'true' : undefined"
								:aria-describedby="recordRowError(field, row, rowField) ? recordRowErrorId(field.key, row.__id, rowField.key) : undefined"
								@input="setRecordCellString(field, row, rowField, $event)"
							>
							<div
								v-if="recordRowError(field, row, rowField)"
								:id="recordRowErrorId(field.key, row.__id, rowField.key)"
								class="schema-field-error"
								data-field-error
								role="alert"
							>{{ recordRowError(field, row, rowField) }}</div>
						</div>
						<div>
							<button
								type="button"
								class="danger"
								data-icon="×"
								:data-delete-record="field.key"
								:title="t('schema.deleteEntryTitle')"
								@click="removeRecordRow(field, index)"
							>
								{{ t("common.delete") }}
							</button>
						</div>
					</div>
					<div v-if="!(recordRows[field.key] ?? []).length" class="record-empty">
						{{ t("schema.noEntries") }}
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.schema-form-header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 8px;
}

.schema-autosave-note {
	font-size: 11px;
	color: var(--muted);
	display: inline-flex;
	align-items: center;
	gap: 5px;
	white-space: nowrap;
	padding: 2px 8px;
	border-radius: 4px;
	background: var(--pane-soft, rgba(0, 0, 0, 0.03));
}

.schema-autosave-dot {
	color: var(--accent);
	font-size: 8px;
}

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

.record-cell-label {
	display: none;
}

@media (max-width: 700px) {
	.schema-record-row {
		grid-template-columns: minmax(0, 1fr);
	}

	.schema-record-row.header {
		display: none;
	}

	.record-cell-label {
		display: block;
	}
}
</style>
