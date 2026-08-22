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
    /** record: optional allowed/suggested row keys rendered as a selector. */
    keyOptions?: readonly (string | SchemaEnumOption)[];
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
export declare function cloneJson<T>(value: T): T;
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
/** Normalizes enum option lists to a uniform {value,label} shape. */
export declare function enumOptions(field: SchemaField): readonly {
    value: string;
    label: string;
}[];
export declare function defaultValueForField(field: SchemaField): unknown;
/** Builds a complete values object with every field present and defaulted. */
export declare function defaultValues(schema: FormSchema): FormValues;
/** Shortcut used by default: copy values from the source, but only schema keys. */
export declare function normalizeValues(schema: FormSchema, values: FormValues): FormValues;
/** Produces clean, typed values from possibly-raw form state. */
export declare function coerceValues(schema: FormSchema, values: FormValues): FormValues;
export declare function coerceFieldValue(field: SchemaField, value: unknown): unknown;
export declare function validateValues(schema: FormSchema, values: FormValues): FormValidation;
/** First error message, in schema traversal order. */
export declare function firstError(validation: FormValidation): string;
//# sourceMappingURL=schema-form.d.ts.map