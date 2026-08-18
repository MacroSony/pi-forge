import type { ForgeV1Error, TemplateDependency, TemplateNode } from "./forge-v1/types.ts";
import type { PromptStack } from "./types.ts";
export interface PromptBlockAnalysis {
    itemId: string;
    ast: TemplateNode[];
    dependencies: TemplateDependency[];
    diagnostics: ForgeV1Error[];
}
export interface PromptAnalysis {
    blocks: PromptBlockAnalysis[];
    slotDependencies: Map<string, string[]>;
    transitiveExtensions: Set<string>;
    diagnostics: ForgeV1Error[];
}
export interface PromptRegistrationLike {
    name: string;
    dependencies?: string[];
}
export interface PromptAnalysisRegistrations {
    macros: readonly PromptRegistrationLike[];
    slots: readonly PromptRegistrationLike[];
}
export declare function analyzePromptStack(stack: PromptStack, registrations?: PromptAnalysisRegistrations): PromptAnalysis;
//# sourceMappingURL=prompt-analysis.d.ts.map