import { randomUUID } from "node:crypto";
import { createExecutionRuntime, error, } from "@zihanw/pi-subagent-runtime";
import { PI_READ_ONLY_TOOL_CATALOG, PiSubprocessBackend, } from "@zihanw/pi-subagent-runtime/backends/subprocess";
import { PiRpcBackend, } from "@zihanw/pi-subagent-runtime/backends/rpc";
import { MAX_SUBAGENT_TIMEOUT_MS, MIN_SUBAGENT_TIMEOUT_MS, isValidSubagentTimeoutMs, loadForgeSubagentSettings, resolveSubagentProfilePolicy, } from "../forge-config.js";
import { SUBAGENT_CONTRACT_VERSION, createAgentExecutionPlan, hasSubagentErrors, negotiateSubagentTools, } from "../subagent/contract.js";
import { prepareSubagentHostPlan, resolveSubagentHostProfile } from "../subagent-host.js";
export function createForgeSubagentRuntime(state, options = {}) {
    let generation;
    const prepared = new Map();
    const reports = new Map();
    // Backend IDs are fixed at construction; keep them available without an
    // extension context for command completions and settings validation.
    const backendIds = ["pi-subprocess-readonly", "pi-rpc-readonly"];
    function ensure(ctx) {
        if (generation && generation.modelRegistry === ctx.modelRegistry && generation.cwd === ctx.cwd)
            return generation;
        if (generation) {
            void generation.runtime.dispose();
            for (const backend of generation.backends.values())
                void backend.dispose();
        }
        const runtime = createExecutionRuntime();
        const subprocess = new PiSubprocessBackend({
            modelRegistry: ctx.modelRegistry,
            cwd: ctx.cwd,
            ...options.subprocess,
        });
        const rpc = new PiRpcBackend({
            modelRegistry: ctx.modelRegistry,
            cwd: ctx.cwd,
            ...options.rpc,
        });
        const backends = new Map([
            [subprocess.descriptor.id, subprocess],
            [rpc.descriptor.id, rpc],
        ]);
        for (const backend of backends.values())
            runtime.registerBackend(backend);
        generation = { runtime, backends, modelRegistry: ctx.modelRegistry, cwd: ctx.cwd };
        return generation;
    }
    function descriptors(ctx) {
        return ensure(ctx).runtime.listBackends().map(descriptorForHost);
    }
    async function prepare(profileId, task, ctx, run) {
        const diagnostics = [];
        if (!ctx.isProjectTrusted())
            return { ok: false, diagnostics: [error("host.trust", "Project is not trusted; subagent profiles remain disabled.")] };
        const matches = state.profiles.filter((candidate) => candidate.profile.id === profileId);
        if (matches.length !== 1) {
            return { ok: false, diagnostics: [error(matches.length === 0 ? "host.profile-missing" : "host.profile-ambiguous", matches.length === 0 ? `Unknown agent profile: ${profileId}` : `Agent profile id is ambiguous: ${profileId}`)] };
        }
        const policy = resolveSubagentProfilePolicy(loadForgeSubagentSettings(ctx), profileId);
        if (!policy.enabled) {
            return {
                ok: false,
                diagnostics: [error("host.profile-disabled", `Agent profile "${profileId}" is not enabled for subagent delegation in subagents.profiles.`)],
            };
        }
        const timeoutMs = run?.timeoutMs ?? policy.timeout.milliseconds;
        if (!isValidSubagentTimeoutMs(timeoutMs)) {
            return {
                ok: false,
                diagnostics: [error("host.timeout", `Subagent timeout must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`)],
            };
        }
        const resolution = resolveSubagentHostProfile(matches[0], { promptStacks: state.stacks });
        diagnostics.push(...resolution.diagnostics);
        if (!resolution.snapshot || hasSubagentErrors(diagnostics))
            return { ok: false, diagnostics };
        const snapshot = resolution.snapshot;
        const request = {
            schemaVersion: SUBAGENT_CONTRACT_VERSION,
            requestId: `request:${randomUUID()}`,
            profileId,
            expectedProfileFingerprint: snapshot.profileFingerprint,
            input: { text: task },
            access: {
                level: "read-only",
                workspaces: [{ handle: "project", mode: "read-only" }],
                workingDirectory: { workspaceHandle: "project", path: "." },
                network: "allow",
                executionBoundary: "shared-user",
            },
            limits: { timeoutMs: { value: timeoutMs, enforcement: "best-effort" } },
            resultProjection: { maxChars: 12_000 },
            parent: { sessionId: ctx.sessionManager.getSessionId(), depth: 0, maxDepth: 1 },
            // The command layer obtains explicit user consent before execution. A dry plan
            // never transports data but prepares the exact request that would be executable.
            remoteEgressConsent: true,
        };
        const current = ensure(ctx);
        const backendId = run?.backendId ?? options.backendId ?? policy.backend.id;
        const backend = current.backends.get(backendId);
        if (!backend)
            return { ok: false, diagnostics: [error("host.backend", `Backend is not registered: ${backendId}`)] };
        const intent = executionIntentFor(request, snapshot);
        let hostPreparation;
        let handle;
        try {
            handle = await current.runtime.prepare({
                backendId,
                intent,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
                compile: async (promptRuntime, acceptedPreflight) => {
                    const output = prepareSubagentHostPlan({
                        request,
                        snapshot,
                        preflight: preflightForHost(acceptedPreflight),
                        runtime: promptRuntime,
                    });
                    hostPreparation = output;
                    return {
                        systemPrompt: output.systemPrompt,
                        messages: output.messages.map(portableMessage),
                    };
                },
            });
        }
        catch (prepareError) {
            diagnostics.push(error("host.preparation", prepareError instanceof Error ? prepareError.message : String(prepareError)));
            return { ok: false, diagnostics };
        }
        const sealed = handle.snapshot();
        diagnostics.push(...sealed.preflight.diagnostics);
        if (!hostPreparation) {
            await handle.discard();
            diagnostics.push(error("host.preparation", "Host compilation did not complete."));
            return { ok: false, diagnostics };
        }
        diagnostics.push(...hostPreparation.diagnostics, ...hostPreparation.toolNegotiation.diagnostics);
        const planned = createAgentExecutionPlan({
            runId: handle.id,
            request,
            snapshot,
            preflight: preflightForHost(sealed.preflight),
            preparation: hostPreparation,
            runtime: sealed.promptRuntime,
            conversationFingerprint: sealed.conversationFingerprint,
            executionFingerprint: sealed.executionFingerprint,
        });
        diagnostics.push(...planned.diagnostics);
        if (!planned.plan || hasSubagentErrors(diagnostics)) {
            await handle.discard();
            return { ok: false, diagnostics };
        }
        // The runtime owns the conversation and execution fingerprints; the plan
        // constructed above carries the sealed values that approval displays and
        // execution binds to. The host never recomputes them.
        prepared.set(handle.id, { generation: current, handle, backend });
        return { ok: true, prepared: { request, preflight: planned.plan.preflight, plan: planned.plan, diagnostics } };
    }
    async function discard(preparedRun) {
        const record = prepared.get(preparedRun.plan.runId);
        if (!record)
            return;
        prepared.delete(preparedRun.plan.runId);
        await record.handle.discard();
    }
    async function execute(preparedRun, ctx, signal, onUpdate) {
        const record = prepared.get(preparedRun.plan.runId);
        if (!record)
            throw new Error("Subagent prepared run is unknown to this runtime generation.");
        const current = ensure(ctx);
        if (record.generation !== current)
            throw new Error("Subagent prepared run belongs to a previous runtime generation.");
        prepared.delete(preparedRun.plan.runId);
        const run = current.runtime.execute(record.handle);
        reports.set(run.id, { backend: record.backend, preparedRunId: record.handle.id });
        if (onUpdate) {
            run.subscribe((event) => {
                onUpdate({
                    phase: event.phase,
                    message: event.message,
                    ...(event.details === undefined ? {} : { details: event.details }),
                });
            });
        }
        let cancelOnAbort;
        if (signal) {
            cancelOnAbort = () => { void run.cancel(cancelReason(signal)); };
            if (signal.aborted)
                cancelOnAbort();
            else
                signal.addEventListener("abort", cancelOnAbort, { once: true });
        }
        try {
            const result = await run.result;
            return responseForHost(preparedRun, result);
        }
        finally {
            if (signal && cancelOnAbort) {
                signal.removeEventListener("abort", cancelOnAbort);
            }
        }
    }
    function takeReport(runId) {
        const location = reports.get(runId);
        if (!location)
            return undefined;
        reports.delete(runId);
        // Both process backends sanitize retained reports at the source.
        return location.backend.takeReport(location.preparedRunId);
    }
    async function dispose() {
        prepared.clear();
        reports.clear();
        if (!generation)
            return;
        await generation.runtime.dispose();
        await Promise.all([...generation.backends.values()].map((backend) => backend.dispose()));
        generation = undefined;
    }
    return { backendIds: () => [...backendIds], descriptors, prepare, discard, execute, takeReport, dispose };
}
function executionIntentFor(request, snapshot) {
    const negotiation = negotiateSubagentTools(forgeToolCatalog(), snapshot.promptStack?.tools, request.access);
    return {
        model: structuredClone(snapshot.profile.model),
        thinkingLevel: snapshot.profile.thinkingLevel,
        requestedTools: negotiation.effectiveToolNames,
        access: {
            level: request.access.level,
            executionBoundary: "shared-user",
            workspaces: structuredClone(request.access.workspaces),
            ...(request.access.workingDirectory ? { workingDirectory: structuredClone(request.access.workingDirectory) } : {}),
            network: request.access.network,
            ...(request.access.allowProcess === undefined ? {} : { allowProcess: request.access.allowProcess }),
        },
        limits: structuredClone(request.limits),
        provenance: {
            profile: snapshot.profileFingerprint,
            profileId: snapshot.profile.id,
            ...(snapshot.promptStackFingerprint ? { promptStack: snapshot.promptStackFingerprint } : {}),
        },
    };
}
function forgeToolCatalog() {
    return PI_READ_ONLY_TOOL_CATALOG.map((tool) => ({
        ...structuredClone(tool),
        effects: [...tool.effects],
    }));
}
function preflightForHost(preflight) {
    return {
        status: "accepted",
        preflightId: preflight.preflightId,
        backend: descriptorForHost(preflight.backend),
        model: structuredClone(preflight.model),
        thinkingLevel: (preflight.thinkingLevel ?? "medium"),
        toolCatalog: structuredClone(preflight.toolCatalog),
        access: structuredClone(preflight.access),
        limits: structuredClone(preflight.limits),
        ...(preflight.promptRuntime ? { promptRuntime: preflight.promptRuntime } : {}),
        diagnostics: [...preflight.diagnostics].map((diagnostic) => ({ ...diagnostic })),
    };
}
function descriptorForHost(descriptor) {
    return {
        id: descriptor.id,
        version: descriptor.version,
        capabilities: {
            access: structuredClone(descriptor.capabilities.access),
            executionBoundaries: [...descriptor.capabilities.executionBoundaries],
            limits: structuredClone(descriptor.capabilities.limits),
            cancellation: descriptor.capabilities.cancellation,
            mediaMimeTypes: [...descriptor.capabilities.mediaMimeTypes],
            traceInspection: false,
            artifactRetention: false,
            remoteTransport: descriptor.capabilities.remoteTransport,
            promptRuntimeFidelity: descriptor.capabilities.promptRuntimeFidelity,
        },
    };
}
function portableMessage(message) {
    return { role: message.role, content: structuredClone(message.content) };
}
function responseForHost(prepared, result) {
    const common = {
        schemaVersion: SUBAGENT_CONTRACT_VERSION,
        requestId: prepared.request.requestId,
        runId: result.runId,
        backendId: result.backendId,
        profileFingerprint: prepared.plan.profile.profileFingerprint,
        executionFingerprint: result.executionFingerprint,
        model: structuredClone(result.model),
        effectiveToolIds: [...result.effectiveToolIds],
        enforcement: {
            access: structuredClone(result.enforcement.access),
            limits: structuredClone(result.enforcement.limits),
        },
        durationMs: result.durationMs,
        artifacts: [],
        ...(result.usage ? { usage: structuredClone(result.usage) } : {}),
    };
    const partialOutput = result.output ? { text: result.output.text, partial: true } : undefined;
    switch (result.status) {
        case "completed":
            return { ...common, status: "completed", output: { text: result.output.text, partial: false } };
        case "failed":
            return {
                ...common,
                status: "failed",
                error: structuredClone(result.error),
                ...(partialOutput ? { output: partialOutput } : {}),
            };
        case "cancelled":
            return {
                ...common,
                status: "cancelled",
                reason: result.reason,
                ...(partialOutput ? { output: partialOutput } : {}),
            };
        case "timed-out":
            return {
                ...common,
                status: "timed-out",
                reason: result.reason,
                enforcedTimeoutMs: result.enforcedTimeoutMs,
                ...(partialOutput ? { output: partialOutput } : {}),
            };
        case "limit-reached":
            return {
                ...common,
                status: "limit-reached",
                reachedLimit: result.reachedLimit,
                ...(partialOutput ? { output: partialOutput } : {}),
            };
    }
}
function cancelReason(signal) {
    return typeof signal.reason === "string" && signal.reason ? signal.reason : "Subagent execution cancelled.";
}
//# sourceMappingURL=subagent-runtime.js.map