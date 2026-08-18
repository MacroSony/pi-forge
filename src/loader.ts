import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveResourceSelector } from "./catalog.ts";
import { hasResourcePolicy } from "./policy.ts";
import { validateRegexConfig } from "./regex.ts";
import { isValidResourceId, parseResourceSelector } from "./resource-identity.ts";
import { globalPromptStacksDir, promptStackReadDirs } from "./storage.ts";
import type {
	LoadedPromptStack,
	PromptResourcePolicy,
	PromptStack,
	PromptStackDiagnostic,
	PromptStackItem,
	PromptStackRole,
	PromptVariableValue,
} from "./types.ts";
import { SUPPORTED_SLOTS } from "./types.ts";

const VALID_ROLES = new Set<PromptStackRole>(["system", "user", "assistant", "custom"]);
const VALID_CHAT_HISTORY_TOOL_MODES = new Set(["keep", "drop"]);

export {
	globalPromptStacksDir,
	isInsideGlobalPromptStackStorage,
	isInsidePromptStackStorage,
	isSafeGlobalPromptStackMutationPath,
	isSafePromptStackMutationPath,
	legacyPromptStacksDir,
	promptStackPath,
	promptStackReadDirs,
	promptStacksDir,
} from "./storage.ts";

export { isValidResourceId as isValidPromptStackId } from "./resource-identity.ts";

export function loadPromptStacks(cwd: string): LoadedPromptStack[] {
	const loaded = promptStackFiles(promptStackReadDirs(cwd)).map((file) => loadPromptStackFile(file, "project"));
	annotateDuplicateStackIds(loaded);
	return loaded;
}

/**
 * Load both global and project prompt stacks. Global definitions are
 * user-owned and always load; project definitions load from the trusted
 * project directories plus the legacy project directory.
 */
export function loadPromptStacksScoped(cwd: string, globalDir: string = globalPromptStacksDir()): LoadedPromptStack[] {
	const loaded = [
		...promptStackFiles([globalDir]).map((file) => loadPromptStackFile(file, "global")),
		...promptStackFiles(promptStackReadDirs(cwd)).map((file) => loadPromptStackFile(file, "project")),
	];
	annotateDuplicateStackIds(loaded);
	return loaded;
}

/** Load only the user-owned global stacks, used by untrusted projects. */
export function loadGlobalPromptStacks(globalDir: string = globalPromptStacksDir()): LoadedPromptStack[] {
	const loaded = promptStackFiles([globalDir]).map((file) => loadPromptStackFile(file, "global"));
	annotateDuplicateStackIds(loaded);
	return loaded;
}

function promptStackFiles(dirs: string[]): string[] {
	const files: string[] = [];
	const shadowedNames = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;

		let entries: string[];
		try {
			entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
		} catch {
			continue;
		}

		for (const name of entries.sort()) {
			if (shadowedNames.has(name)) continue;
			shadowedNames.add(name);
			files.push(join(dir, name));
		}
	}

	return files;
}

function annotateDuplicateStackIds(stacks: LoadedPromptStack[]): void {
	const byScopeId = new Map<string, LoadedPromptStack[]>();
	for (const loaded of stacks) {
		const key = `${loaded.scope}\0${loaded.stack.id}`;
		const matches = byScopeId.get(key) ?? [];
		matches.push(loaded);
		byScopeId.set(key, matches);
	}

	for (const matches of byScopeId.values()) {
		if (matches.length <= 1) continue;
		const id = matches[0]!.stack.id;
		const scope = matches[0]!.scope;
		const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
		for (const loaded of matches) {
			loaded.diagnostics.push({
				level: "error",
				message: `Duplicate ${scope} stack id: ${id} appears in multiple files (${files}).`,
			});
		}
	}
}

export function chooseDefaultStack(
	stacks: LoadedPromptStack[],
	preferredId?: string,
): LoadedPromptStack | undefined {
	if (isDisabledPromptStackId(preferredId)) return undefined;

	if (preferredId) {
		const parsed = parseResourceSelector(preferredId);
		if (parsed.ok) {
			const preferred = resolveResourceSelector(stacks, parsed.selector);
			if (preferred && isUsablePromptStack(preferred)) return preferred;
		}
	}

	return chooseAutoActivateStack(stacks);
}

/**
 * Standalone prompt-stack auto-activation with project-over-global scope
 * precedence. Only `autoActivate: true` participates. A project scope with
 * an invalid or ambiguous candidate fails closed instead of falling back to
 * a global candidate.
 */
export function chooseAutoActivateStack(stacks: LoadedPromptStack[]): LoadedPromptStack | undefined {
	// A project scope with any auto-activation candidate fails closed on
	// ambiguity or invalidity; it never falls back to a global candidate.
	const projectCandidates = stacks.filter((loaded) => loaded.scope === "project" && loaded.stack.autoActivate === true);
	if (projectCandidates.length > 0) {
		return projectCandidates.length === 1 && isUsablePromptStack(projectCandidates[0]!)
			? projectCandidates[0]
			: undefined;
	}
	// A same-ID project stack shadows a global stack even when the project
	// stack opted out or is invalid, so those global candidates never apply.
	const projectIds = new Set(
		stacks.filter((loaded) => loaded.scope === "project").map((loaded) => loaded.stack.id),
	);
	const globalCandidates = stacks.filter(
		(loaded) => loaded.scope === "global" && loaded.stack.autoActivate === true && !projectIds.has(loaded.stack.id),
	);
	return globalCandidates.length === 1 && isUsablePromptStack(globalCandidates[0]!)
		? globalCandidates[0]
		: undefined;
}

export function isUsablePromptStack(loaded: LoadedPromptStack): boolean {
	return !loaded.diagnostics.some((diagnostic) => diagnostic.level === "error");
}

export function isDisabledPromptStackId(id: string | undefined): boolean {
	return id === "none" || id === "off";
}

function loadPromptStackFile(filePath: string, scope: "global" | "project"): LoadedPromptStack {
	const diagnostics: PromptStackDiagnostic[] = [];
	let raw: unknown;

	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		return {
			filePath,
			scope,
			key: { scope, id: basename(filePath, ".json") },
			stack: fallbackStack(filePath),
			diagnostics: [
				{
					level: "error",
					message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}

	diagnostics.push(...validateRawPromptStackShape(raw));
	const stack = normalizeStack(raw, filePath, diagnostics);
	diagnostics.push(...validatePromptStack(stack));
	if (basename(filePath) === "default.json" && isPlainObject(raw) && !Object.prototype.hasOwnProperty.call(raw, "autoActivate")) {
		diagnostics.push({
			level: "warning",
			message: 'default.json no longer auto-activates by filename; set "autoActivate": true to keep auto-activating this stack.',
		});
	}

	return { filePath, scope, key: { scope, id: stack.id }, stack, diagnostics };
}

function fallbackStack(filePath: string): PromptStack {
	return {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: basename(filePath, ".json"),
		name: basename(filePath),
		items: [],
	};
}

function normalizeStack(raw: unknown, filePath: string, diagnostics: PromptStackDiagnostic[]): PromptStack {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push({ level: "error", message: "Prompt stack root must be a JSON object." });
		return fallbackStack(filePath);
	}

	const obj = raw as Record<string, unknown>;
	const rawId = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : undefined;
	const id = rawId && isValidResourceId(rawId) ? rawId : basename(filePath, ".json");
	if (rawId && !isValidResourceId(rawId)) {
		diagnostics.push({
			level: "error",
			message: `Stack id ${rawId} must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens; falling back to ${id}.`,
		});
	}
	let schemaVersion: 1 | 2 = 1;
	if (obj.schemaVersion === 2) {
		schemaVersion = 2;
	} else if (obj.schemaVersion !== undefined && obj.schemaVersion !== 1) {
		diagnostics.push({ level: "warning", message: `Unsupported schemaVersion; assuming 1.` });
	}

	const items = Array.isArray(obj.items) ? obj.items.map((item, index) => normalizeItem(item, index, diagnostics)) : [];
	if (!Array.isArray(obj.items)) {
		diagnostics.push({ level: "error", message: "Prompt stack must contain an items array." });
	}

	if (isPlainObject(obj.state) && Object.keys(obj.state).length > 0) {
		diagnostics.push({
			level: "info",
			message: "state is no longer supported and was ignored; use stack.variables and template interpolation instead.",
		});
	}

	return {
		schemaVersion,
		type: obj.type === "pi-forge.prompt-stack" ? "pi-forge.prompt-stack" : undefined,
		id,
		name: typeof obj.name === "string" ? obj.name : undefined,
		description: typeof obj.description === "string" ? obj.description : undefined,
		autoActivate: typeof obj.autoActivate === "boolean" ? obj.autoActivate : undefined,
		mode: obj.mode === "append" || obj.mode === "prepend" || obj.mode === "replace" ? obj.mode : undefined,
		defaults: isPlainObject(obj.defaults) ? (obj.defaults as PromptStack["defaults"]) : undefined,
		context: isPlainObject(obj.context) ? (obj.context as PromptStack["context"]) : undefined,
		tools: normalizeResourcePolicy(obj.tools, "tools", diagnostics),
		skills: normalizeResourcePolicy(obj.skills, "skills", diagnostics),
		variables: schemaVersion === 1 ? normalizeStringRecord(obj.variables) : undefined,
		parameters: schemaVersion === 2 ? normalizeParameterRecord(obj.parameters, diagnostics) : undefined,
		regex: normalizeRegexConfig(obj.regex, diagnostics),
		items,
		import: isPlainObject(obj.import) ? (obj.import as Record<string, unknown>) : undefined,
	};
}

function normalizeItem(raw: unknown, index: number, diagnostics: PromptStackDiagnostic[]): PromptStackItem {
	const fallbackId = `item-${index + 1}`;

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		diagnostics.push({ level: "error", message: `Item ${index + 1} must be an object.`, itemId: fallbackId });
		return { kind: "block", id: fallbackId, enabled: false, content: "" };
	}

	const obj = raw as Record<string, unknown>;
	const kind = obj.kind === "slot" ? "slot" : "block";
	const id = normalizeId(obj.id, fallbackId);
	const base = {
		kind,
		id,
		name: typeof obj.name === "string" ? obj.name : undefined,
		enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
		role: VALID_ROLES.has(obj.role as PromptStackRole) ? (obj.role as PromptStackRole) : undefined,
		tags: Array.isArray(obj.tags) ? obj.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
		source: isPlainObject(obj.source) ? (obj.source as Record<string, unknown>) : undefined,
	};

	if (kind === "slot") {
		return {
			...base,
			kind: "slot",
			slot: typeof obj.slot === "string" ? obj.slot : "",
			options: isPlainObject(obj.options) ? obj.options : undefined,
		};
	}

	return {
		...base,
		kind: "block",
		content: typeof obj.content === "string" ? obj.content : "",
	};
}

export function validatePromptStack(stack: PromptStack): PromptStackDiagnostic[] {
	const diagnostics: PromptStackDiagnostic[] = validateRawPromptStackShape(stack);
	const ids = new Set<string>();
	let chatHistoryCount = 0;

	if (!stack.id.trim()) diagnostics.push({ level: "error", message: "Stack id must not be empty." });

	for (const item of stack.items) {
		if (ids.has(item.id)) diagnostics.push({ level: "error", message: `Duplicate item id: ${item.id}`, itemId: item.id });
		ids.add(item.id);

		if (item.role && !VALID_ROLES.has(item.role)) {
			diagnostics.push({ level: "error", message: `Invalid role: ${item.role}`, itemId: item.id });
		}

		if (item.kind === "slot") {
			if (!SUPPORTED_SLOTS.has(item.slot as any)) {
				diagnostics.push({ level: "warning", message: `Unsupported slot: ${item.slot}`, itemId: item.id });
			}
			if (item.enabled !== false && item.slot === "chat-history") chatHistoryCount++;
			if (item.slot === "chat-history") validateChatHistoryOptions(item, diagnostics);
		}

		if (item.kind === "block" && item.role !== "system" && item.enabled !== false && !item.role) {
			diagnostics.push({ level: "warning", message: "Enabled block has no role and will be ignored.", itemId: item.id });
		}
	}

	if (chatHistoryCount === 0) {
		diagnostics.push({
			level: "warning",
			message: "No enabled chat-history slot found; Pi chat context will be appended at the end.",
		});
	} else if (chatHistoryCount > 1 && !stack.context?.allowDuplicateChatHistory) {
		diagnostics.push({
			level: "warning",
			message: "Multiple enabled chat-history slots found; only the first will be expanded unless context.allowDuplicateChatHistory is true.",
		});
	}

	diagnostics.push(...validateResourcePolicy(stack.tools, "tools"));
	diagnostics.push(...validateResourcePolicy(stack.skills, "skills"));
	const hasSkillPolicy = hasResourcePolicy(stack.skills);
	if (hasSkillPolicy) {
		diagnostics.push({
			level: "info",
			message: "skills policy only filters model-visible skills rendered by pi-forge skills slots; it does not disable explicit skill invocation and is not a security boundary.",
		});
	}
	if ((stack.mode === "append" || stack.mode === "prepend") && hasSkillPolicy) {
		diagnostics.push({
			level: "warning",
			message: "skills policy only filters pi-forge skills slots. Use mode \"replace\" if you need the base Pi prompt to omit filtered skills.",
		});
	}

	diagnostics.push(...validateRegexConfig(stack.regex));

	return diagnostics;
}

function validateRawPromptStackShape(raw: unknown): PromptStackDiagnostic[] {
	const diagnostics: PromptStackDiagnostic[] = [];
	if (!isPlainObject(raw)) return diagnostics;

	if (typeof raw.id !== "string" || !raw.id.trim()) {
		diagnostics.push({ level: "error", message: "Stack id must be a non-empty string." });
	}
	if (raw.type !== undefined && raw.type !== "pi-forge.prompt-stack") {
		diagnostics.push({ level: "error", message: 'Stack type must be "pi-forge.prompt-stack" when provided.' });
	}
	validateOptionalString(raw, "name", "Stack name", diagnostics);
	validateOptionalString(raw, "description", "Stack description", diagnostics);
	validateOptionalBoolean(raw, "autoActivate", "Stack autoActivate", diagnostics);
	if (raw.mode !== undefined && raw.mode !== "append" && raw.mode !== "prepend" && raw.mode !== "replace") {
		diagnostics.push({ level: "error", message: 'Stack mode must be "append", "prepend", or "replace" when provided.' });
	}

	validateRawDefaults(raw.defaults, diagnostics);
	validateRawContext(raw.context, diagnostics);
	validateRawVariables(raw.variables, diagnostics);
	validateRawParameters(raw, diagnostics);

	if (!Array.isArray(raw.items)) return diagnostics;
	for (const [index, item] of raw.items.entries()) {
		if (!isPlainObject(item)) continue;
		const fallbackId = `item-${index + 1}`;
		const itemId = typeof item.id === "string" && item.id.trim() ? item.id.trim() : fallbackId;
		if (item.kind !== "block" && item.kind !== "slot") {
			diagnostics.push({ level: "error", message: `Item ${index + 1} kind must be "block" or "slot".`, itemId });
		}
		if (typeof item.id !== "string" || !item.id.trim()) {
			diagnostics.push({ level: "error", message: `Item ${index + 1} id must be a non-empty string.`, itemId });
		}
		if (item.name !== undefined && typeof item.name !== "string") {
			diagnostics.push({ level: "error", message: "Item name must be a string when provided.", itemId });
		}
		if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
			diagnostics.push({ level: "error", message: "Item enabled must be a boolean when provided.", itemId });
		}
		if (item.role !== undefined && !VALID_ROLES.has(item.role as PromptStackRole)) {
			diagnostics.push({ level: "error", message: `Invalid role: ${String(item.role)}`, itemId });
		}
		if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== "string"))) {
			diagnostics.push({ level: "error", message: "Item tags must be an array of strings when provided.", itemId });
		}
		if (item.source !== undefined && !isPlainObject(item.source)) {
			diagnostics.push({ level: "error", message: "Item source must be an object when provided.", itemId });
		}
		if (item.kind === "block" && typeof item.content !== "string") {
			diagnostics.push({ level: "error", message: "Block content must be a string.", itemId });
		}
		if (item.kind === "slot") {
			if (typeof item.slot !== "string" || !item.slot.trim()) {
				diagnostics.push({ level: "error", message: "Slot name must be a non-empty string.", itemId });
			}
			if (item.options !== undefined && !isPlainObject(item.options)) {
				diagnostics.push({ level: "error", message: "Slot options must be an object when provided.", itemId });
			}
		}
	}

	return diagnostics;
}

function validateRawDefaults(value: unknown, diagnostics: PromptStackDiagnostic[]): void {
	if (value === undefined) return;
	if (!isPlainObject(value)) {
		diagnostics.push({ level: "error", message: "Stack defaults must be an object when provided." });
		return;
	}
	validateOptionalBoolean(value, "syntheticMessagesVisible", "defaults.syntheticMessagesVisible", diagnostics);
	if (value.unresolvedMacroPolicy !== undefined && !["warn", "keep", "error"].includes(String(value.unresolvedMacroPolicy))) {
		diagnostics.push({ level: "error", message: 'defaults.unresolvedMacroPolicy must be "warn", "keep", or "error" when provided.' });
	}
}

function validateRawContext(value: unknown, diagnostics: PromptStackDiagnostic[]): void {
	if (value === undefined) return;
	if (!isPlainObject(value)) {
		diagnostics.push({ level: "error", message: "Stack context must be an object when provided." });
		return;
	}
	validateOptionalBoolean(value, "allowDuplicateChatHistory", "context.allowDuplicateChatHistory", diagnostics);
}

function validateRawVariables(value: unknown, diagnostics: PromptStackDiagnostic[]): void {
	if (value === undefined) return;
	if (!isPlainObject(value)) {
		diagnostics.push({ level: "error", message: "Stack variables must be an object when provided." });
		return;
	}
	for (const [name, variable] of Object.entries(value)) {
		if (typeof variable !== "string") {
			diagnostics.push({ level: "error", message: `Stack variable ${name} must be a string.` });
		}
	}
}

function validateRawParameters(raw: Record<string, unknown>, diagnostics: PromptStackDiagnostic[]): void {
	const schemaVersion = raw.schemaVersion === 2 ? 2 : 1;
	if (schemaVersion === 2 && raw.variables !== undefined) {
		diagnostics.push({ level: "warning", message: "schemaVersion 2 stacks use parameters; variables is ignored." });
	}
	if (schemaVersion === 1 && raw.parameters !== undefined) {
		diagnostics.push({ level: "warning", message: "schemaVersion 1 stacks use variables; parameters is ignored." });
	}
	if (raw.parameters === undefined) return;
	if (!isPlainObject(raw.parameters)) {
		diagnostics.push({ level: "error", message: "Stack parameters must be an object when provided." });
		return;
	}
	for (const [name, value] of Object.entries(raw.parameters)) {
		if (!isPromptVariableValue(value)) {
			diagnostics.push({ level: "error", message: `Stack parameter ${name} must be a JSON-compatible value.` });
		}
	}
}

function validateOptionalString(
	value: Record<string, unknown>,
	key: string,
	label: string,
	diagnostics: PromptStackDiagnostic[],
): void {
	if (value[key] !== undefined && typeof value[key] !== "string") {
		diagnostics.push({ level: "error", message: `${label} must be a string when provided.` });
	}
}

function validateOptionalBoolean(
	value: Record<string, unknown>,
	key: string,
	label: string,
	diagnostics: PromptStackDiagnostic[],
): void {
	if (value[key] !== undefined && typeof value[key] !== "boolean") {
		diagnostics.push({ level: "error", message: `${label} must be a boolean when provided.` });
	}
}

function validateChatHistoryOptions(
	item: Extract<PromptStackItem, { kind: "slot" }>,
	diagnostics: PromptStackDiagnostic[],
): void {
	const options = item.options;
	if (!options) return;

	for (const key of ["includeLastUserMessage", "stripAssistantThinking", "includeSummaries"]) {
		const value = options[key];
		if (value !== undefined && typeof value !== "boolean") {
			diagnostics.push({ level: "warning", message: `chat-history option ${key} should be a boolean.`, itemId: item.id });
		}
	}

	if (options.roles !== undefined && !isStringArray(options.roles)) {
		diagnostics.push({ level: "error", message: "chat-history option roles must be an array of strings.", itemId: item.id });
	}

	if (options.toolMode !== undefined && (typeof options.toolMode !== "string" || !VALID_CHAT_HISTORY_TOOL_MODES.has(options.toolMode))) {
		diagnostics.push({ level: "error", message: 'chat-history option toolMode must be "keep" or "drop".', itemId: item.id });
	}

	for (const key of ["maxMessages", "maxChars"]) {
		const value = options[key];
		if (value !== undefined && !isPositiveInteger(value)) {
			diagnostics.push({ level: "error", message: `chat-history option ${key} must be a positive integer.`, itemId: item.id });
		}
	}
}

function normalizeId(value: unknown, fallback: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return fallback;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeParameterRecord(value: unknown, diagnostics: PromptStackDiagnostic[]): Record<string, PromptVariableValue> | undefined {
	if (!isPlainObject(value)) return undefined;
	const result: Record<string, PromptVariableValue> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (isPromptVariableValue(raw)) result[key] = raw;
	}
	return result;
}

function isPromptVariableValue(value: unknown): value is PromptVariableValue {
	if (value === null) return true;
	const type = typeof value;
	if (type === "string" || type === "boolean") return true;
	if (type === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isPromptVariableValue);
	if (!value || typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).every(isPromptVariableValue);
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isPlainObject(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string") result[key] = raw;
	}
	return result;
}

function normalizeResourcePolicy(value: unknown, label: string, diagnostics: PromptStackDiagnostic[]): PromptResourcePolicy | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({ level: "error", message: `${label} policy must be an object when provided.` });
		return undefined;
	}
	const allow = normalizePolicyPatterns(value.allow, `${label}.allow`, diagnostics);
	const deny = normalizePolicyPatterns(value.deny, `${label}.deny`, diagnostics);
	if (allow && deny) {
		diagnostics.push({ level: "error", message: `${label} policy must use either allow or deny, not both.` });
		return { allow };
	}
	if (allow) return { allow };
	if (deny) return { deny };
	return {};
}

function normalizePolicyPatterns(value: unknown, label: string, diagnostics: PromptStackDiagnostic[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		diagnostics.push({ level: "error", message: `${label} must be an array of strings when provided.` });
		return undefined;
	}

	const patterns: string[] = [];
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string" || !item.trim()) {
			diagnostics.push({ level: "error", message: `${label}[${index}] must be a non-empty string.` });
			continue;
		}
		patterns.push(item.trim());
	}
	return patterns.length > 0 ? patterns : undefined;
}

function validateResourcePolicy(policy: PromptResourcePolicy | undefined, label: string): PromptStackDiagnostic[] {
	const diagnostics: PromptStackDiagnostic[] = [];
	if ((policy?.allow?.length ?? 0) > 0 && (policy?.deny?.length ?? 0) > 0) {
		diagnostics.push({ level: "error", message: `${label} policy must use either allow or deny, not both.` });
	}
	for (const key of ["allow", "deny"] as const) {
		const values = policy?.[key];
		if (!values) continue;
		const seen = new Set<string>();
		for (const value of values) {
			if (seen.has(value)) {
				diagnostics.push({ level: "warning", message: `Duplicate ${label}.${key} pattern: ${value}.` });
			}
			seen.add(value);
		}
	}
	return diagnostics;
}

function normalizeRegexConfig(value: unknown, diagnostics: PromptStackDiagnostic[]): PromptStack["regex"] | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({ level: "warning", message: "regex must be an object when provided." });
		return undefined;
	}
	return value as PromptStack["regex"];
}
