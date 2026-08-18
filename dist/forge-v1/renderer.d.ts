import type { PromptEnvironment, PromptEnvironmentValue, TemplateNode, TemplateRenderResult } from "./types.ts";
export interface TemplateRenderOptions {
    templateLimit?: number;
    resolveExtension?: (name: string) => PromptEnvironmentValue | undefined;
}
export declare function render(nodes: readonly TemplateNode[], environment: PromptEnvironment, options?: TemplateRenderOptions): TemplateRenderResult;
export declare function valueToString(value: PromptEnvironmentValue | undefined): string;
export declare function escapeXml(value: string): string;
//# sourceMappingURL=renderer.d.ts.map