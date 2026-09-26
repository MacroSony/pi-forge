import { createHash } from "node:crypto";
import { join } from "node:path";
import { serializeCapability } from "./codecs/capability.js";
import { createResourceCatalog } from "./catalog.js";
import { resolveCapability, resolveCapabilityBindings } from "./capabilities.js";
import { formatResourceKey, parseResourceSelector, isValidResourceId } from "./resource-identity.js";
import { deleteCapabilityFile, globalCapabilitiesDir, capabilitiesDir, writeCapabilityFile } from "./repositories/capability.js";
function objectWithKeys(input, keys) {
    return !!input && typeof input === "object" && !Array.isArray(input)
        && Object.keys(input).every(key => keys.includes(key));
}
/** Optional Web adapter; Workspace/repositories and the existing resolver retain ownership. */
export function capabilityOperation(ctx, runtime, action, selector, input) {
    try {
        const trusted = ctx.isProjectTrusted();
        if (!runtime.readCapabilities)
            return { ok: false, status: 503, error: "Capability resources unavailable." };
        if (["create", "save", "delete"].includes(action) && !trusted)
            return { ok: false, status: 403, error: "Project is not trusted; capability writes are disabled." };
        const capabilities = runtime.readCapabilities().filter(capability => trusted || capability.scope === "global");
        const catalog = createResourceCatalog([...capabilities]);
        const entry = (loaded) => {
            const sourceRevision = loaded.sourceRevision ?? "";
            return { selector: formatResourceKey(loaded.key), scope: loaded.scope, filePath: loaded.filePath,
                capability: loaded.capability, diagnostics: loaded.diagnostics, sourceRevision };
        };
        if (action === "list")
            return { ok: true, trusted, capabilities: capabilities.map(entry) };
        if (action === "effective") {
            if (!objectWithKeys(input, ["presetSelector", "bindings"]) || typeof input.presetSelector !== "string" || !Array.isArray(input.bindings)) {
                return { ok: false, status: 400, error: "Expected presetSelector and bindings." };
            }
            const preset = runtime.getStacks().filter(stack => formatResourceKey(stack.key) === input.presetSelector && (trusted || stack.scope === "global"));
            if (preset.length !== 1)
                return { ok: false, status: 404, error: "Unknown or ambiguous qualified Preset selector." };
            const resolved = resolveCapabilityBindings(catalog, preset[0].key, input.bindings);
            if (!resolved.ok)
                return { ok: false, status: 400, error: resolved.error };
            return { ok: true, bindings: resolved.bindings.map(binding => {
                    const source = resolveCapability(catalog, formatResourceKey(binding.ref));
                    if (!source.ok)
                        throw new Error(source.error);
                    return { id: binding.id, ref: formatResourceKey(binding.ref), modelCallable: binding.modelCallable,
                        source: source.loaded.capability, effective: binding.capability };
                }) };
        }
        if (action === "create") {
            if (!objectWithKeys(input, ["scope", "capability"]) || (input.scope !== "global" && input.scope !== "project") || !input.capability || typeof input.capability !== "object") {
                return { ok: false, status: 400, error: "Expected explicit scope and capability." };
            }
            const capability = input.capability;
            if (typeof capability.id !== "string" || !isValidResourceId(capability.id))
                return { ok: false, status: 400, error: "Invalid capability ID." };
            if (capabilities.some(item => item.scope === input.scope && item.key.id === capability.id))
                return { ok: false, status: 409, error: "Capability ID already exists in this scope." };
            const path = join(input.scope === "global" ? globalCapabilitiesDir() : capabilitiesDir(ctx.cwd), `${capability.id}.json`);
            const result = writeCapabilityFile(ctx.cwd, input.scope, path, capability, { overwrite: false });
            if (!result.ok)
                return mutationFailure(result);
            runtime.readCapabilities();
            return {
                ok: true,
                changed: formatResourceKey({ scope: input.scope, id: capability.id }),
                sourceRevision: createHash("sha256").update(serializeCapability(capability)).digest("hex"),
            };
        }
        const parsed = parseResourceSelector(selector ?? "");
        if (!parsed.ok || !parsed.selector.scope)
            return { ok: false, status: 400, error: "A qualified capability selector is required." };
        const matches = capabilities.filter(item => formatResourceKey(item.key) === selector);
        if (matches.length !== 1)
            return { ok: false, status: matches.length ? 409 : 404, error: "Unknown or ambiguous capability." };
        const loaded = matches[0];
        if (action === "get")
            return { ok: true, ...entry(loaded) };
        if (!objectWithKeys(input, action === "delete" ? ["expectedSourceRevision"] : ["capability", "expectedSourceRevision"])
            || typeof input.expectedSourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSourceRevision)) {
            return { ok: false, status: 400, error: "A valid expectedSourceRevision is required." };
        }
        if (action === "save" && (!input.capability || typeof input.capability !== "object" || input.capability.id !== loaded.capability.id)) {
            return { ok: false, status: 400, error: "Capability ID is immutable during save." };
        }
        const options = { overwrite: true, expectedSourceRevision: input.expectedSourceRevision };
        const result = action === "delete"
            ? deleteCapabilityFile(ctx.cwd, loaded.scope, loaded.filePath, options)
            : writeCapabilityFile(ctx.cwd, loaded.scope, loaded.filePath, input.capability, options);
        if (!result.ok)
            return mutationFailure(result);
        runtime.readCapabilities();
        return {
            ok: true,
            changed: selector,
            ...(action === "save" ? {
                sourceRevision: createHash("sha256").update(serializeCapability(input.capability)).digest("hex"),
            } : {}),
        };
    }
    catch (error) {
        return { ok: false, status: 503, error: error instanceof Error ? error.message : "Capability resources unavailable." };
    }
}
function mutationFailure(result) {
    return { ok: false, status: result.reason === "conflict" ? 409 : result.reason === "invalid-path" ? 403 : result.reason === "invalid-capability" ? 400 : 500, error: result.error };
}
//# sourceMappingURL=capability-web-host.js.map