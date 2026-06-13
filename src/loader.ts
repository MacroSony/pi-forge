import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
	LoadedPromptStack,
	PromptStack,
	PromptStackDiagnostic,
	PromptStackItem,
	PromptStackRole,
} from "./types.ts";
import { SUPPORTED_SLOTS } from "./types.ts";

const VALID_ROLES = new Set<PromptStackRole>(["system", "user", "assistant", "custom"]);

export function promptStacksDir(cwd: string): string {
	return join(cwd, ".pi", "prompt-stacks");
}

export function loadPromptStacks(cwd: string): LoadedPromptStack[] {
	const dir = promptStacksDir(cwd);
	if (!existsSync(dir)) return [];

	let entries: string[];
	try {
		entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}

	return entries.sort().map((name) => loadPromptStackFile(join(dir, name)));
}

export function chooseDefaultStack(
	stacks: LoadedPromptStack[],
	preferredId?: string,
): LoadedPromptStack | undefined {
	if (preferredId) {
		const preferred = stacks.find((loaded) => loaded.stack.id === preferredId);
		if (preferred && isUsablePromptStack(preferred)) return preferred;
	}

	const defaultStack = stacks.find((loaded) => basename(loaded.filePath) === "default.json" && isUsablePromptStack(loaded));
	if (defaultStack) return defaultStack;

	return stacks.find((loaded) => loaded.stack.autoActivate && isUsablePromptStack(loaded));
}

export function isUsablePromptStack(loaded: LoadedPromptStack): boolean {
	return !loaded.diagnostics.some((diagnostic) => diagnostic.level === "error");
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
	const schemaVersion = obj.schemaVersion === 1 ? 1 : 1;
	if (obj.schemaVersion !== 1) {
		diagnostics.push({ level: "warning", message: "Missing or unsupported schemaVersion; assuming 1." });
	}

	const items = Array.isArray(obj.items) ? obj.items.map((item, index) => normalizeItem(item, index, diagnostics)) : [];
	if (!Array.isArray(obj.items)) {
		diagnostics.push({ level: "error", message: "Prompt stack must contain an items array." });
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
		variables: normalizeStringRecord(obj.variables),
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

	return diagnostics;
}

function normalizeId(value: unknown, fallback: string): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return fallback;
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
