import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { validateRegexConfig } from "./regex.ts";
import { promptStackReadDirs } from "./storage.ts";
import type {
	LoadedPromptStack,
	PromptResourcePolicy,
	PromptStack,
	PromptStackDiagnostic,
	PromptStackItem,
	PromptStackRole,
} from "./types.ts";
import { SUPPORTED_SLOTS } from "./types.ts";

const VALID_ROLES = new Set<PromptStackRole>(["system", "user", "assistant", "custom"]);
const VALID_CHAT_HISTORY_TOOL_MODES = new Set(["keep", "drop"]);

export { isInsidePromptStackStorage, legacyPromptStacksDir, promptStackPath, promptStackReadDirs, promptStacksDir } from "./storage.ts";

export function loadPromptStacks(cwd: string): LoadedPromptStack[] {
	const files = promptStackFiles(cwd);
	const loaded = files.map(loadPromptStackFile);
	annotateDuplicateStackIds(loaded);
	return loaded;
}

function promptStackFiles(cwd: string): string[] {
	const files: string[] = [];
	const shadowedNames = new Set<string>();

	for (const dir of promptStackReadDirs(cwd)) {
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
	const byId = new Map<string, LoadedPromptStack[]>();
	for (const loaded of stacks) {
		const id = loaded.stack.id;
		const matches = byId.get(id) ?? [];
		matches.push(loaded);
		byId.set(id, matches);
	}

	for (const [id, matches] of byId) {
		if (matches.length <= 1) continue;
		const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
		for (const loaded of matches) {
			loaded.diagnostics.push({
				level: "error",
				message: `Duplicate stack id: ${id} appears in multiple files (${files}).`,
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
		const preferred = stacks.find((loaded) => loaded.stack.id === preferredId);
		if (preferred && isUsablePromptStack(preferred)) return preferred;
	}

	const defaultStack = stacks.find(
		(loaded) =>
			basename(loaded.filePath) === "default.json" &&
			loaded.stack.autoActivate !== false &&
			isUsablePromptStack(loaded),
	);
	if (defaultStack) return defaultStack;

	return stacks.find((loaded) => loaded.stack.autoActivate === true && isUsablePromptStack(loaded));
}

export function isUsablePromptStack(loaded: LoadedPromptStack): boolean {
	return !loaded.diagnostics.some((diagnostic) => diagnostic.level === "error");
}

export function isDisabledPromptStackId(id: string | undefined): boolean {
	return id === "none" || id === "off";
}

function loadPromptStackFile(filePath: string): LoadedPromptStack {
	const diagnostics: PromptStackDiagnostic[] = [];
	let raw: unknown;

	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		return {
			filePath,
			stack: fallbackStack(filePath),
			diagnostics: [
				{
					level: "error",
					message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}

	const stack = normalizeStack(raw, filePath, diagnostics);
	diagnostics.push(...validatePromptStack(stack));

	return { filePath, stack, diagnostics };
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
	const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : basename(filePath, ".json");
	const schemaVersion = 1;
	if (obj.schemaVersion !== 1) {
		diagnostics.push({ level: "warning", message: "Missing or unsupported schemaVersion; assuming 1." });
	}

	const items = Array.isArray(obj.items) ? obj.items.map((item, index) => normalizeItem(item, index, diagnostics)) : [];
	if (!Array.isArray(obj.items)) {
		diagnostics.push({ level: "error", message: "Prompt stack must contain an items array." });
	}

	if (isPlainObject(obj.state) && Object.keys(obj.state).length > 0) {
		diagnostics.push({
			level: "info",
			message: "state is no longer supported and was ignored; use stack.variables and template variable macros instead.",
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
		variables: normalizeStringRecord(obj.variables),
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
	const diagnostics: PromptStackDiagnostic[] = [];
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
	if ((stack.mode === "append" || stack.mode === "prepend") && hasPolicyEntries(stack.skills)) {
		diagnostics.push({
			level: "warning",
			message: "skills policy only filters pi-forge skills slots. Use mode \"replace\" if you need the base Pi prompt to omit filtered skills.",
		});
	}

	diagnostics.push(...validateRegexConfig(stack.regex));

	return diagnostics;
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

function hasPolicyEntries(policy: PromptResourcePolicy | undefined): boolean {
	return !!policy && ((policy.allow?.length ?? 0) > 0 || (policy.deny?.length ?? 0) > 0);
}

function normalizeRegexConfig(value: unknown, diagnostics: PromptStackDiagnostic[]): PromptStack["regex"] | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		diagnostics.push({ level: "warning", message: "regex must be an object when provided." });
		return undefined;
	}
	return value as PromptStack["regex"];
}
