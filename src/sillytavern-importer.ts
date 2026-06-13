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

// ── Marker identifiers we know about ───────────────────────────────────────

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

// ── Public result types ────────────────────────────────────────────────────

export interface SillyTavernImportResult {
	stack: PromptStack;
	report: string;
}

export interface SillyTavernImportError {
	error: string;
}

export type SillyTavernImportOutcome = SillyTavernImportResult | SillyTavernImportError;

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

	const preset = raw as StPreset;
	const allPrompts = preset.prompts ?? [];
	const promptOrder = preset.prompt_order ?? [];

	if (allPrompts.length === 0) {
		return { error: "Preset has no prompts array." };
	}

	// Select character_id
	const selectedEntry = selectCharacterEntry(promptOrder, characterId);
	if (!selectedEntry) {
		const ids = promptOrder.map((entry) => entry.character_id);
		if (ids.length === 0) {
			return { error: "Preset has no prompt_order entries. Specify a character_id with /preset import-silly <path> <character_id>." };
		}
		return {
			error: `Multiple character configs found: [${ids.join(", ")}]. Re-run with /preset import-silly <path> <character_id>.`,
		};
	}

	// Build ordered, enabled conversion items
	const orderMap = new Map<string, boolean>();
	for (const item of selectedEntry.order ?? []) {
		orderMap.set(item.identifier, item.enabled);
	}

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

	// Build pi-forge items
	const reportLines: string[] = [];
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

		// Skip empty content items
		const content = def.content ?? "";
		if (!content.trim()) {
			disabledCount.empty++;
			continue;
		}

		// Detect {{lastUserMessage}} usage
		if (content.includes("{{lastUserMessage}}")) {
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
			content: content.trim(),
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
	const fileName = basename(filePath, ".json");
	const styleName = preset.names_behavior === 1 ? "names" : preset.names_behavior === 2 ? "nonames" : "default";
	const stackId = fileName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "imported";

	const stack: PromptStack = {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: stackId,
		name: preset["preset_name"] || preset["name"] || fileName,
		autoActivate: false,
		mode: "replace",
		variables: {},
		context: { allowDuplicateChatHistory: false },
		items,
		import: {
			source: "sillytavern",
			sourceFile: fileName,
			characterId: selectedEntry.character_id,
			convertedAt: new Date().toISOString(),
		},
	};

	// Add chat-history option if {{lastUserMessage}} is used after history
	if (usesLastUserMessage) {
		const chatHistoryItem = items.find(
			(item) => item.kind === "slot" && item.slot === "chat-history",
		);
		if (chatHistoryItem && chatHistoryItem.kind === "slot") {
			chatHistoryItem.options = { includeLastUserMessage: false };
		}
	}

	// Build report
	reportLines.push(`# SillyTavern Import Report: ${fileName}`);
	reportLines.push("");
	reportLines.push(`- **Source file**: ${filePath}`);
	reportLines.push(`- **Character ID**: ${selectedEntry.character_id}`);
	reportLines.push(`- **Output stack ID**: ${stackId}`);
	reportLines.push(`- **Names behavior**: ${styleName} (ST value ${preset.names_behavior ?? "?"})`);
	reportLines.push(`- **Total prompts in source**: ${allPrompts.length}`);
	reportLines.push(`- **Items in prompt_order**: ${selectedEntry.order?.length ?? 0}`);
	reportLines.push(`- **Converted items**: ${items.length}`);
	reportLines.push("");

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

	if (missingIdentifiers.length > 0) {
		reportLines.push("## ⚠️ Missing identifiers in prompts array");
		reportLines.push("");
		for (const id of missingIdentifiers) {
			reportLines.push(`- \`${id}\` (referenced in prompt_order but not found in prompts)`);
		}
		reportLines.push("");
	}

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
	reportLines.push("## Notes");
	reportLines.push("");

	if (usesLastUserMessage) {
		reportLines.push("- Auto-detected `{{lastUserMessage}}` in post-history content. `chat-history` slot set with `includeLastUserMessage: false`.");
	}

	reportLines.push("- All items are assigned sequential numeric IDs. Original SillyTavern identifiers are preserved in `source.previousId`.");
	reportLines.push("- Marker items for world info, character description, persona, scenario, and dialogue examples are omitted — these are handled by the SillyTavern frontend and have no direct pi-forge equivalent.");
	reportLines.push("- The stack is set with `autoActivate: false`. Use `/preset use ${stackId}` to activate.");
	reportLines.push("");
	reportLines.push("## Suggested next steps");
	reportLines.push("");
	reportLines.push("1. Review the stack items and adjust IDs/names as needed.");
	reportLines.push("2. Consider adding a `variables` slot for agent state visibility.");
	reportLines.push("3. Verify the prompt order matches your expectations.");
	reportLines.push(`4. Run \`/preset validate ${stackId}\` to check for issues.`);

	return {
		stack,
		report: reportLines.join("\n"),
	};
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
