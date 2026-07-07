import type { StConversionItem } from "./types.ts";
export declare const NATIVE_MACROS: Set<string>;
export declare const MACRO_NEEDS_MIGRATION: Record<string, string>;
export declare const NATIVE_MACRO_NOTES: Record<string, string>;
export declare const COMMENT_MACRO_RE: RegExp;
export declare const TRIM_MACRO_RE: RegExp;
export interface MacroDetection {
    detected: Set<string>;
    commentsStripped: number;
    trimStripped: number;
    migrationNeeded: Record<string, number>;
}
export declare function detectMacros(conversionItems: StConversionItem[]): MacroDetection;
export declare function displayMacroName(name: string): string;
//# sourceMappingURL=macros.d.ts.map