import { basename } from "node:path";
import { isValidResourceId, parseResourceSelector, } from "../resource-identity.js";
export const INSTRUCTION_MODE_TYPE = "pi-forge.instruction-mode";
export const MAX_CONTENT_LENGTH = 100_000;
export const MAX_TOOL_ARRAY_LENGTH = 256;
export const MAX_TOOL_NAME_LENGTH = 128;
export const MAX_MODE_NAME_LENGTH = 1000;
const INSTRUCTION_MODE_FIELDS = new Set(["schemaVersion", "type", "id", "name", "description", "content", "tools"]);
const TOOLS_FIELDS = new Set(["add", "remove"]);
const BINDING_FIELDS = new Set(["ref", "id", "modelCallable", "overrides"]);
const OVERRIDES_FIELDS = new Set(["content", "appendContent", "tools"]);
/** Check if tool name is non-empty, contains no whitespace/control/wildcards, and is <= 128 chars. */
export function isValidToolName(name) {
    if (typeof name !== "string")
        return false;
    if (name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH)
        return false;
    if (/\s/.test(name) || /[\x00-\x1F\x7F]/.test(name) || /[*?]/.test(name))
        return false;
    return true;
}
/** Check if loaded instruction mode has no error diagnostics. */
export function isUsableInstructionMode(loaded) {
    return !loaded.diagnostics.some((d) => d.level === "error");
}
/** Build a fail-closed LoadedInstructionMode when reading or parsing fails. */
export function createInstructionModeFault(filePath, scope, message) {
    const id = basename(filePath, ".json");
    return {
        filePath,
        scope,
        key: { scope, id },
        mode: fallbackInstructionMode(filePath),
        diagnostics: [{ level: "error", message }],
    };
}
/** Single canonical serializer for instruction modes. */
export function serializeInstructionMode(mode) {
    return `${JSON.stringify(mode, null, 2)}\n`;
}
/** Parse, normalize, and validate an instruction mode from serialized JSON text. */
export function parseInstructionMode(source, filePath, scope) {
    let raw;
    try {
        raw = JSON.parse(source);
    }
    catch (error) {
        return createInstructionModeFault(filePath, scope, `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { mode, diagnostics } = decodeInstructionMode(raw, basename(filePath, ".json"));
    return { filePath, scope, key: { scope, id: mode.id }, mode, diagnostics };
}
/** Validate an instruction mode or raw candidate object. */
export function validateInstructionMode(mode) {
    return decodeInstructionMode(mode).diagnostics;
}
/** Validate an instruction mode binding against scope and reference rules. */
export function validateInstructionModeBinding(raw, ownerScope) {
    const diagnostics = [];
    if (!isPlainObject(raw)) {
        return [{ level: "error", message: "Instruction mode binding must be an object." }];
    }
    for (const field of Object.keys(raw)) {
        if (!BINDING_FIELDS.has(field)) {
            diagnostics.push({ level: "error", field, message: `Unsupported binding field: ${field}` });
        }
    }
    if (raw.ref === undefined) {
        diagnostics.push({ level: "error", field: "ref", message: "Binding ref is required." });
    }
    else if (typeof raw.ref !== "string" || !raw.ref.trim()) {
        diagnostics.push({ level: "error", field: "ref", message: "Binding ref must be a non-empty string." });
    }
    else {
        const parsed = parseResourceSelector(raw.ref);
        if (!parsed.ok) {
            diagnostics.push({ level: "error", field: "ref", message: parsed.error });
        }
        else if (ownerScope === "global" && parsed.selector.scope === "project") {
            diagnostics.push({
                level: "error",
                field: "ref",
                message: `Global binding cannot reference project instruction mode: ${raw.ref}.`,
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
        diagnostics.push(...validateInstructionModeOverrides(raw.overrides));
    }
    return dedupeDiagnostics(diagnostics);
}
/** Apply limited instruction mode overrides immutably. Fails closed if base mode is invalid. */
export function applyInstructionModeOverrides(mode, overrides) {
    const baseResult = decodeInstructionMode(mode);
    if (baseResult.diagnostics.some((d) => d.level === "error")) {
        return { ok: false, diagnostics: baseResult.diagnostics };
    }
    if (overrides === undefined) {
        return {
            ok: true,
            mode: {
                ...baseResult.mode,
                tools: {
                    add: [...baseResult.mode.tools.add],
                    remove: [...baseResult.mode.tools.remove],
                },
            },
        };
    }
    const overrideDiags = validateInstructionModeOverrides(overrides);
    if (overrideDiags.some((d) => d.level === "error")) {
        return { ok: false, diagnostics: overrideDiags };
    }
    let content = baseResult.mode.content;
    if (overrides.content !== undefined) {
        content = overrides.content;
    }
    else if (overrides.appendContent !== undefined) {
        content = baseResult.mode.content
            ? (overrides.appendContent ? `${baseResult.mode.content}\n\n${overrides.appendContent}` : baseResult.mode.content)
            : overrides.appendContent;
    }
    const candidate = {
        schemaVersion: 1,
        type: INSTRUCTION_MODE_TYPE,
        id: baseResult.mode.id,
        ...(baseResult.mode.name !== undefined ? { name: baseResult.mode.name } : {}),
        ...(baseResult.mode.description !== undefined ? { description: baseResult.mode.description } : {}),
        content,
        tools: {
            add: overrides.tools?.add !== undefined ? [...overrides.tools.add] : [...baseResult.mode.tools.add],
            remove: overrides.tools?.remove !== undefined ? [...overrides.tools.remove] : [...baseResult.mode.tools.remove],
        },
    };
    const candidateResult = decodeInstructionMode(candidate);
    if (candidateResult.diagnostics.some((d) => d.level === "error")) {
        return { ok: false, diagnostics: candidateResult.diagnostics };
    }
    return { ok: true, mode: candidate };
}
function decodeInstructionMode(raw, fallbackId) {
    const diagnostics = [];
    if (!isPlainObject(raw)) {
        diagnostics.push({ level: "error", message: "Instruction mode root must be a JSON object." });
        return { mode: fallbackInstructionMode(fallbackId ?? "unknown"), diagnostics };
    }
    for (const field of Object.keys(raw)) {
        if (!INSTRUCTION_MODE_FIELDS.has(field)) {
            diagnostics.push({ level: "error", field, message: `Unsupported instruction mode field: ${field}` });
        }
    }
    if (raw.schemaVersion !== 1) {
        diagnostics.push({ level: "error", field: "schemaVersion", message: "schemaVersion must be 1." });
    }
    if (raw.type !== INSTRUCTION_MODE_TYPE) {
        diagnostics.push({ level: "error", field: "type", message: `type must be "${INSTRUCTION_MODE_TYPE}".` });
    }
    let id = fallbackId ?? "";
    if (typeof raw.id !== "string" || !isValidResourceId(raw.id)) {
        diagnostics.push({
            level: "error",
            field: "id",
            message: "Instruction mode id must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens.",
        });
        if (typeof raw.id === "string" && raw.id)
            id = raw.id;
    }
    else {
        id = raw.id;
    }
    let name = undefined;
    if (raw.name !== undefined) {
        if (typeof raw.name !== "string") {
            diagnostics.push({ level: "error", field: "name", message: "name must be a string when provided." });
        }
        else if (raw.name.length > MAX_MODE_NAME_LENGTH) {
            diagnostics.push({
                level: "error",
                field: "name",
                message: `name exceeds maximum length of ${MAX_MODE_NAME_LENGTH} characters.`,
            });
        }
        else {
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
    }
    else {
        content = raw.content;
        if (content.length > MAX_CONTENT_LENGTH) {
            diagnostics.push({
                level: "error",
                field: "content",
                message: `content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
            });
        }
    }
    let tools = { add: [], remove: [] };
    if (raw.tools !== undefined) {
        if (!isPlainObject(raw.tools)) {
            diagnostics.push({ level: "error", field: "tools", message: "tools must be an object." });
        }
        else {
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
            message: "Instruction mode must have non-empty content or at least one tool effect (add or remove).",
        });
    }
    const mode = {
        schemaVersion: 1,
        type: INSTRUCTION_MODE_TYPE,
        id,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        content,
        tools,
    };
    return { mode, diagnostics: dedupeDiagnostics(diagnostics) };
}
function validateInstructionModeOverrides(raw) {
    const diagnostics = [];
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
    for (const key of ["content", "appendContent"]) {
        const val = raw[key];
        if (val !== undefined) {
            if (typeof val !== "string") {
                diagnostics.push({ level: "error", field: `overrides.${key}`, message: `overrides.${key} must be a string.` });
            }
            else if (val.length > MAX_CONTENT_LENGTH) {
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
        }
        else {
            for (const field of Object.keys(raw.tools)) {
                if (!TOOLS_FIELDS.has(field)) {
                    diagnostics.push({
                        level: "error",
                        field: `overrides.tools.${field}`,
                        message: `Unsupported tools field in overrides: ${field}`,
                    });
                }
            }
            if (raw.tools.add !== undefined)
                validateToolList(raw.tools.add, "overrides.tools.add", diagnostics);
            if (raw.tools.remove !== undefined)
                validateToolList(raw.tools.remove, "overrides.tools.remove", diagnostics);
        }
    }
    return dedupeDiagnostics(diagnostics);
}
function validateToolList(list, fieldName, diagnostics) {
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
    const validated = [];
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        const field = `${fieldName}[${i}]`;
        if (typeof item !== "string") {
            diagnostics.push({ level: "error", field, message: `Tool name at index ${i} must be a string.` });
        }
        else if (item.length === 0) {
            diagnostics.push({ level: "error", field, message: `Tool name at index ${i} cannot be empty.` });
        }
        else if (item.length > MAX_TOOL_NAME_LENGTH) {
            diagnostics.push({ level: "error", field, message: `Tool name at index ${i} exceeds maximum length of ${MAX_TOOL_NAME_LENGTH} characters.` });
        }
        else if (/\s/.test(item)) {
            diagnostics.push({ level: "error", field, message: `Tool name at index ${i} ("${item}") cannot contain whitespace.` });
        }
        else if (/[\x00-\x1F\x7F]/.test(item)) {
            diagnostics.push({ level: "error", field, message: `Tool name at index ${i} cannot contain control characters.` });
        }
        else if (/[*?]/.test(item)) {
            diagnostics.push({ level: "error", field, message: `Tool name at index ${i} ("${item}") cannot contain wildcard characters (* or ?).` });
        }
        else {
            validated.push(item);
        }
    }
    return validated;
}
function fallbackInstructionMode(filePath) {
    return {
        schemaVersion: 1,
        type: INSTRUCTION_MODE_TYPE,
        id: basename(filePath, ".json"),
        content: "",
        tools: { add: [], remove: [] },
    };
}
function dedupeDiagnostics(diagnostics) {
    const seen = new Set();
    const result = [];
    for (const d of diagnostics) {
        const key = `${d.level}\0${d.field ?? ""}\0${d.message}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(d);
    }
    return result;
}
function isPlainObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
//# sourceMappingURL=instruction-mode.js.map