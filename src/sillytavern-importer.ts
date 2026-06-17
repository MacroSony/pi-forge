import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { PromptStack, PromptStackItem } from "./types.ts";

// ── SillyTavern preset raw types ──────────────────────────────────────────

interface StPreset {
	prompts?: StPromptDef[];
	prompt_order?: StPromptOrderEntry[];
	names_behavior?: number;
	preset_name?: string;
	name?: string;
	[key: string]: unknown;
}

interface StPromptDef {
	identifier: string;
	name?: string;
	role?: string;
	content?: string;
	system_prompt?: boolean;
	marker?: boolean;
	enabled?: boolean;
}

interface StPromptOrderEntry {
	character_id: number;
	order?: StOrderItem[];
}

interface StOrderItem {
	identifier: string;
	enabled: boolean;
}

interface StConversionItem {
	def: StPromptDef;
	orderEnabled: boolean;
	orderIndex: number;
}

// ── Marker identifiers ─────────────────────────────────────────────────────

const MARKER_CHAT_HISTORY = "chatHistory";
const MARKER_SKIP = new Set([
	"worldInfoBefore",
	"worldInfoAfter",
	"charDescription",
	"charPersonality",
	"personaDescription",
	"scenario",
	"dialogueExamples",
]);

// ── ST macros that pi-forge handles natively ───────────────────────────────

const NATIVE_MACROS = new Set([
	"char",            // → static variable
	"user",            // → static variable
	"lastusermessage", // → handled by pi-forge runtime
	"cwd",
	"date",
	"time",
]);

const MACRO_DISPLAY_NAMES: Record<string, string> = {
	lastusermessage: "lastUserMessage",
	groupnotmuted: "groupNotMuted",
	notchar: "notChar",
	charifnotgroup: "charIfNotGroup",
	mesexamples: "mesExamples",
	mesexamplesraw: "mesExamplesRaw",
	charprompt: "charPrompt",
	charinstruction: "charInstruction",
	charversion: "charVersion",
	charfirstmessage: "charFirstMessage",
	wibefore: "wiBefore",
	wiafter: "wiAfter",
	lorebefore: "loreBefore",
	loreafter: "loreAfter",
	anchorbefore: "anchorBefore",
	anchorafter: "anchorAfter",
};

// ── ST macros that need manual migration ───────────────────────────────────

const MACRO_NEEDS_MIGRATION: Record<string, string> = {
	"setvar": "pi-forge {{setvar::name::value}} / {{setsessionvar::name::value}} — scoping differs",
	"getvar": "pi-forge {{getvar::name}} — lookup order: turn → session → static",
	"addvar": "use pi-forge {{getvar::name}} + math, or setvar with computed value",
	"getglobalvar": "use pi-forge session variables via {{getsessionvar::name}}",
	"setglobalvar": "use pi-forge {{setsessionvar::name::value}}",
	"random": "use pi-forge conditionals (Priority 2) or precompute",
	"pick": "use pi-forge conditionals (Priority 2) or precompute",
	"roll": "use pi-forge conditionals (Priority 2) or precompute",
	"if": "use pi-forge conditionals (Priority 2)",
	"original": "SillyTavern-specific — no direct equivalent; set as session variable if needed",
	"outlet": "SillyTavern extension outlet — no pi-forge equivalent",
	"group": "SillyTavern group chat — no pi-forge equivalent",
	"groupnotmuted": "SillyTavern group chat — no pi-forge equivalent",
	"notchar": "SillyTavern group chat — no pi-forge equivalent",
	"charifnotgroup": "SillyTavern group chat — no pi-forge equivalent",
	"description": "ST character card field — set as session variable or static variable if needed",
	"personality": "ST character card field — set as session variable or static variable if needed",
	"scenario": "ST character card field — set as session variable or static variable if needed",
	"persona": "ST persona field — set as session variable or static variable if needed",
	"mesexamples": "ST character dialogue examples — add inline or as context file if needed",
	"mesexamplesraw": "ST character dialogue examples — add inline or as context file if needed",
	"charprompt": "ST character prompt override — merge into system prompt blocks if needed",
	"charinstruction": "ST character instruction override — merge into post-history blocks if needed",
	"charversion": "ST character version — set as static variable if needed",
	"charfirstmessage": "ST character first message — add as static variable if needed",
	"system": "ST context template system prompt — handled by pi-forge system prompt replacement",
	"wibefore": "ST world info — no pi-forge equivalent; merge relevant lore into static blocks",
	"wiafter": "ST world info — no pi-forge equivalent; merge relevant lore into static blocks",
	"lorebefore": "ST world info — no pi-forge equivalent; merge relevant lore into static blocks",
	"loreafter": "ST world info — no pi-forge equivalent; merge relevant lore into static blocks",
	"anchorbefore": "ST extension injection point — no pi-forge equivalent",
	"anchorafter": "ST extension injection point — no pi-forge equivalent",
};

// ── Macros we can strip entirely (produce no output) ───────────────────────

const COMMENT_MACRO_RE = /\{\{\s*\/\/[\s\S]*?\}\}/g;
const TRIM_MACRO_RE = /\{\{\s*trim\s*\}\}/gi;

// ── Public result types ────────────────────────────────────────────────────

export interface SillyTavernImportResult {
	stack: PromptStack;
	report: string;
}

export interface SillyTavernImportError {
	error: string;
}

export type SillyTavernImportOutcome = SillyTavernImportResult | SillyTavernImportError;

export interface SillyTavernConvertOptions {
	sourceName?: string;
	sourcePath?: string;
	characterId?: number;
}

// ── Importer ───────────────────────────────────────────────────────────────

export function importSillyTavernPreset(
	filePath: string,
	characterId?: number,
): SillyTavernImportOutcome {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (err) {
		return { error: `Failed to read or parse ${filePath}: ${err instanceof Error ? err.message : String(err)}` };
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: "Preset root must be a JSON object." };
	}

	return convertSillyTavernPreset(raw, { sourceName: filePath, sourcePath: filePath, characterId });
}

export function convertSillyTavernPreset(
	raw: unknown,
	options: SillyTavernConvertOptions = {},
): SillyTavernImportOutcome {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { error: "Preset root must be a JSON object." };
	}

	const preset = raw as StPreset;
	const fallbackName = typeof preset.preset_name === "string" && preset.preset_name.trim()
		? preset.preset_name
		: typeof preset.name === "string" && preset.name.trim()
			? preset.name
			: "imported.json";
	const sourceName = options.sourceName ?? fallbackName;
	const sourcePath = options.sourcePath ?? sourceName;
	const allPrompts = preset.prompts ?? [];
	const promptOrder = preset.prompt_order ?? [];

	if (allPrompts.length === 0) {
		return { error: "Preset has no prompts array." };
	}

	// Select character_id
	const selectedEntry = selectCharacterEntry(promptOrder, options.characterId);
	if (!selectedEntry) {
		const ids = promptOrder.map((entry) => entry.character_id);
		if (ids.length === 0) {
			return { error: "Preset has no prompt_order entries. Choose a character_id and retry." };
		}
		return {
			error: `Multiple character configs found: [${ids.join(", ")}]. Choose a character_id and retry.`,
		};
	}

	// Build ordered, enabled conversion items
	const conversionItems: StConversionItem[] = [];
	const promptMap = new Map<string, StPromptDef>();
	for (const def of allPrompts) {
		promptMap.set(def.identifier, def);
	}

	let orderIndex = 0;
	for (const orderItem of selectedEntry.order ?? []) {
		const def = promptMap.get(orderItem.identifier);
		if (def) {
			conversionItems.push({ def, orderEnabled: orderItem.enabled, orderIndex: orderIndex++ });
		}
	}

	// First pass: detect macros across all content
	const macroUsage = detectMacros(conversionItems);

	// Build pi-forge items
	const reportNotes: string[] = [];
	let nextId = 1;
	const items: PromptStackItem[] = [];
	let usesLastUserMessage = false;
	const disabledCount = { marker: 0, empty: 0, orderDisable: 0 };

	for (const { def, orderEnabled, orderIndex } of conversionItems) {
		const id = String(nextId++);

		// Marker items
		if (def.marker) {
			if (def.identifier === MARKER_CHAT_HISTORY) {
				items.push({
					kind: "slot",
					id,
					name: def.name || "Chat History",
					enabled: orderEnabled,
					slot: "chat-history",
					source: { previousId: def.identifier, name: def.name },
				});
			} else if (MARKER_SKIP.has(def.identifier)) {
				disabledCount.marker++;
			}
			continue;
		}

		// Clean content: strip comments, handle trim
		let content = def.content ?? "";
		if (!content.trim()) {
			disabledCount.empty++;
			continue;
		}

		// Strip ST comment macros
		content = content.replace(COMMENT_MACRO_RE, "");

		// Strip {{trim}} — it's a formatting hint for newline removal, not meaningful content
		content = content.replace(TRIM_MACRO_RE, "");

		// After stripping comments/trim, check if content is still meaningful
		if (!content.trim()) {
			disabledCount.empty++;
			continue;
		}

		// Detect {{lastUserMessage}} usage, case-insensitively.
		if (/\{\{\s*lastUserMessage\b/i.test(content)) {
			usesLastUserMessage = true;
		}

		const role = normalizeRole(def.role);
		if (!role) {
			disabledCount.empty++;
			continue;
		}

		if (!orderEnabled) {
			disabledCount.orderDisable++;
		}

		items.push({
			kind: "block",
			id,
			name: def.name,
			enabled: orderEnabled,
			role,
			content: cleanContent(content),
			source: {
				previousId: def.identifier,
				previousName: def.name,
				orderIndex,
			},
		});
	}

	// Diagnostic: any prompts in the order that don't exist in the prompts array
	const missingIdentifiers: string[] = [];
	for (const orderItem of selectedEntry.order ?? []) {
		if (!promptMap.has(orderItem.identifier)) {
			missingIdentifiers.push(orderItem.identifier);
		}
	}

	// Build stack name from file
	const fileName = basename(sourceName).replace(/\.json$/i, "") || "imported";
	const styleName = preset.names_behavior === 1 ? "names" : preset.names_behavior === 2 ? "nonames" : "default";
	const stackId = fileName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "imported";

	// Build static variables
	const variables: Record<string, string> = {};
	if (macroUsage.detected.has("char")) variables.char = "{{char}}";
	if (macroUsage.detected.has("user")) variables.user = "{{user}}";

	const stack: PromptStack = {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: stackId,
		name: preset["preset_name"] || preset["name"] || fileName,
		autoActivate: false,
		mode: "replace",
		variables: Object.keys(variables).length > 0 ? variables : undefined,
		context: { allowDuplicateChatHistory: false },
		items,
		import: {
			source: "sillytavern",
			sourceFile: fileName,
			characterId: selectedEntry.character_id,
			convertedAt: new Date().toISOString(),
		},
	};

	// Add chat-history option if {{lastUserMessage}} is used after history.
	if (macroUsage.detected.has("lastusermessage")) usesLastUserMessage = true;
	if (usesLastUserMessage) {
		const chatHistoryItem = items.find(
			(item) => item.kind === "slot" && item.slot === "chat-history",
		);
		if (chatHistoryItem && chatHistoryItem.kind === "slot") {
			chatHistoryItem.options = { includeLastUserMessage: false };
		}
	}

	// Build report
	const reportLines: string[] = [];
	reportLines.push(`# SillyTavern Import Report: ${fileName}`);
	reportLines.push("");
	reportLines.push(`- **Source file**: ${sourcePath}`);
	reportLines.push(`- **Character ID**: ${selectedEntry.character_id}`);
	reportLines.push(`- **Output stack ID**: ${stackId}`);
	reportLines.push(`- **Names behavior**: ${styleName} (ST value ${preset.names_behavior ?? "?"})`);
	reportLines.push(`- **Total prompts in source**: ${allPrompts.length}`);
	reportLines.push(`- **Items in prompt_order**: ${selectedEntry.order?.length ?? 0}`);
	reportLines.push(`- **Converted items**: ${items.length}`);
	reportLines.push("");

	// Stripped content
	if (macroUsage.commentsStripped > 0) {
		reportLines.push(`- **Comments stripped**: ${macroUsage.commentsStripped} ST comment blocks removed`);
	}
	if (macroUsage.trimStripped > 0) {
		reportLines.push(`- **Trim markers removed**: ${macroUsage.trimStripped} {{trim}} markers (ST formatting hint)`);
	}
	reportLines.push("");

	// Skipped items
	if (disabledCount.marker > 0 || disabledCount.empty > 0 || disabledCount.orderDisable > 0) {
		reportLines.push("## Skipped items");
		reportLines.push("");
		if (disabledCount.marker > 0) {
			reportLines.push(`- ${disabledCount.marker} marker items (charDescription, worldInfo, etc.) — handled by Pi/ST runtime, not needed in prompt stack`);
		}
		if (disabledCount.empty > 0) {
			reportLines.push(`- ${disabledCount.empty} items with empty or missing content`);
		}
		if (disabledCount.orderDisable > 0) {
			reportLines.push(`- ${disabledCount.orderDisable} items disabled in prompt_order`);
		}
		reportLines.push("");
	}

	// Missing identifiers
	if (missingIdentifiers.length > 0) {
		reportLines.push("## ⚠️ Missing identifiers in prompts array");
		reportLines.push("");
		for (const id of missingIdentifiers) {
			reportLines.push(`- \`${id}\` (referenced in prompt_order but not found in prompts)`);
		}
		reportLines.push("");
	}

	// Auto-populated variables
	if (Object.keys(variables).length > 0) {
		reportLines.push("## Auto-populated variables");
		reportLines.push("");
		reportLines.push("These ST built-in macros were auto-populated as static variables with placeholder values:");
		reportLines.push("");
		for (const [key, val] of Object.entries(variables)) {
			reportLines.push(`- \`${key}\` = \`${val}\` — replace with your character/persona name`);
		}
		reportLines.push("");
		reportLines.push("Use `/state set <name> <value>` or edit the stack JSON to set real values.");
		reportLines.push("");
	}

	// Macros needing migration
	const migrationEntries = Object.entries(macroUsage.migrationNeeded).sort(([, a], [, b]) => b - a);
	if (migrationEntries.length > 0) {
		reportLines.push("## ⚠️ Macros needing manual migration");
		reportLines.push("");
		reportLines.push("These ST macros appear in the preset but have no direct pi-forge equivalent:");
		reportLines.push("");
		for (const [name, count] of migrationEntries) {
			const note = MACRO_NEEDS_MIGRATION[name] ?? "no mapping available";
			reportLines.push(`- **\`{{${displayMacroName(name)}}}\`** (${count} occurrence${count > 1 ? "s" : ""}) — ${note}`);
		}
		reportLines.push("");

		// Specific guidance for heavy variable usage
		if (macroUsage.migrationNeeded.setvar || macroUsage.migrationNeeded.getvar) {
			reportLines.push("### Variable system migration");
			reportLines.push("");
			reportLines.push("ST uses `setvar`/`getvar` for ephemeral state. pi-forge has a different variable model:");
			reportLines.push("");
			reportLines.push("- **Static variables** — set in the stack JSON's `variables` object (character names, fixed config)");
			reportLines.push("- **Session state** — persists across turns, set by the user via `/state set` or by the agent via `forge_state_set` for `agent.*` names");
			reportLines.push("- **Turn variables** — ephemeral, set via `{{setvar::name::value}}` macros in blocks");
			reportLines.push("");
			reportLines.push("Review ST `setvar`/`getvar` calls and migrate to the appropriate pi-forge scope.");
			reportLines.push("");
		}
	}

	// Native macros handled
	const nativeDetected = [...macroUsage.detected].filter((m) => NATIVE_MACROS.has(m));
	if (nativeDetected.length > 0) {
		reportLines.push("## Handled macros");
		reportLines.push("");
		for (const name of nativeDetected) {
			const displayName = displayMacroName(name);
			if (name === "char" || name === "user") {
				reportLines.push(`- \`{{${displayName}}}\` → auto-populated as static variable`);
			} else if (name === "lastusermessage") {
				reportLines.push(`- \`{{${displayName}}}\` → handled by pi-forge runtime (chat-history slot)`);
			} else {
				reportLines.push(`- \`{{${displayName}}}\` → handled natively by pi-forge`);
			}
		}
		reportLines.push("");
	}

	// Item mapping table
	reportLines.push(`## Item mapping`);
	reportLines.push("");
	reportLines.push(`| # | ST Identifier | ST Name | pi-forge ID | Role | Enabled | Kind |`);
	reportLines.push(`|---|--------------|---------|-------------|------|---------|------|`);

	for (const item of items) {
		const stId = (item.source as Record<string, unknown> | undefined)?.previousId ?? "—";
		const stName = item.name ?? "—";
		const enabled = item.enabled !== false ? "✓" : "✗";
		const kind = item.kind;
		reportLines.push(`| ${item.id} | ${stId} | ${stName} | ${item.id} | ${item.role ?? "—"} | ${enabled} | ${kind} |`);
	}

	reportLines.push("");
	reportLines.push("## General notes");
	reportLines.push("");

	if (usesLastUserMessage) {
		reportLines.push("- Auto-detected `{{lastUserMessage}}` in post-history content. `chat-history` slot set with `includeLastUserMessage: false`.");
	}

	if (macroUsage.commentsStripped > 0 || macroUsage.trimStripped > 0) {
		reportLines.push(`- ${macroUsage.commentsStripped} ST comment blocks and ${macroUsage.trimStripped} TRIM markers were stripped during import.`);
	}

	reportLines.push("- All items are assigned sequential numeric IDs. Original SillyTavern identifiers are preserved in `source.previousId`.");
	reportLines.push("- Marker items for world info, character description, persona, scenario, and dialogue examples are omitted — these are handled by the SillyTavern frontend and have no direct pi-forge equivalent.");
	reportLines.push(`- The stack is set with \`autoActivate: false\`. Use \`/preset use ${stackId}\` to activate.`);
	reportLines.push("");
	reportLines.push("## Suggested next steps");
	reportLines.push("");
	reportLines.push("1. Set real values for auto-populated variables with `/state set`.");
	reportLines.push("2. Review items with migration-needed macros and rewrite for pi-forge's macro system.");
	reportLines.push("3. Consider adding a `variables` slot for agent state visibility.");
	reportLines.push(`4. Run \`/preset validate ${stackId}\` to check for issues.`);

	return {
		stack,
		report: reportLines.join("\n"),
	};
}

// ── Macro detection ────────────────────────────────────────────────────────

interface MacroDetection {
	detected: Set<string>;
	commentsStripped: number;
	trimStripped: number;
	migrationNeeded: Record<string, number>;
}

function detectMacros(conversionItems: StConversionItem[]): MacroDetection {
	const detected = new Set<string>();
	let commentsStripped = 0;
	let trimStripped = 0;
	const migrationNeeded: Record<string, number> = {};

	// Regex to find {{macroName...}} — captures the first word/identifier
	const macroFindRe = /\{\{(?!\/\/)([a-zA-Z_][a-zA-Z0-9_-]*)/gi;

	for (const { def } of conversionItems) {
		const content = def.content ?? "";
		if (!content) continue;

		// Count comments
		const commentMatches = content.match(COMMENT_MACRO_RE);
		if (commentMatches) commentsStripped += commentMatches.length;

		// Count trims
		const trimMatches = content.match(TRIM_MACRO_RE);
		if (trimMatches) trimStripped += trimMatches.length;

		// Work on a copy with comments stripped so we don't flag // as a macro
		const cleaned = content.replace(COMMENT_MACRO_RE, "").replace(TRIM_MACRO_RE, "");

		let match: RegExpExecArray | null;
		macroFindRe.lastIndex = 0;
		while ((match = macroFindRe.exec(cleaned)) !== null) {
			const name = match[1].toLowerCase();
			detected.add(name);

			if (MACRO_NEEDS_MIGRATION[name]) {
				migrationNeeded[name] = (migrationNeeded[name] ?? 0) + 1;
			}
		}
	}

	return { detected, commentsStripped, trimStripped, migrationNeeded };
}

// ── Content cleaning ──────────────────────────────────────────────────────

function displayMacroName(name: string): string {
	return MACRO_DISPLAY_NAMES[name] ?? name;
}

function cleanContent(content: string): string {
	// Collapse multiple blank lines (max 1 blank line between paragraphs)
	return content.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function selectCharacterEntry(
	order: StPromptOrderEntry[],
	preferredId?: number,
): StPromptOrderEntry | undefined {
	if (order.length === 0) return undefined;

	if (preferredId !== undefined) {
		return order.find((entry) => entry.character_id === preferredId);
	}

	if (order.length === 1) return order[0];

	// Multiple entries, no preference — can't auto-select
	return undefined;
}

function normalizeRole(role: string | undefined): "system" | "user" | "assistant" | undefined {
	if (!role) return undefined;
	const lower = role.trim().toLowerCase();
	if (lower === "system") return "system";
	if (lower === "user") return "user";
	if (lower === "assistant") return "assistant";
	return undefined;
}
