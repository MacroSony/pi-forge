import type { PromptRuntime, PromptStack, PromptStackSlotFormat, PromptStackSlotItem, PromptVariableValue } from "./types.ts";
export interface PromptVariableAccess {
    get(name: string): PromptVariableValue | undefined;
    toMacroText(value: PromptVariableValue | undefined): string;
    toPromptText(value: PromptVariableValue): string;
}
export interface PromptRenderHelpers {
    escapeXml(value: string): string;
    formatDate(now: Date): string;
    formatTime(now: Date): string;
    normalizePath(value: string): string;
    selectedToolNames(stack: PromptStack, runtime: PromptRuntime): string[];
    slotTextFormat(item: PromptStackSlotItem, options?: {
        allowJson?: boolean;
    }): PromptStackSlotFormat;
    plainBullet(label: string, value: string): string;
    plainContinuation(value: string, indent: string): string;
    indentPlainBlock(value: string, indent: string): string;
}
export declare const promptRenderHelpers: PromptRenderHelpers;
export declare function createVariableAccess(_runtime: PromptRuntime, stack: PromptStack): PromptVariableAccess;
export declare function selectedToolNames(stack: PromptStack, runtime: PromptRuntime): string[];
export declare function slotTextFormat(item: PromptStackSlotItem, options?: {
    allowJson?: boolean;
}): PromptStackSlotFormat;
export declare function collectStaticVariables(stack: PromptStack): Record<string, PromptVariableValue>;
export declare function variableValueToMacroText(value: PromptVariableValue | undefined): string;
export declare function variableValueToPromptText(value: PromptVariableValue): string;
export declare function plainBullet(label: string, value: string): string;
export declare function plainContinuation(value: string, indent: string): string;
export declare function indentPlainBlock(value: string, indent: string): string;
export declare function normalizePath(value: string): string;
export declare function formatDate(now: Date): string;
export declare function formatTime(now: Date): string;
export declare function escapeXml(value: string): string;
//# sourceMappingURL=render-helpers.d.ts.map