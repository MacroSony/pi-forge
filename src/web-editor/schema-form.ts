// Pure schema-driven settings-form model for the web editor.
//
// This module deliberately ships no Vue or DOM dependency so the functions can
// be unit-tested under Node and shared by the self-contained SchemaForm.vue
// renderer and its vue-host bridge. v1 field types: boolean, number, enum,
// string, and record (a keyed table of entries — the per-profile shape).

export type SchemaFieldType = "boolean" | "number" | "enum" | "string" | "record";

export interface SchemaEnumOption {
	value: string;
	label?: string;
}

export interface SchemaField {
	/** Stable field key; also the property name inside the values object. */
	key: string;
	/** Human-readable field label. */
	label: string;
	type: SchemaFieldType;
	description?: string;
	required?: boolean;
	default?: unknown;
	/** enum: allowed values, as plain strings or {value,label}. */
	options?: readonly (string | SchemaEnumOption)[];
	/** number: inclusive bounds. */
	min?: number;
	max?: number;
	/** string: maximum length. */
	maxLength?: number;
	/** string: RegExp source the value must match. */
	pattern?: string;
	/** Input placeholder. */
	placeholder?: string;
	/** record: per-entry (row) column schema. */
	recordFields?: readonly SchemaField[];
	/** record: label for the row-key column. */
	keyLabel?: string;
	/** record: placeholder hint for row keys. */
	keyPlaceholder?: string;
}

export interface FormSchema {
	title?: string;
	description?: string;
	fields: readonly SchemaField[];
}

export type FormValues = Record<string, unknown>;

export interface FormValidation {
	/** Field key -> first error, plus dotted paths for record rows. */
	errors: Record<string, string>;
}

export function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalizes enum option lists to a uniform {value,label} shape. */
export function enumOptions(field: SchemaField): readonly { value: string; label: string }[] {
	const options = field.options ?? [];
	return options.map((option) => {
		if (typeof option === "string") return { value: option, label: option };
		return { value: option.value, label: option.label ?? option.value };
	});
}

export function defaultValueForField(field: SchemaField): unknown {
	if (field.default !== undefined) return cloneJson(field.default);
	switch (field.type) {
		case "boolean":
			return false;
		case "number":
			return 0;
		case "enum":
			return enumOptions(field)[0]?.value ?? "";
		case "string":
			return "";
		case "record":
			return {};
	}
}

/** Builds a complete values object with every field present and defaulted. */
export function defaultValues(schema: FormSchema): FormValues {
	const values: FormValues = {};
	for (const field of schema.fields) {
		values[field.key] = defaultValueForField(field);
	}
	return values;
}

/** Shortcut used by default: copy values from the source, but only schema keys. */
export function normalizeValues(schema: FormSchema, values: FormValues): FormValues {
	const result = defaultValues(schema);
	for (const field of schema.fields) {
		if (values[field.key] !== undefined) {
			result[field.key] = coerceFieldValue(field, values[field.key]);
		}
	}
	return result;
}

/** Produces clean, typed values from possibly-raw form state. */
export function coerceValues(schema: FormSchema, values: FormValues): FormValues {
	const result: FormValues = {};
	for (const field of schema.fields) {
		result[field.key] = coerceFieldValue(field, values[field.key]);
	}
	return result;
}

export function coerceFieldValue(field: SchemaField, value: unknown): unknown {
	switch (field.type) {
		case "boolean":
			return value === true || value === 1 || value === "true" || value === "1";
		case "number": {
			if (value === "" || value === null || value === undefined) return undefined;
			const num = typeof value === "number" ? value : Number(value);
			return Number.isFinite(num) ? num : undefined;
		}
		case "string":
			return value === null || value === undefined ? "" : String(value);
		case "enum":
			if (typeof value === "string" && enumOptions(field).some((option) => option.value === value)) {
				return value;
			}
			return enumOptions(field)[0]?.value ?? "";
		case "record":
			return coerceRecordValue(field, value);
	}
}

export function validateValues(schema: FormSchema, values: FormValues): FormValidation {
	const errors: Record<string, string> = {};
	for (const field of schema.fields) {
		if (field.type === "record") {
			validateRecordFieldInto(field, values[field.key], field.key, errors);
		} else {
			const fieldError = validateField(field, values[field.key]);
			if (fieldError) errors[field.key] = fieldError;
		}
	}
	return { errors };
}

/** First error message, in schema traversal order. */
export function firstError(validation: FormValidation): string {
	const entries = Object.entries(validation.errors);
	return entries.length > 0 ? entries[0][1] : "";
}

function validateField(field: SchemaField, value: unknown): string {
	switch (field.type) {
		case "boolean":
			return "";
		case "number":
			return validateNumberField(field, value);
		case "enum":
			return validateEnumField(field, value);
		case "string":
			return validateStringField(field, value);
		case "record":
			return "";
	}
}

function validateNumberField(field: SchemaField, value: unknown): string {
	const label = field.label;
	if (value === "" || value === null || value === undefined) {
		return field.required ? `${label} is required.` : "";
	}
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num)) return `${label} must be a number.`;
	if (field.min !== undefined && num < field.min) {
		return field.max !== undefined
			? `${label} must be between ${field.min} and ${field.max}.`
			: `${label} must be at least ${field.min}.`;
	}
	if (field.max !== undefined && num > field.max) {
		return field.min !== undefined
			? `${label} must be between ${field.min} and ${field.max}.`
			: `${label} must be at most ${field.max}.`;
	}
	return "";
}

function validateEnumField(field: SchemaField, value: unknown): string {
	if (typeof value !== "string" || !value) {
		return field.required ? `${field.label} is required.` : "";
	}
	if (!enumOptions(field).some((option) => option.value === value)) {
		return `${field.label} has an invalid value.`;
	}
	return "";
}

function validateStringField(field: SchemaField, value: unknown): string {
	if (value === null || value === undefined || value === "") {
		return field.required ? `${field.label} is required.` : "";
	}
	const text = String(value);
	if (field.maxLength !== undefined && text.length > field.maxLength) {
		return `${field.label} must be at most ${field.maxLength} characters.`;
	}
	if (field.pattern) {
		try {
			if (!new RegExp(field.pattern).test(text)) {
				return `${field.label} does not match the required format.`;
			}
		} catch {
			// Malformed pattern in the schema: treat as unconstrained.
		}
	}
	return "";
}

function validateRecordFieldInto(
	field: SchemaField,
	value: unknown,
	path: string,
	errors: Record<string, string>,
): void {
	if (!isPlainObject(value)) {
		errors[path] = "Must be a table of entries.";
		return;
	}
	const seen = new Set<string>();
	for (const [rowKey, rowValue] of Object.entries(value)) {
		const rowPath = `${path}.${rowKey}`;
		const key = rowKey.trim();
		if (!key) {
			errors[path] = errors[path] ?? "Every entry needs a key.";
			return;
		}
		if (seen.has(key)) {
			errors[path] = errors[path] ?? "Entry keys must be unique.";
			return;
		}
		seen.add(key);
		if (!isPlainObject(rowValue)) {
			errors[rowPath] = "Must be an object.";
			continue;
		}
		for (const rowField of field.recordFields ?? []) {
			const rowFieldError = validateField(rowField, rowValue[rowField.key]);
			if (rowFieldError) errors[`${rowPath}.${rowField.key}`] = rowFieldError;
		}
	}
}

function coerceRecordValue(
	field: SchemaField,
	value: unknown,
): Record<string, Record<string, unknown>> {
	if (!isPlainObject(value)) return {};
	const result: Record<string, Record<string, unknown>> = {};
	for (const [rowKey, rowValue] of Object.entries(value)) {
		const key = rowKey.trim();
		if (!key) continue;
		const row = isPlainObject(rowValue) ? rowValue : {};
		const coercedRow: Record<string, unknown> = {};
		for (const rowField of field.recordFields ?? []) {
			coercedRow[rowField.key] = coerceFieldValue(rowField, row[rowField.key]);
		}
		result[key] = coercedRow;
	}
	return result;
}
