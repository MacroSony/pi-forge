import type { StConversionItem, StPromptDef, StPromptOrderEntry } from "./types.ts";
export declare function selectCharacterEntry(order: StPromptOrderEntry[], preferredId?: number): StPromptOrderEntry | undefined;
export declare function buildPromptMap(prompts: StPromptDef[]): Map<string, StPromptDef>;
export declare function buildConversionItems(selectedEntry: StPromptOrderEntry, promptMap: Map<string, StPromptDef>): StConversionItem[];
export declare function findMissingIdentifiers(selectedEntry: StPromptOrderEntry, promptMap: Map<string, StPromptDef>): string[];
//# sourceMappingURL=prompt-order.d.ts.map