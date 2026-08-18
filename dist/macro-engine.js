import { promptRenderHelpers } from "./render-helpers.js";
import { assertRegistryName } from "./extension-registry.js";
function macroRegistryState() {
    const globalScope = globalThis;
    globalScope.__piForgeMacroRegistry ??= { macros: new Map() };
    return globalScope.__piForgeMacroRegistry;
}
const MACROS = macroRegistryState().macros;
export function registerMacro(definition) {
    assertRegistryName("Macro", definition.name);
    if (MACROS.has(definition.name)) {
        throw new Error(`Macro is already registered: ${definition.name}`);
    }
    MACROS.set(definition.name, definition);
    return () => {
        if (MACROS.get(definition.name) === definition)
            MACROS.delete(definition.name);
    };
}
export function getRegisteredMacros() {
    return [...MACROS.values()];
}
export function getRegisteredMacro(name) {
    return MACROS.get(name);
}
export function createMacroRenderContext(env) {
    return { env, helpers: promptRenderHelpers };
}
//# sourceMappingURL=macro-engine.js.map