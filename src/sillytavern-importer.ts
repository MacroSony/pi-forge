import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { convertPromptItems } from "./sillytavern-importer/items.ts";
import { detectMacros } from "./sillytavern-importer/macros.ts";
import {
	buildConversionItems,
	buildPromptMap,
	findMissingIdentifiers,
	selectCharacterEntry,
} from "./sillytavern-importer/prompt-order.ts";
import { summarizeRegexScripts } from "./sillytavern-importer/regex.ts";
import { buildSillyTavernImportReport } from "./sillytavern-importer/report.ts";
import type {
	SillyTavernConvertOptions,
	SillyTavernImportOutcome,
	StPreset,
} from "./sillytavern-importer/types.ts";
import type { PromptStack } from "./types.ts";

export type {
	SillyTavernConvertOptions,
	SillyTavernImportError,
	SillyTavernImportOutcome,
	SillyTavernImportResult,
} from "./sillytavern-importer/types.ts";

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

	const promptMap = buildPromptMap(allPrompts);
	const conversionItems = buildConversionItems(selectedEntry, promptMap);
	const macroUsage = detectMacros(conversionItems);
	const { items, disabledCount, usesLastUserMessage: itemUsesLastUserMessage } = convertPromptItems(conversionItems);
	const missingIdentifiers = findMissingIdentifiers(selectedEntry, promptMap);
	const fileName = basename(sourceName).replace(/\.json$/i, "") || "imported";
	const styleName = preset.names_behavior === 1 ? "names" : preset.names_behavior === 2 ? "nonames" : "default";
	const stackId = normalizeStackId(fileName);
	const variables = buildStaticVariables(macroUsage.detected);
	let usesLastUserMessage = itemUsesLastUserMessage;

	const stack: PromptStack = {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: stackId,
		name: preset.preset_name || preset.name || fileName,
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

	if (macroUsage.detected.has("lastusermessage")) usesLastUserMessage = true;
	if (usesLastUserMessage) {
		const chatHistoryItem = items.find(
			(item) => item.kind === "slot" && item.slot === "chat-history",
		);
		if (chatHistoryItem && chatHistoryItem.kind === "slot") {
			chatHistoryItem.options = { includeLastUserMessage: false };
		}
	}

	const report = buildSillyTavernImportReport({
		fileName,
		sourcePath,
		characterId: selectedEntry.character_id,
		stackId,
		styleName: `${styleName} (ST value ${preset.names_behavior ?? "?"})`,
		totalPrompts: allPrompts.length,
		orderItemCount: selectedEntry.order?.length ?? 0,
		items,
		macroUsage,
		disabledCount,
		missingIdentifiers,
		regexScripts,
		variables,
		usesLastUserMessage,
	});

	return {
		stack,
		report,
	};
}

function normalizeStackId(fileName: string): string {
	return fileName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "imported";
}

function buildStaticVariables(detectedMacros: Set<string>): Record<string, string> {
	const variables: Record<string, string> = {};
	if (detectedMacros.has("char")) variables.char = "{{char}}";
	if (detectedMacros.has("user")) variables.user = "{{user}}";
	return variables;
}
