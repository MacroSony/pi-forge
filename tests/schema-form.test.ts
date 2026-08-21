import assert from "node:assert/strict";
import test from "node:test";

import {
	coerceValues,
	defaultValueForField,
	defaultValues,
	enumOptions,
	firstError,
	isPlainObject,
	normalizeValues,
	validateValues,
	type FormSchema,
} from "../src/web-editor/schema-form.ts";

const settingsSchema: FormSchema = {
	title: "Subagent settings",
	description: "Settings for the subagent integration.",
	fields: [
		{
			key: "backend",
			label: "Backend",
			type: "enum",
			options: [
				{ value: "auto", label: "Auto" },
				"cli",
			],
		},
		{
			key: "timeoutMs",
			label: "Timeout (ms)",
			type: "number",
			required: true,
			min: 1,
			max: 600000,
		},
		{
			key: "autoApprove",
			label: "Auto-approve",
			type: "boolean",
			default: true,
		},
		{
			key: "summaryInDescription",
			label: "Summarize in description",
			type: "boolean",
		},
		{
			key: "overview",
			label: "Overview",
			type: "string",
			maxLength: 40,
			pattern: "^[a-zA-Z ]+$",
		},
		{
			key: "profiles",
			label: "Per-profile settings",
			type: "record",
			keyLabel: "Profile id",
			keyPlaceholder: "profile-id",
			recordFields: [
				{
					key: "enabled",
					label: "Enabled",
					type: "boolean",
				},
				{
					key: "backend",
					label: "Backend",
					type: "enum",
					options: ["auto", "cli"],
				},
				{
					key: "timeoutMs",
					label: "Timeout (ms)",
					type: "number",
					required: true,
					min: 1,
				},
			],
		},
	],
};

test("defaultValues covers every v1 field type with a sensible default", () => {
	const values = defaultValues(settingsSchema);
	assert.equal(values.backend, "auto");
	assert.equal(values.timeoutMs, 0);
	assert.equal(values.autoApprove, true);
	assert.equal(values.summaryInDescription, false);
	assert.equal(values.overview, "");
	assert.deepEqual(values.profiles, {});
});

test("defaultValueForField honors an explicit default and enum first option", () => {
	assert.equal(defaultValueForField({ key: "a", label: "A", type: "boolean" }), false);
	assert.equal(defaultValueForField({ key: "n", label: "N", type: "number" }), 0);
	assert.equal(
		defaultValueForField({ key: "e", label: "E", type: "enum", options: ["x", "y"] }),
		"x",
	);
	assert.equal(defaultValueForField({ key: "s", label: "S", type: "string" }), "");
	assert.deepEqual(defaultValueForField({ key: "r", label: "R", type: "record" }), {});
	assert.equal(
		defaultValueForField({ key: "b", label: "B", type: "boolean", default: true }),
		true,
	);
});

test("enumOptions normalizes string and object options", () => {
	const field = {
		key: "backend",
		label: "Backend",
		type: "enum" as const,
		options: ["cli", { value: "auto", label: "Automatic" }],
	};
	assert.deepEqual(enumOptions(field), [
		{ value: "cli", label: "cli" },
		{ value: "auto", label: "Automatic" },
	]);
});

test("normalizeValues fills defaults and coerces provided values", () => {
	const normalized = normalizeValues(settingsSchema, {
		backend: "cli",
		timeoutMs: "4500",
		autoApprove: "true",
		profiles: {
			"agent-a": { enabled: "true", backend: "cli", timeoutMs: "3000" },
		},
	});
	assert.equal(normalized.backend, "cli");
	assert.equal(normalized.timeoutMs, 4500);
	assert.equal(normalized.autoApprove, true);
	assert.equal(normalized.summaryInDescription, false);
	assert.equal(normalized.overview, "");
	assert.deepEqual(normalized.profiles, {
		"agent-a": { enabled: true, backend: "cli", timeoutMs: 3000 },
	});
});

test("coerceValues produces clean typed values from raw form state", () => {
	const coerced = coerceValues(settingsSchema, {
		backend: "cli",
		timeoutMs: "120",
		autoApprove: true,
		summaryInDescription: "false",
		overview: "   ",
		profiles: {
			"agent-a": { enabled: "1", backend: "auto", timeoutMs: "" },
		},
	});
	assert.equal(coerced.backend, "cli");
	assert.equal(coerced.timeoutMs, 120);
	assert.equal(coerced.autoApprove, true);
	assert.equal(coerced.summaryInDescription, false);
	assert.equal(coerced.overview, "   ");
	assert.deepEqual(coerced.profiles, {
		"agent-a": { enabled: true, backend: "auto", timeoutMs: undefined },
	});
});

test("validateValues accepts a clean settings object", () => {
	const validation = validateValues(settingsSchema, {
		backend: "auto",
		timeoutMs: 3000,
		autoApprove: true,
		summaryInDescription: false,
		overview: "Reviewer",
		profiles: {
			"agent-a": { enabled: true, backend: "cli", timeoutMs: 5000 },
		},
	});
	assert.deepEqual(validation.errors, {});
	assert.equal(firstError(validation), "");
});

test("validateValues flags required string, missing number, bounds, length, and pattern", () => {
	const validation = validateValues(
		{
			fields: [
				{ key: "name", label: "Name", type: "string", required: true },
				{ key: "timeoutMs", label: "Timeout (ms)", type: "number", required: true, min: 1, max: 10 },
				{ key: "overview", label: "Overview", type: "string", maxLength: 3, pattern: "^[a-z]+$" },
			],
		},
		{ name: "", timeoutMs: 0, overview: "abcd" },
	);
	assert.deepEqual(validation.errors, {
		name: "Name is required.",
		timeoutMs: "Timeout (ms) must be between 1 and 10.",
		overview: "Overview must be at most 3 characters.",
	});
	assert.equal(firstError(validation), "Name is required.");

	const patternError = validateValues(
		{ fields: [{ key: "overview", label: "Overview", type: "string", pattern: "^[a-z]+$" }] },
		{ overview: "NotLower" },
	);
	assert.equal(patternError.errors.overview, "Overview does not match the required format.");
});

test("validateValues rejects invalid enums", () => {
	const validation = validateValues(
		{ fields: [{ key: "backend", label: "Backend", type: "enum", options: ["auto", "cli"] }] },
		{ backend: "nope" },
	);
	assert.equal(validation.errors.backend, "Backend has an invalid value.");
});

test("record validation catches non-object tables, empty keys, and bad nested rows", () => {
	const nonObject = validateValues(settingsSchema, { ...defaultValues(settingsSchema), profiles: "nope" });
	assert.equal(nonObject.errors.profiles, "Must be a table of entries.");

	const emptyKey = validateValues(settingsSchema, {
		...defaultValues(settingsSchema),
		profiles: { "": { enabled: true, backend: "cli", timeoutMs: 1000 } },
	});
	assert.equal(emptyKey.errors.profiles, "Every entry needs a key.");

	const nestedBad = validateValues(settingsSchema, {
		...defaultValues(settingsSchema),
		profiles: { "agent-a": { enabled: true, backend: "cli", timeoutMs: 0 } },
	});
	assert.equal(
		nestedBad.errors["profiles.agent-a.timeoutMs"],
		"Timeout (ms) must be at least 1.",
	);

	const nonObjectRow = validateValues(settingsSchema, {
		...defaultValues(settingsSchema),
		profiles: { "agent-a": "not-an-object" },
	});
	assert.equal(nonObjectRow.errors["profiles.agent-a"], "Must be an object.");
});

test("firstError returns the first error in schema order", () => {
	const validation = validateValues(settingsSchema, {
		backend: "cli",
		timeoutMs: 0,
		autoApprove: true,
		summaryInDescription: false,
		overview: "",
		profiles: {},
	});
	assert.equal(firstError(validation), "Timeout (ms) must be between 1 and 600000.");
});

test("isPlainObject distinguishes objects from arrays and null", () => {
	assert.equal(isPlainObject({ a: 1 }), true);
	assert.equal(isPlainObject([]), false);
	assert.equal(isPlainObject(null), false);
	assert.equal(isPlainObject("x"), false);
});

test("defaultValues result can be mutated without leaking into a second call", () => {
	const first = defaultValues(settingsSchema);
	first.timeoutMs = 9999;
	const second = defaultValues(settingsSchema);
	assert.equal(second.timeoutMs, 0);
});
