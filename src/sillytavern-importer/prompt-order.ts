import type { StConversionItem, StPromptDef, StPromptOrderEntry } from "./types.ts";

export function selectCharacterEntry(
	order: StPromptOrderEntry[],
	preferredId?: number,
): StPromptOrderEntry | undefined {
	if (order.length === 0) return undefined;

	if (preferredId !== undefined) {
		return order.find((entry) => entry.character_id === preferredId);
	}

	if (order.length === 1) return order[0];

	return undefined;
}

export function buildPromptMap(prompts: StPromptDef[]): Map<string, StPromptDef> {
	const promptMap = new Map<string, StPromptDef>();
	for (const def of prompts) {
		promptMap.set(def.identifier, def);
	}
	return promptMap;
}

export function buildConversionItems(
	selectedEntry: StPromptOrderEntry,
	promptMap: Map<string, StPromptDef>,
): StConversionItem[] {
	const conversionItems: StConversionItem[] = [];
	let orderIndex = 0;

	for (const orderItem of selectedEntry.order ?? []) {
		const def = promptMap.get(orderItem.identifier);
		if (def) {
			conversionItems.push({ def, orderEnabled: orderItem.enabled, orderIndex: orderIndex++ });
		}
	}

	return conversionItems;
}

export function findMissingIdentifiers(
	selectedEntry: StPromptOrderEntry,
	promptMap: Map<string, StPromptDef>,
): string[] {
	const missingIdentifiers: string[] = [];
	for (const orderItem of selectedEntry.order ?? []) {
		if (!promptMap.has(orderItem.identifier)) {
			missingIdentifiers.push(orderItem.identifier);
		}
	}
	return missingIdentifiers;
}
