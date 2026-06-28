import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { PromptRegexRule, PromptStack, PromptStackItem } from "./types.ts";

// ── SillyTavern preset raw types ──────────────────────────────────────────

interface StPreset {
	prompts?: StPromptDef[];
	prompt_order?: StPromptOrderEntry[];
	extensions?: {
		regex_scripts?: unknown[];
		[key: string]: unknown;
	};
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

interface StRegexScript {
	script_name?: string;
	scriptName?: string;
	name?: string;
	disabled?: boolean;
	promptOnly?: boolean;
	markdownOnly?: boolean;
	findRegex?: string;
	replaceString?: string;
	[key: string]: unknown;
}

type RegexScriptMode = "prompt-only" | "markdown-only" | "prompt+markdown" | "unspecified" | "disabled";

interface RegexScriptReportEntry {
	name: string;
	mode: RegexScriptMode;
	enabled: boolean;
	promptOnly: boolean;
	markdownOnly: boolean;
	findRegex?: string;
	replaceString?: string;
	convertedRuleId?: string;
	conversionNote?: string;
}

interface RegexScriptReport {
	total: number;
	enabled: number;
	disabled: number;
	promptOnly: number;
	markdownOnly: number;
	mixed: number;
	unspecified: number;
	converted: number;
	scripts: RegexScriptReportEntry[];
	rules: PromptRegexRule[];
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
	"setvar",
	"setturnvar",
	"setsessionvar",
	"getvar",
	"var",
	"getturnvar",
	"getsessionvar",
	"clearvar",
	"clearturnvar",
	"clearsessionvar",
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

const NATIVE_MACRO_NOTES: Record<string, string> = {
	setvar: "handled as a turn variable by default, with {{setvar::session::name::value}} for session scope",
	setturnvar: "handled as a turn variable",
	setsessionvar: "handled as a session variable",
	getvar: "handled with turn -> session -> static lookup",
	var: "handled as an alias of getvar",
	getturnvar: "handled as a turn-only lookup",
	getsessionvar: "handled as a session-only lookup",
	clearvar: "handled as a turn variable clear by default, with {{clearvar::session::name}} for session scope",
	clearturnvar: "handled as a turn variable clear",
	clearsessionvar: "handled as a session variable clear",
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
	const regexScripts = summarizeRegexScripts(preset);

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
		regex: regexScripts && regexScripts.rules.length > 0 ? { schemaVersion: 1, rules: regexScripts.rules } : undefined,
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

	// Regex scripts
	if (regexScripts && regexScripts.total > 0) {
		reportLines.push("## SillyTavern regex scripts");
		reportLines.push("");
		reportLines.push(`- **Total scripts**: ${regexScripts.total}`);
		reportLines.push(`- **Enabled scripts**: ${regexScripts.enabled}`);
		reportLines.push(`- **Disabled scripts**: ${regexScripts.disabled}`);
		reportLines.push(`- **Prompt-only**: ${regexScripts.promptOnly}`);
		reportLines.push(`- **Markdown-only / display-only**: ${regexScripts.markdownOnly}`);
		reportLines.push(`- **Prompt + markdown mixed**: ${regexScripts.mixed}`);
		if (regexScripts.unspecified > 0) {
			reportLines.push(`- **Enabled with unspecified mode**: ${regexScripts.unspecified}`);
		}
		reportLines.push(`- **Converted to pi-forge rules**: ${regexScripts.converted}`);
		reportLines.push("");
		reportLines.push("| Script | Enabled | Mode | Converted | Find regex | Replacement preview |");
		reportLines.push("|--------|---------|------|-----------|------------|---------------------|");
		for (const script of regexScripts.scripts) {
			const converted = script.convertedRuleId ? `yes: ${script.convertedRuleId}` : script.conversionNote ?? "no";
			reportLines.push(`| ${markdownTableCell(script.name)} | ${script.enabled ? "yes" : "no"} | ${script.mode} | ${markdownTableCell(converted)} | ${markdownTableCell(script.findRegex)} | ${markdownTableCell(script.replaceString)} |`);
		}
		reportLines.push("");
		reportLines.push("pi-forge does not run SillyTavern markdown rewriting, DOM/browser automation, CSS/HTML decoration, toasts, embedded JavaScript, or UI panel behavior.");
		if (regexScripts.converted > 0) {
			reportLines.push("Enabled and disabled prompt-only deterministic regex scripts were converted to `regex.rules` with `stage: \"compiled\"`, `effect: \"outgoing\"`, and system/messages targets. Review them before relying on the imported stack.");
		}
		reportLines.push("Markdown-only, mixed prompt/markdown, unspecified, invalid, or unsupported regex scripts remain report-only and require manual review.");
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
			} else if (NATIVE_MACRO_NOTES[name]) {
				reportLines.push(`- \`{{${displayName}}}\` → ${NATIVE_MACRO_NOTES[name]}`);
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

// ── Regex script reporting ─────────────────────────────────────────────────

function summarizeRegexScripts(preset: StPreset): RegexScriptReport | undefined {
	const rawScripts = preset.extensions?.regex_scripts;
	if (!Array.isArray(rawScripts)) return undefined;

	const scripts = rawScripts
		.map((raw, index) => classifyRegexScript(raw, index))
		.filter((script): script is RegexScriptReportEntry => script !== undefined);

	const report: RegexScriptReport = {
		total: scripts.length,
		enabled: 0,
		disabled: 0,
		promptOnly: 0,
		markdownOnly: 0,
		mixed: 0,
		unspecified: 0,
		converted: 0,
		scripts,
		rules: [],
	};

	const seenRuleIds = new Set<string>();
	for (const [index, script] of scripts.entries()) {
		const conversion = convertPromptOnlyRegexScript(script, index, seenRuleIds);
		if (conversion.rule) {
			report.rules.push(conversion.rule);
			report.converted++;
			script.convertedRuleId = conversion.rule.id;
		} else if (conversion.note) {
			script.conversionNote = conversion.note;
		}

		if (!script.enabled) {
			report.disabled++;
			continue;
		}
		report.enabled++;
		if (script.mode === "prompt-only") report.promptOnly++;
		else if (script.mode === "markdown-only") report.markdownOnly++;
		else if (script.mode === "prompt+markdown") report.mixed++;
		else if (script.mode === "unspecified") report.unspecified++;
	}

	return report;
}

function classifyRegexScript(raw: unknown, index: number): RegexScriptReportEntry | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const script = raw as StRegexScript;
	const enabled = script.disabled !== true;
	const promptOnly = script.promptOnly === true;
	const markdownOnly = script.markdownOnly === true;
	const mode: RegexScriptMode = enabled
		? promptOnly && markdownOnly
			? "prompt+markdown"
			: promptOnly
				? "prompt-only"
				: markdownOnly
					? "markdown-only"
					: "unspecified"
		: "disabled";

	return {
		name: firstString(script.script_name, script.scriptName, script.name) ?? `regex-${index + 1}`,
		mode,
		enabled,
		promptOnly,
		markdownOnly,
		findRegex: firstString(script.findRegex),
		replaceString: firstString(script.replaceString),
	};
}

function convertPromptOnlyRegexScript(
	entry: RegexScriptReportEntry,
	index: number,
	seenRuleIds: Set<string>,
): { rule?: PromptRegexRule; note?: string } {
	if (!entry.promptOnly) return { note: entry.enabled ? "not prompt-only" : "disabled non-prompt script" };
	if (entry.markdownOnly) return { note: "mixed prompt/display script requires review" };
	if (!entry.findRegex) return { note: "missing findRegex" };

	const parsed = parseSillyTavernRegex(entry.findRegex);
	if ("error" in parsed) return { note: parsed.error };

	const id = uniqueRegexRuleId(`st-${entry.name || `regex-${index + 1}`}`, seenRuleIds);
	const rule: PromptRegexRule = {
		id,
		name: entry.name,
		enabled: entry.enabled,
		stage: "compiled",
		effect: "outgoing",
		targets: ["system", "messages"],
		pattern: parsed.pattern,
		replace: entry.replaceString ?? "",
	};
	if (parsed.flags) rule.flags = parsed.flags;
	return {
		rule,
	};
}

function parseSillyTavernRegex(value: string): { pattern: string; flags?: string } | { error: string } {
	const trimmed = value.trim();
	if (!trimmed) return { error: "empty findRegex" };

	if (!trimmed.startsWith("/")) return validateParsedRegex(trimmed, "");

	const closingSlash = findRegexLiteralClosingSlash(trimmed);
	if (closingSlash <= 0) return { error: "could not parse regex literal" };

	const pattern = trimmed.slice(1, closingSlash);
	const flags = trimmed.slice(closingSlash + 1);
	return validateParsedRegex(pattern, flags);
}

function validateParsedRegex(pattern: string, flags: string): { pattern: string; flags?: string } | { error: string } {
	if (!pattern) return { error: "empty regex pattern" };
	const seen = new Set<string>();
	for (const flag of flags) {
		if (!["g", "i", "m", "s", "u"].includes(flag)) return { error: `unsupported regex flag: ${flag}` };
		if (seen.has(flag)) return { error: `duplicate regex flag: ${flag}` };
		seen.add(flag);
	}
	try {
		new RegExp(pattern, flags);
	} catch (error) {
		return { error: `regex failed to compile: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { pattern, flags: flags || undefined };
}

function findRegexLiteralClosingSlash(value: string): number {
	for (let index = value.length - 1; index > 0; index--) {
		if (value[index] !== "/") continue;
		let slashCount = 0;
		for (let backslash = index - 1; backslash >= 0 && value[backslash] === "\\"; backslash--) slashCount++;
		if (slashCount % 2 === 0) return index;
	}
	return -1;
}

function uniqueRegexRuleId(base: string, seen: Set<string>): string {
	const normalized = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "st-regex";
	let candidate = normalized;
	let suffix = 2;
	while (seen.has(candidate)) candidate = `${normalized}-${suffix++}`;
	seen.add(candidate);
	return candidate;
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function markdownTableCell(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return "-";
	const collapsed = value.replace(/\s+/g, " ").trim();
	const truncated = collapsed.length > 96 ? `${collapsed.slice(0, 93)}...` : collapsed;
	return truncated.replace(/\|/g, "\\|");
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
