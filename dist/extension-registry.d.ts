export type PromptExtensionOptionType = "boolean" | "string" | "number" | "enum" | "stringArray";
export interface PromptExtensionOptionDefinition {
    type: PromptExtensionOptionType;
    description?: string;
    default?: string | number | boolean | readonly string[];
    values?: readonly string[];
    min?: number;
    max?: number;
    integer?: boolean;
}
export type PromptExtensionOptionsSchema = Record<string, PromptExtensionOptionDefinition>;
export interface PromptExtensionArgumentDefinition {
    name: string;
    description?: string;
    required?: boolean;
    variadic?: boolean;
    expansion?: "eager" | "lazy";
}
export interface PromptRegistryEntry {
    name: string;
    description?: string;
    source?: string;
}
export declare function assertRegistryName(kind: string, name: string): void;
//# sourceMappingURL=extension-registry.d.ts.map