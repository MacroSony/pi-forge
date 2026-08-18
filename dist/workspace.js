import { randomUUID } from "node:crypto";
import { createResourceCatalog } from "./catalog.js";
import { hasAgentProfileErrors } from "./agent-profile.js";
import { readAgentProfilesScoped, readGlobalAgentProfiles } from "./repositories/agent-profile.js";
import { readGlobalPromptStacks, readPromptStacksScoped } from "./repositories/prompt-stack.js";
import { parseResourceSelector } from "./resource-identity.js";
import { validateListProfilesRequest, validatePrepareRequest, validatePrepareResponse, ForgeHost, } from "./subagent/host-port.js";
import { currentSubagentPromptRegistrationCatalog, prepareSubagentHostPlan, resolveSubagentHostProfile, } from "./subagent-host.js";
import { SUBAGENT_CONTRACT_VERSION, } from "./subagent/types.js";
/**
 * Minimal snapshot owner over the Lane 2a repositories/codecs. Owns one
 * genuinely immutable resource snapshot (scoped stack/profile catalogs plus
 * active selection/provenance references) and the host-port registration for
 * that snapshot. Reloads replace the whole snapshot; dispose tears down the
 * host.
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
    reload(cwd, options = {}) {
        // Untrusted projects must not expose project resources to in-process
        // consumers; mirror the runtime's global-only gating for those workspaces.
        const stacks = options.trusted === false ? readGlobalPromptStacks() : readPromptStacksScoped(cwd);
        const profiles = options.trusted === false ? readGlobalAgentProfiles() : readAgentProfilesScoped(cwd);
        const snapshot = {
            cwd,
            stacks,
            profiles,
            activeStackId: this.sources.activeStackId?.() ?? null,
            lastAppliedProfile: this.sources.lastAppliedProfile?.(),
            capturedAt: new Date().toISOString(),
        };
        this.current = deepFreeze(structuredClone(snapshot));
        return this.current;
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
            capabilities: ["listProfiles", "prepare"],
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
        if (operation === "prepare")
            return this.prepare(payload);
        return { ok: false, error: `Unknown Forge host operation: ${operation}` };
    }
    listProfiles(payload) {
        const validated = validateListProfilesRequest(payload);
        if (!validated.ok)
            return { ok: false, error: validated.error };
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
        const requestId = randomUUID();
        // The host only needs the access facts for tool negotiation; the full
        // runtime access/limit/execution request belongs to the backend and is
        // reconstructed there, not sent across this port.
        const agentRequest = {
            schemaVersion: SUBAGENT_CONTRACT_VERSION,
            requestId,
            profileId: request.profile,
            input: request.task,
            access: {
                level: request.access.level,
                network: request.access.network,
                allowProcess: request.access.allowProcess,
                executionBoundary: "shared-user",
                workspaces: [],
            },
            limits: {},
            resultProjection: { maxChars: 0 },
            parent: { depth: 0, maxDepth: 0 },
            remoteEgressConsent: false,
        };
        const preflight = {
            status: "accepted",
            preflightId: `forge-host-${requestId}`,
            backend: {
                id: "forge-host",
                version: "v1",
                capabilities: {
                    access: {
                        readOnlyMountIsolation: false,
                        readWriteMountIsolation: false,
                        symlinkSafeContainment: false,
                        processIsolation: false,
                        agentNetworkIsolation: false,
                    },
                    executionBoundaries: ["isolated"],
                    limits: {
                        timeoutMs: ["host-abort"],
                        maxTurns: ["host-abort"],
                        tokenBudget: ["host-abort"],
                        maxOutputBytes: ["host-abort"],
                    },
                    cancellation: true,
                    mediaMimeTypes: [],
                    traceInspection: false,
                    artifactRetention: false,
                    remoteTransport: false,
                    promptRuntimeFidelity: "backend-assisted",
                },
            },
            model: { ...request.backend.model },
            thinkingLevel: request.backend.thinkingLevel,
            toolCatalog: request.backend.toolCatalog.map((tool) => ({
                ...tool,
                name: tool.name ?? tool.id,
                effects: tool.effects ?? [],
            })),
            access: {
                level: request.access.level,
                mounts: [],
                network: request.access.network,
                process: false,
                executionBoundary: "shared-user",
            },
            limits: {},
            diagnostics: [],
        };
        const runtime = {
            baseSystemPrompt: "",
            options: {
                selectedTools: [],
                toolSnippets: {},
                promptGuidelines: [],
                cwd: snapshot.cwd,
                contextFiles: [],
                skills: [],
            },
            model: { ...request.backend.model },
            preparedAt: new Date().toISOString(),
            fidelity: "backend-assisted",
            promptRuntimeFingerprint: "sha256:v1:forge-host",
        };
        const output = prepareSubagentHostPlan({ request: agentRequest, snapshot: resolved.snapshot, preflight, runtime });
        return {
            profileId: request.profile,
            model: { ...request.backend.model },
            thinkingLevel: request.backend.thinkingLevel,
            systemPrompt: output.systemPrompt,
            messages: output.messages,
            effectiveToolIds: output.toolNegotiation.effectiveToolIds,
            effectiveToolNames: output.toolNegotiation.effectiveToolNames,
            diagnostics: output.diagnostics,
            profileSnapshot: resolved.snapshot,
            preparedAt: new Date().toISOString(),
        };
    }
    dispose() {
        if (this.host?.isLive)
            this.host.stop();
        this.host = undefined;
        this.current = undefined;
    }
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