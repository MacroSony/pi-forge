import type { StConversionItem } from "./types.ts";

export const NATIVE_MACROS = new Set([
	"char",
	"user",
	"lastusermessage",
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

export const MACRO_NEEDS_MIGRATION: Record<string, string> = {
	addvar: "use pi-forge {{getvar::name}} + math, or setvar with computed value",
	getglobalvar: "use pi-forge session variables via {{getsessionvar::name}}",
	setglobalvar: "use pi-forge {{setsessionvar::name::value}}",
	random: "use pi-forge conditionals (Priority 2) or precompute",
	pick: "use pi-forge conditionals (Priority 2) or precompute",
	roll: "use pi-forge conditionals (Priority 2) or precompute",
	if: "use pi-forge conditionals (Priority 2)",
	original: "SillyTavern-specific — no direct equivalent; set as session variable if needed",
	outlet: "SillyTavern extension outlet — no pi-forge equivalent",
	group: "SillyTavern group chat — no pi-forge equivalent",
	groupnotmuted: "SillyTavern group chat — no pi-forge equivalent",
	notchar: "SillyTavern group chat — no pi-forge equivalent",
	charifnotgroup: "SillyTavern group chat — no pi-forge equivalent",
	description: "ST character card field — set as session variable or static variable if needed",
	personality: "ST character card field — set as session variable or static variable if needed",
	scenario: "ST character card field — set as session variable or static variable if needed",
	persona: "ST persona field — set as session variable or static variable if needed",
	mesexamples: "ST character dialogue examples — add inline or as context file if needed",
	mesexamplesraw: "ST character dialogue examples — add inline or as context file if needed",
	charprompt: "ST character prompt override — merge into system prompt blocks if needed",
	charinstruction: "ST character instruction override — merge into post-history blocks if needed",
	charversion: "ST character version — set as static variable if needed",
	charfirstmessage: "ST character first message — add as static variable if needed",
	system: "ST context template system prompt — handled by pi-forge system prompt replacement",
	wibefore: "ST world info — no pi-forge equivalent; merge relevant lore into static blocks",
	wiafter: "ST world info — no pi-forge equivalent; merge relevant lore into static blocks",
	lorebefore: "ST world info — no pi-forge equivalent; merge relevant lore into static blocks",
	loreafter: "ST world info — no pi-forge equivalent; merge relevant lore into static blocks",
	anchorbefore: "ST extension injection point — no pi-forge equivalent",
	anchorafter: "ST extension injection point — no pi-forge equivalent",
};

export const NATIVE_MACRO_NOTES: Record<string, string> = {
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

export const COMMENT_MACRO_RE = /\{\{\s*\/\/[\s\S]*?\}\}/g;
export const TRIM_MACRO_RE = /\{\{\s*trim\s*\}\}/gi;

export interface MacroDetection {
	detected: Set<string>;
	commentsStripped: number;
	trimStripped: number;
	migrationNeeded: Record<string, number>;
}

export function detectMacros(conversionItems: StConversionItem[]): MacroDetection {
	const detected = new Set<string>();
	let commentsStripped = 0;
	let trimStripped = 0;
	const migrationNeeded: Record<string, number> = {};
	const macroFindRe = /\{\{(?!\/\/)([a-zA-Z_][a-zA-Z0-9_-]*)/gi;

	for (const { def } of conversionItems) {
		const content = def.content ?? "";
		if (!content) continue;

		const commentMatches = content.match(COMMENT_MACRO_RE);
		if (commentMatches) commentsStripped += commentMatches.length;

		const trimMatches = content.match(TRIM_MACRO_RE);
		if (trimMatches) trimStripped += trimMatches.length;

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

export function displayMacroName(name: string): string {
	return MACRO_DISPLAY_NAMES[name] ?? name;
}
