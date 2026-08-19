import { createResourceCatalog } from "./catalog.js";
import { hasAgentProfileErrors } from "./agent-profile.js";
import { readAgentProfilesScoped, readGlobalAgentProfiles } from "./repositories/agent-profile.js";
import { readGlobalPromptStacks, readPromptStacksScoped } from "./repositories/prompt-stack.js";
import { chooseDefaultStack, isDisabledPromptStackId } from "./loader.js";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.js";
import { createForgeExtensionState, reloadForgeExtensions, unloadForgeExtensions } from "./forge-extensions.js";
import { validateListProfilesRequest, validatePrepareRequest, validatePrepareResponse, validateResolveProfileRequest, validateResolveProfileResponse, ForgeHost, } from "./subagent/host-port.js";
import { currentSubagentPromptRegistrationCatalog, prepareForgeDelegation, resolveSubagentHostProfile, } from "./subagent-host.js";
/**
 * Single owner of the Forge resource graph.
 *
 * Owns one coherent, deep-frozen snapshot containing stacks, profiles, active
 * selection, profile provenance, and extension lifecycle state. All readers
 * (commands, web UI, lifecycle, tool policy, preview, host port) consume
 * `snapshot()` instead of separate mutable bags.
 */
export class ForgeWorkspace {
    extensionState = createForgeExtensionState();
    current;
    host;
    get snapshotKnown() {
        return this.current !== undefined;
    }
    reload(cwd, options = {}) {
        const trusted = options.trusted !== false;
        const stacks = trusted ? readPromptStacksScoped(cwd) : readGlobalPromptStacks();
        if (this.extensionDiagnostics.length > 0) {
            for (const loaded of stacks)
                loaded.diagnostics.unshift(...this.extensionDiagnostics);
        }
        const profiles = trusted ? readAgentProfilesScoped(cwd) : readGlobalAgentProfiles();
        const active = this.resolveActive(stacks, options);
        const activeStackId = active ? formatResourceKey(active.key) : (options.activeStackId != null && isDisabledPromptStackId(options.activeStackId) ? "none" : null);
        const snapshot = {
            cwd,
            stacks,
            profiles,
            activeStackId,
            active,
            lastAppliedProfile: options.lastAppliedProfile ?? this.current?.lastAppliedProfile,
            extensionDiagnostics: this.extensionDiagnostics,
            extensionPaths: this.extensionPaths,
            capturedAt: new Date().toISOString(),
        };
        this.current = deepFreeze(structuredClone(snapshot));
        return this.current;
    }
    reloadProfiles(cwd, trusted = true) {
        if (!this.current)
            throw new Error("ForgeWorkspace has not been reloaded.");
        const profiles = trusted ? readAgentProfilesScoped(cwd) : readGlobalAgentProfiles();
        return this.publish({
            ...this.current,
            profiles,
            capturedAt: new Date().toISOString(),
        });
    }
    async loadExtensions(cwd) {
        const result = await reloadForgeExtensions(cwd, this.extensionState);
        this.extensionDiagnostics = result.diagnostics;
        this.extensionPaths = result.loadedPaths;
        return result;
    }
    disposeExtensions() {
        const diagnostics = unloadForgeExtensions(this.extensionState);
        this.extensionDiagnostics = diagnostics;
        this.extensionPaths = [];
        return diagnostics;
    }
    setActiveStack(id) {
        if (!this.current)
            return false;
        if (!id || isDisabledPromptStackId(id)) {
            this.publish({
                ...this.current,
                activeStackId: "none",
                active: undefined,
                capturedAt: new Date().toISOString(),
            });
            return true;
        }
        const parsed = parseResourceSelector(id);
        if (!parsed.ok)
            return false;
        const found = createResourceCatalog([...this.current.stacks]).resolveSelector(parsed.selector);
        if (!found)
            return false;
        this.publish({
            ...this.current,
            activeStackId: formatResourceKey(found.key),
            active: found,
            capturedAt: new Date().toISOString(),
        });
        return true;
    }
    setLastAppliedProfile(profile) {
        if (!this.current)
            throw new Error("ForgeWorkspace has not been reloaded.");
        this.publish({
            ...this.current,
            lastAppliedProfile: profile,
            capturedAt: new Date().toISOString(),
        });
    }
    // Read/write view used by profile-service's AgentProfileApplicationState.
    get active() {
        return this.current?.active;
    }
    set active(value) {
        if (!value) {
            this.setActiveStack(undefined);
            return;
        }
        if (!this.current)
            throw new Error("ForgeWorkspace has not been reloaded.");
        this.publish({
            ...this.current,
            activeStackId: formatResourceKey(value.key),
            active: value,
            capturedAt: new Date().toISOString(),
        });
    }
    get lastAppliedProfile() {
        return this.current?.lastAppliedProfile;
    }
    set lastAppliedProfile(value) {
        this.setLastAppliedProfile(value);
    }
    snapshot() {
        if (!this.current)
            throw new Error("ForgeWorkspace has not been reloaded.");
        return this.current;
    }
    /**
     * Register the host port for the current snapshot. Idempotent: the host is
     * only started once the first snapshot exists, so `available` never implies
     * an unloaded workspace. On reload the live host is kept (its generation
     * only changes via dispose).
     */
    startHostPort(transport) {
        if (!this.current)
            throw new Error("ForgeWorkspace must be reloaded before starting the host port.");
        if (this.host?.isLive)
            return this.host;
        const host = new ForgeHost(transport, {
            capabilities: ["listProfiles", "resolveProfile", "prepare"],
            handle: (operation, payload) => this.operate(operation, payload),
        });
        this.host = host;
        host.start();
        return host;
    }
    /** Invoke the minimal-operation surface against the current snapshot. */
    operate(operation, payload) {
        if (operation === "listProfiles")
            return this.listProfiles(payload);
        if (operation === "resolveProfile")
            return this.resolveProfile(payload);
        if (operation === "prepare")
            return this.prepare(payload);
        return { ok: false, error: `Unknown Forge host operation: ${operation}` };
    }
    listProfiles(payload) {
        const validated = validateListProfilesRequest(payload);
        if (!validated.ok)
            return { ok: false, error: validated.error };
        try {
            const snapshot = this.snapshot();
            return {
                ok: true,
                data: {
                    profiles: snapshot.profiles.map((loaded) => stripUndefined({
                        profileId: loaded.profile.id,
                        scope: loaded.scope,
                        name: loaded.profile.name,
                        description: loaded.profile.description,
                        autoActivate: loaded.profile.autoActivate,
                        model: { provider: loaded.profile.model.provider, id: loaded.profile.model.id },
                        thinkingLevel: loaded.profile.thinkingLevel,
                        promptStack: loaded.profile.promptStack,
                        usable: !hasAgentProfileErrors(loaded.diagnostics),
                        diagnostics: loaded.diagnostics,
                    })),
                },
            };
        }
        catch (error) {
            return { ok: false, error: `listProfiles failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    resolveProfile(payload) {
        const validated = validateResolveProfileRequest(payload);
        if (!validated.ok)
            return { ok: false, error: validated.error };
        const request = validated.data;
        try {
            const snapshot = this.resolveProfilePlan(request.profile);
            const response = { snapshot };
            const responseValidated = validateResolveProfileResponse(stripUndefined(response));
            if (!responseValidated.ok)
                return { ok: false, error: responseValidated.error };
            return { ok: true, data: stripUndefined(response) };
        }
        catch (error) {
            return { ok: false, error: `resolveProfile failed: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    /** Host-owned profile resolution returns the immutable profile snapshot artifact. */
    resolveProfilePlan(profile) {
        const snapshot = this.snapshot();
        const parsed = parseResourceSelector(profile);
        if (!parsed.ok)
            throw new Error(`Invalid profile selector ${profile}: ${parsed.error}`);
        const loaded = createResourceCatalog([...snapshot.profiles]).resolveSelector(parsed.selector);
        if (!loaded)
            throw new Error(`Unknown profile: ${profile}`);
        if (hasAgentProfileErrors(loaded.diagnostics))
            throw new Error(`Profile ${profile} failed loading validation.`);
        const resolved = resolveSubagentHostProfile(loaded, {
            promptStacks: snapshot.stacks,
            registrations: currentSubagentPromptRegistrationCatalog(),
        });
        if (!resolved.snapshot)
            throw new Error(`Profile ${profile} could not be resolved.`);
        return resolved.snapshot;
    }
    prepare(payload) {
        const validated = validatePrepareRequest(payload);
        if (!validated.ok)
            return { ok: false, error: validated.error };
        const request = validated.data;
        let response;
        try {
            response = stripUndefined(this.preparePlan(request));
        }
        catch (error) {
            return { ok: false, error: `Prepare failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        const responseValidated = validatePrepareResponse(response);
        if (!responseValidated.ok)
            return { ok: false, error: responseValidated.error };
        return { ok: true, data: response };
    }
    /** Host owns profile/stack resolution and prompt compilation. */
    preparePlan(request) {
        const snapshot = this.snapshot();
        const parsed = parseResourceSelector(request.profile);
        if (!parsed.ok)
            throw new Error(`Invalid profile selector ${request.profile}: ${parsed.error}`);
        const loaded = createResourceCatalog([...snapshot.profiles]).resolveSelector(parsed.selector);
        if (!loaded)
            throw new Error(`Unknown profile: ${request.profile}`);
        if (hasAgentProfileErrors(loaded.diagnostics))
            throw new Error(`Profile ${request.profile} failed loading validation.`);
        const resolved = resolveSubagentHostProfile(loaded, {
            promptStacks: snapshot.stacks,
            registrations: currentSubagentPromptRegistrationCatalog(),
        });
        if (!resolved.snapshot)
            throw new Error(`Profile ${request.profile} could not be resolved for preparation.`);
        const prepared = prepareForgeDelegation({
            snapshot: resolved.snapshot,
            task: request.task,
            access: request.access,
            backend: request.backend,
            cwd: snapshot.cwd,
        });
        return {
            profileId: request.profile,
            model: { ...request.backend.model },
            thinkingLevel: request.backend.thinkingLevel,
            systemPrompt: prepared.systemPrompt,
            messages: prepared.messages,
            effectiveToolIds: prepared.effectiveToolIds,
            effectiveToolNames: prepared.effectiveToolNames,
            diagnostics: prepared.diagnostics,
            profileSnapshot: resolved.snapshot,
            preparedAt: prepared.preparedAt,
        };
    }
    dispose() {
        this.disposeExtensions();
        if (this.host?.isLive)
            this.host.stop();
        this.host = undefined;
        this.current = undefined;
    }
    resolveActive(stacks, options) {
        if (options.suppressAutoActivate && options.activeStackId == null)
            return undefined;
        if (options.activeStackId != null) {
            if (isDisabledPromptStackId(options.activeStackId))
                return undefined;
            const parsed = parseResourceSelector(options.activeStackId);
            if (parsed.ok) {
                const found = createResourceCatalog([...stacks]).resolveSelector(parsed.selector);
                if (found)
                    return found;
            }
            // Persisted selection no longer resolves; fall back to the default stack
            // rather than silently starting with no active stack.
            return chooseDefaultStack([...stacks]);
        }
        return chooseDefaultStack([...stacks]);
    }
    publish(next) {
        this.current = deepFreeze(structuredClone(next));
        return this.current;
    }
    get extensionDiagnostics() {
        return this.extensionDiagnosticsValue;
    }
    set extensionDiagnostics(value) {
        this.extensionDiagnosticsValue = value;
    }
    get extensionPaths() {
        return this.extensionPathsValue;
    }
    set extensionPaths(value) {
        this.extensionPathsValue = value;
    }
    extensionDiagnosticsValue = [];
    extensionPathsValue = [];
}
function stripUndefined(value) {
    if (Array.isArray(value))
        return value.map(stripUndefined);
    if (value && typeof value === "object") {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (item === undefined)
                continue;
            result[key] = stripUndefined(item);
        }
        return result;
    }
    return value;
}
function deepFreeze(value) {
    const freeze = (current) => {
        if (current === null || typeof current !== "object")
            return;
        for (const key of Object.keys(current))
            freeze(current[key]);
        Object.freeze(current);
    };
    freeze(value);
    return value;
}
//# sourceMappingURL=workspace.js.map