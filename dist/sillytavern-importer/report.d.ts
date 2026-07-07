import type { PromptStackItem } from "../types.ts";
import { type MacroDetection } from "./macros.ts";
import type { PromptConversionDisabledCounts, RegexScriptReport } from "./types.ts";
export interface SillyTavernImportReportInput {
    fileName: string;
    sourcePath: string;
    characterId: number;
    stackId: string;
    styleName: string;
    totalPrompts: number;
    orderItemCount: number;
    items: PromptStackItem[];
    macroUsage: MacroDetection;
    disabledCount: PromptConversionDisabledCounts;
    missingIdentifiers: string[];
    regexScripts?: RegexScriptReport;
    variables: Record<string, string>;
    usesLastUserMessage: boolean;
}
export declare function buildSillyTavernImportReport(input: SillyTavernImportReportInput): string;
//# sourceMappingURL=report.d.ts.map