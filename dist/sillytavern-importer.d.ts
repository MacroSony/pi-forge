import type { SillyTavernConvertOptions, SillyTavernImportOutcome } from "./sillytavern-importer/types.ts";
export type { SillyTavernConvertOptions, SillyTavernImportError, SillyTavernImportOutcome, SillyTavernImportResult, } from "./sillytavern-importer/types.ts";
export declare function importSillyTavernPreset(filePath: string, characterId?: number): SillyTavernImportOutcome;
export declare function convertSillyTavernPreset(raw: unknown, options?: SillyTavernConvertOptions): SillyTavernImportOutcome;
//# sourceMappingURL=sillytavern-importer.d.ts.map