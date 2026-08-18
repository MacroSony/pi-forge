import type { PromptEnvironment, PromptEnvironmentValue, TemplateNode, TemplateRenderResult } from "./types.ts";
export declare function render(nodes: readonly TemplateNode[], environment: PromptEnvironment, options?: {
    templateLimit?: number;
}): TemplateRenderResult;
export declare function valueToString(value: PromptEnvironmentValue | undefined): string;
export declare function escapeXml(value: string): string;
//# sourceMappingURL=renderer.d.ts.map