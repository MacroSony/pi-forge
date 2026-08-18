import type { PromptEnvironment } from "./forge-v1/types.ts";
import type { PromptRenderHelpers } from "./render-helpers.ts";
import { promptRenderHelpers } from "./render-helpers.ts";
import { assertRegistryName, type PromptRegistryEntry } from "./extension-registry.ts";

export interface PromptMacroRenderContext {
	env: PromptEnvironment;
	helpers: PromptRenderHelpers;
}

export type PromptMacroRenderer = (context: PromptMacroRenderContext) => string;

export interface PromptMacroDefinition extends PromptRegistryEntry {
	/** Environment paths this renderer reads (e.g. "parameters.x", "extensions.y"). */
	dependencies?: string[];
	render: PromptMacroRenderer;
}

interface PromptMacroRegistryState {
	macros: Map<string, PromptMacroDefinition>;
}

type PromptMacroGlobal = typeof globalThis & {
	__piForgeMacroRegistry?: PromptMacroRegistryState;
};

function macroRegistryState(): PromptMacroRegistryState {
	const globalScope = globalThis as PromptMacroGlobal;
	globalScope.__piForgeMacroRegistry ??= { macros: new Map() };
	return globalScope.__piForgeMacroRegistry;
}

const MACROS = macroRegistryState().macros;

export function registerMacro(definition: PromptMacroDefinition): () => void {
	assertRegistryName("Macro", definition.name);
	if (MACROS.has(definition.name)) {
		throw new Error(`Macro is already registered: ${definition.name}`);
	}
	MACROS.set(definition.name, definition);
	return () => {
		if (MACROS.get(definition.name) === definition) MACROS.delete(definition.name);
	};
}

export function getRegisteredMacros(): readonly PromptMacroDefinition[] {
	return [...MACROS.values()];
}

export function getRegisteredMacro(name: string): PromptMacroDefinition | undefined {
	return MACROS.get(name);
}

export function createMacroRenderContext(env: PromptEnvironment): PromptMacroRenderContext {
	return { env, helpers: promptRenderHelpers };
}
