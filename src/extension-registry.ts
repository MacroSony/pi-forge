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

export function assertRegistryName(kind: string, name: string): void {
	// Names must be a single template-path segment: forge-v1 uses "." as the
	// path separator, so a dotted name ("git.branch") could be registered but
	// never addressed — "extensions.git.branch" parses as three segments.
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
		throw new Error(`${kind} name must start with a letter and contain only letters, numbers, underscore, or hyphen: ${name}`);
	}
}
