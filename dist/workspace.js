import { hasAgentProfileErrors, loadAgentProfilesScoped } from "./agent-profile.js";
import { loadPromptStacksScoped } from "./loader.js";
import { ForgeHost, } from "./subagent/host-port.js";
import { prepareSubagentHostPlan } from "./subagent-host.js";
/**
 * Minimal snapshot owner over the Lane 2a repositories/codecs. Owns one
 * immutable resource snapshot (scoped stack/profile catalogs plus active
 * selection/provenance references) and the host-port registration for that
 * snapshot. Reloads replace the whole snapshot; dispose tears down the host.
 */
export class ForgeWorkspace {
    sources;
    current;
    host;
    constructor(sources = {}) {
        this.sources = sources;
    }
    get snapshotKnown() {
        return this.current !== undefined;
    }
    reload(cwd) {
        const stacks = loadPromptStacksScoped(cwd);
        const profiles = loadAgentProfilesScoped(cwd);
        this.current = {
            cwd,
            stacks,
            profiles,
            activeStackId: this.sources.activeStackId?.() ?? null,
            lastAppliedProfile: this.sources.lastAppliedProfile?.(),
            capturedAt: new Date().toISOString(),
        };
        return this.current;
    }
    snapshot() {
        if (!this.current)
            throw new Error("ForgeWorkspace has not been reloaded.");
        return this.current;
    }
    /** Register the host port for the current snapshot. Returns the live host. */
    startHostPort(transport) {
        if (this.host?.isLive)
            throw new Error("ForgeWorkspace host port is already live.");
        const host = new ForgeHost(transport, {
            capabilities: ["listProfiles", "prepare"],
            handle: (operation, payload) => this.operate(operation, payload),
        });
        this.host = host;
        host.start();
        return host;
    }
    /** Invoke the three-minimal-operation surface against the current snapshot. */
    operate(operation, payload) {
        if (operation === "listProfiles") {
            const snapshot = this.snapshot();
            return {
                ok: true,
                data: {
                    profiles: snapshot.profiles.map((profile) => ({
                        id: profile.profile.id,
                        scope: profile.scope,
                        filePath: profile.filePath,
                        usable: !hasAgentProfileErrors(profile.diagnostics),
                        diagnostics: profile.diagnostics,
                    })),
                },
            };
        }
        if (operation === "prepare") {
            return this.prepare(payload);
        }
        return { ok: false, error: `Unknown Forge host operation: ${operation}` };
    }
    prepare(payload) {
        if (!isPreparationInputLike(payload)) {
            return { ok: false, error: "Malformed prepare payload: request.input.text, runtime.baseSystemPrompt/preparedAt/options/model, preflight.toolCatalog, and snapshot.promptStack are required." };
        }
        try {
            const output = prepareSubagentHostPlan(payload);
            return { ok: true, data: output };
        }
        catch (error) {
            return {
                ok: false,
                error: `Prepare failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    dispose() {
        if (this.host?.isLive)
            this.host.stop();
        this.host = undefined;
        this.current = undefined;
    }
}
function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isPreparationInputLike(value) {
    if (!isObject(value))
        return false;
    const request = value.request;
    const runtime = value.runtime;
    const snapshot = value.snapshot;
    const preflight = value.preflight;
    if (!isObject(request) || !isObject(request.input) || typeof request.input.text !== "string")
        return false;
    if (!isObject(runtime))
        return false;
    if (typeof runtime.baseSystemPrompt !== "string")
        return false;
    if (typeof runtime.preparedAt !== "string")
        return false;
    if (!isObject(runtime.options) || !isObject(runtime.model))
        return false;
    if (!isObject(preflight) || !Array.isArray(preflight.toolCatalog))
        return false;
    if (!isObject(snapshot) || !("promptStack" in snapshot))
        return false;
    return true;
}
//# sourceMappingURL=workspace.js.map