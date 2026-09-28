import type { WebEditorPreviewSection } from "../types.ts";

export type PreviewToolDeclaration = NonNullable<WebEditorPreviewSection["toolChanges"]>["added"][number];

/** Only count explicitly declared top-level object properties, not effective schema arity. */
export function declaredParameterCount(parameters: unknown): number | null {
	if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return null;
	const schema = parameters as Record<string, unknown>;
	if (schema.type !== undefined && schema.type !== "object") return null;
	if (!Object.hasOwn(schema, "properties")) return null;
	const properties = schema.properties;
	return properties && typeof properties === "object" && !Array.isArray(properties)
		? Object.keys(properties).length
		: null;
}

export function declarationExcerpt(description: string | undefined): string {
	if (!description) return "";
	const prefix = description.slice(0, 1024).replace(/\s+/g, " ").trim();
	return prefix.slice(0, 180) + (description.length > 1024 || prefix.length > 180 ? "…" : "");
}

/** The Preview declaration fields, not a reconstruction of provider-wire JSON. */
export function declarationJson(tool: PreviewToolDeclaration): string {
	return JSON.stringify(tool, null, 2);
}

/** Search exactly the available declaration text, including the formatted JSON shown on disclosure. */
export function declarationMatches(tool: PreviewToolDeclaration, query: string): boolean {
	const q = query.trim().toLocaleLowerCase();
	return !!q && ([tool.name, tool.description].some(text => typeof text === "string" && text.toLocaleLowerCase().includes(q)) || declarationJson(tool).toLocaleLowerCase().includes(q));
}
