import { basename } from "node:path";
import {
	isValidResourceId,
	parseResourceSelector,
	type ResourceKey,
	type ResourceScope,
} from "../resource-identity.ts";

export const CAPABILITY_TYPE = "pi-forge.capability" as const;
export const MAX_CONTENT_LENGTH = 100_000;
export const MAX_TOOL_ARRAY_LENGTH = 256;
export const MAX_TOOL_NAME_LENGTH = 128;
export const MAX_CAPABILITY_NAME_LENGTH = 1000;

const CAPABILITY_FIELDS = new Set(["schemaVersion", "type", "id", "name", "description", "content", "tools"]);
const TOOLS_FIELDS = new Set(["add", "remove"]);
const BINDING_FIELDS = new Set(["ref", "id", "modelCallable", "overrides"]);
const OVERRIDES_FIELDS = new Set(["content", "appendContent", "tools"]);

export interface CapabilityToolPatch {
	add: string[];
	remove: string[];
}

export interface Capability {
	schemaVersion: 1;
	type: typeof CAPABILITY_TYPE;
	id: string;
	name?: string;
	description?: string;
	content: string;
	tools: CapabilityToolPatch;
}

export interface CapabilityOverrides {
	content?: string;
	appendContent?: string;
	tools?: { add?: string[]; remove?: string[] };
}

export interface CapabilityBinding {
	ref: string;
	id?: string;
	modelCallable?: boolean;
	overrides?: CapabilityOverrides;
}

export type DiagnosticLevel = "error" | "warning" | "info";

export interface Diagnostic {
	level: DiagnosticLevel;
	message: string;
	field?: string;
}

export interface LoadedCapability {
	/** Raw source revision from the same bytes as capability; never persisted into the resource. */
	sourceRevision?: string;
	capability: Capability;
	filePath: string;
	scope: ResourceScope;
	key: ResourceKey;
	diagnostics: Diagnostic[];
}

/** Check if tool name is non-empty, contains no whitespace/control/wildcards, and is <= 128 chars. */
export function isValidToolName(name: string): boolean {
	if (typeof name !== "string") return false;
	if (name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) return false;
	if (/\s/.test(name) || /[\x00-\x1F\x7F]/.test(name) || /[*?]/.test(name)) return false;
	return true;
}

/** Check if loaded capability has no error diagnostics. */
export function isUsableCapability(loaded: LoadedCapability): boolean {
	return !loaded.diagnostics.some((d) => d.level === "error");
}

/** Build a fail-closed LoadedCapability when reading or parsing fails. */
export function createCapabilityFault(
	filePath: string,
	scope: ResourceScope,
	message: string,
): LoadedCapability {
	const id = basename(filePath, ".json");
	return {
		filePath,
		scope,
		key: { scope, id },
		capability: fallbackCapability(filePath),
		diagnostics: [{ level: "error", message }],
	};
}

/** Single canonical serializer for capabilities. */
export function serializeCapability(capability: Capability): string {
	return `${JSON.stringify(capability, null, 2)}\n`;
}

/** Parse, normalize, and validate a capability from serialized JSON text. */
export function parseCapability(
	source: string,
	filePath: string,
	scope: ResourceScope,
): LoadedCapability {
	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch (error) {
		return createCapabilityFault(
			filePath,
			scope,
			`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const { capability, diagnostics } = decodeCapability(raw, basename(filePath, ".json"));
	return { filePath, scope, key: { scope, id: capability.id }, capability, diagnostics };
}

/** Validate a capability or raw candidate object. */
export function validateCapability(capability: unknown): Diagnostic[] {
	return decodeCapability(capability).diagnostics;
}

/** Validate a capability binding against scope and reference rules. */
export function validateCapabilityBinding(
	raw: unknown,
	ownerScope: ResourceScope,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	if (!isPlainObject(raw)) {
		return [{ level: "error", message: "Capability binding must be an object." }];
	}
	for (const field of Object.keys(raw)) {
		if (!BINDING_FIELDS.has(field)) {
			diagnostics.push({ level: "error", field, message: `Unsupported binding field: ${field}` });
		}
	}
	if (raw.ref === undefined) {
		diagnostics.push({ level: "error", field: "ref", message: "Binding ref is required." });
	} else if (typeof raw.ref !== "string" || !raw.ref.trim()) {
		diagnostics.push({ level: "error", field: "ref", message: "Binding ref must be a non-empty string." });
	} else {
		const parsed = parseResourceSelector(raw.ref);
		if (!parsed.ok) {
			diagnostics.push({ level: "error", field: "ref", message: parsed.error });
		} else if (ownerScope === "global" && parsed.selector.scope === "project") {
			diagnostics.push({
				level: "error",
				field: "ref",
				message: `Global binding cannot reference project capability: ${raw.ref}.`,
			});
		}
	}
	if (raw.id !== undefined && (typeof raw.id !== "string" || !isValidResourceId(raw.id))) {
		diagnostics.push({ level: "error", field: "id", message: "Binding id must be a valid resource id." });
	}
	if (raw.modelCallable !== undefined && typeof raw.modelCallable !== "boolean") {
		diagnostics.push({ level: "error", field: "modelCallable", message: "modelCallable must be a boolean when provided." });
	}
	if (raw.overrides !== undefined) {
		diagnostics.push(...validateCapabilityOverrides(raw.overrides));
	}
	return dedupeDiagnostics(diagnostics);
}

/** Apply limited capability overrides immutably. Fails closed if the base capability is invalid. */
export function applyCapabilityOverrides(
	capability: Capability,
	overrides?: CapabilityOverrides,
): { ok: true; capability: Capability } | { ok: false; diagnostics: Diagnostic[] } {
	const baseResult = decodeCapability(capability);
	if (baseResult.diagnostics.some((d) => d.level === "error")) {
		return { ok: false, diagnostics: baseResult.diagnostics };
	}

	if (overrides === undefined) {
		return {
			ok: true,
			capability: {
				...baseResult.capability,
				tools: {
					add: [...baseResult.capability.tools.add],
					remove: [...baseResult.capability.tools.remove],
				},
			},
		};
	}

	const overrideDiags = validateCapabilityOverrides(overrides);
	if (overrideDiags.some((d) => d.level === "error")) {
		return { ok: false, diagnostics: overrideDiags };
	}

	let content = baseResult.capability.content;
	if (overrides.content !== undefined) {
		content = overrides.content;
	} else if (overrides.appendContent !== undefined) {
		content = baseResult.capability.content
			? (overrides.appendContent ? `${baseResult.capability.content}\n\n${overrides.appendContent}` : baseResult.capability.content)
			: overrides.appendContent;
	}

	const candidate: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: baseResult.capability.id,
		...(baseResult.capability.name !== undefined ? { name: baseResult.capability.name } : {}),
		...(baseResult.capability.description !== undefined ? { description: baseResult.capability.description } : {}),
		content,
		tools: {
			add: overrides.tools?.add !== undefined ? [...overrides.tools.add] : [...baseResult.capability.tools.add],
			remove: overrides.tools?.remove !== undefined ? [...overrides.tools.remove] : [...baseResult.capability.tools.remove],
		},
	};

	const candidateResult = decodeCapability(candidate);
	if (candidateResult.diagnostics.some((d) => d.level === "error")) {
		return { ok: false, diagnostics: candidateResult.diagnostics };
	}
	return { ok: true, capability: candidate };
}

function decodeCapability(
	raw: unknown,
	fallbackId?: string,
): { capability: Capability; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];

	if (!isPlainObject(raw)) {
		diagnostics.push({ level: "error", message: "Capability capability root must be a JSON object." });
		return { capability: fallbackCapability(fallbackId ?? "unknown"), diagnostics };
	}

	for (const field of Object.keys(raw)) {
		if (!CAPABILITY_FIELDS.has(field)) {
			diagnostics.push({ level: "error", field, message: `Unsupported capability field: ${field}` });
		}
	}
	if (raw.schemaVersion !== 1) {
		diagnostics.push({ level: "error", field: "schemaVersion", message: "schemaVersion must be 1." });
	}
	if (raw.type !== CAPABILITY_TYPE) {
		diagnostics.push({ level: "error", field: "type", message: `type must be "${CAPABILITY_TYPE}".` });
	}

	let id = fallbackId ?? "";
	if (typeof raw.id !== "string" || !isValidResourceId(raw.id)) {
		diagnostics.push({
			level: "error",
			field: "id",
			message: "Capability capability id must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens.",
		});
		if (typeof raw.id === "string" && raw.id) id = raw.id;
	} else {
		id = raw.id;
	}

	let name: string | undefined = undefined;
	if (raw.name !== undefined) {
		if (typeof raw.name !== "string") {
			diagnostics.push({ level: "error", field: "name", message: "name must be a string when provided." });
		} else if (raw.name.length > MAX_CAPABILITY_NAME_LENGTH) {
			diagnostics.push({
				level: "error",
				field: "name",
				message: `name exceeds maximum length of ${MAX_CAPABILITY_NAME_LENGTH} characters.`,
			});
		} else {
			name = raw.name;
		}
	}

	const description = typeof raw.description === "string" ? raw.description : undefined;
	if (raw.description !== undefined && typeof raw.description !== "string") {
		diagnostics.push({ level: "error", field: "description", message: "description must be a string when provided." });
	}

	let content = "";
	const hasValidContent = typeof raw.content === "string";
	if (!hasValidContent) {
		diagnostics.push({ level: "error", field: "content", message: "content must be a string." });
	} else {
		content = raw.content as string;
		if (content.length > MAX_CONTENT_LENGTH) {
			diagnostics.push({
				level: "error",
				field: "content",
				message: `content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
			});
		}
	}

	let tools: CapabilityToolPatch = { add: [], remove: [] };
	if (raw.tools !== undefined) {
		if (!isPlainObject(raw.tools)) {
			diagnostics.push({ level: "error", field: "tools", message: "tools must be an object." });
		} else {
			for (const field of Object.keys(raw.tools)) {
				if (!TOOLS_FIELDS.has(field)) {
					diagnostics.push({ level: "error", field: `tools.${field}`, message: `Unsupported tools field: ${field}` });
				}
			}
			const add = raw.tools.add !== undefined ? validateToolList(raw.tools.add, "tools.add", diagnostics) : [];
			const remove = raw.tools.remove !== undefined ? validateToolList(raw.tools.remove, "tools.remove", diagnostics) : [];
			tools = { add, remove };
		}
	}

	if (hasValidContent && content.trim().length === 0 && tools.add.length === 0 && tools.remove.length === 0) {
		diagnostics.push({
			level: "error",
			message: "Capability capability must have non-empty content or at least one tool effect (add or remove).",
		});
	}

	const capability: Capability = {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id,
		...(name !== undefined ? { name } : {}),
		...(description !== undefined ? { description } : {}),
		content,
		tools,
	};
	return { capability, diagnostics: dedupeDiagnostics(diagnostics) };
}

function validateCapabilityOverrides(raw: unknown): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	if (!isPlainObject(raw)) {
		return [{ level: "error", field: "overrides", message: "overrides must be an object." }];
	}
	for (const field of Object.keys(raw)) {
		if (!OVERRIDES_FIELDS.has(field)) {
			diagnostics.push({ level: "error", field: `overrides.${field}`, message: `Unsupported override field: ${field}` });
		}
	}
	if (raw.content !== undefined && raw.appendContent !== undefined) {
		diagnostics.push({ level: "error", field: "overrides", message: "Cannot specify both content and appendContent in overrides." });
	}
	for (const key of ["content", "appendContent"] as const) {
		const val = raw[key];
		if (val !== undefined) {
			if (typeof val !== "string") {
				diagnostics.push({ level: "error", field: `overrides.${key}`, message: `overrides.${key} must be a string.` });
			} else if (val.length > MAX_CONTENT_LENGTH) {
				diagnostics.push({
					level: "error",
					field: `overrides.${key}`,
					message: `overrides.${key} exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
				});
			}
		}
	}
	if (raw.tools !== undefined) {
		if (!isPlainObject(raw.tools)) {
			diagnostics.push({ level: "error", field: "overrides.tools", message: "overrides.tools must be an object." });
		} else {
			for (const field of Object.keys(raw.tools)) {
				if (!TOOLS_FIELDS.has(field)) {
					diagnostics.push({
						level: "error",
						field: `overrides.tools.${field}`,
						message: `Unsupported tools field in overrides: ${field}`,
					});
				}
			}
			if (raw.tools.add !== undefined) validateToolList(raw.tools.add, "overrides.tools.add", diagnostics);
			if (raw.tools.remove !== undefined) validateToolList(raw.tools.remove, "overrides.tools.remove", diagnostics);
		}
	}
	return dedupeDiagnostics(diagnostics);
}

function validateToolList(
	list: unknown,
	fieldName: string,
	diagnostics: Diagnostic[],
): string[] {
	if (!Array.isArray(list)) {
		diagnostics.push({ level: "error", field: fieldName, message: `${fieldName} must be an array of tool names.` });
		return [];
	}
	if (list.length > MAX_TOOL_ARRAY_LENGTH) {
		diagnostics.push({
			level: "error",
			field: fieldName,
			message: `${fieldName} cannot exceed ${MAX_TOOL_ARRAY_LENGTH} tools (got ${list.length}).`,
		});
	}

	const validated: string[] = [];
	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		const field = `${fieldName}[${i}]`;
		if (typeof item !== "string") {
			diagnostics.push({ level: "error", field, message: `Tool name at index ${i} must be a string.` });
		} else if (item.length === 0) {
			diagnostics.push({ level: "error", field, message: `Tool name at index ${i} cannot be empty.` });
		} else if (item.length > MAX_TOOL_NAME_LENGTH) {
			diagnostics.push({ level: "error", field, message: `Tool name at index ${i} exceeds maximum length of ${MAX_TOOL_NAME_LENGTH} characters.` });
		} else if (/\s/.test(item)) {
			diagnostics.push({ level: "error", field, message: `Tool name at index ${i} ("${item}") cannot contain whitespace.` });
		} else if (/[\x00-\x1F\x7F]/.test(item)) {
			diagnostics.push({ level: "error", field, message: `Tool name at index ${i} cannot contain control characters.` });
		} else if (/[*?]/.test(item)) {
			diagnostics.push({ level: "error", field, message: `Tool name at index ${i} ("${item}") cannot contain wildcard characters (* or ?).` });
		} else {
			validated.push(item);
		}
	}
	return validated;
}

function fallbackCapability(filePath: string): Capability {
	return {
		schemaVersion: 1,
		type: CAPABILITY_TYPE,
		id: basename(filePath, ".json"),
		content: "",
		tools: { add: [], remove: [] },
	};
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	const result: Diagnostic[] = [];
	for (const d of diagnostics) {
		const key = `${d.level}\0${d.field ?? ""}\0${d.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(d);
	}
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
