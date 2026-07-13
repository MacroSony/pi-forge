import { randomUUID } from "node:crypto";
import { SUBAGENT_CONTRACT_VERSION, canonicalSubagentJson, hasSubagentErrors, validateAgentExecutionPlan, validateAgentProfileSnapshot, validateAgentRequest, validateAgentResponse, validateBackendPreflight, validateSubagentTraceReference, } from "../subagent-contract.js";
export class SubagentBackendRegistryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "SubagentBackendRegistryError";
        this.code = code;
    }
}
export class SubagentBackendRegistry {
    #backends = new Map();
    #preflights = new Map();
    #traces = new Map();
    #activeRuns = new Map();
    #idFactory;
    #now;
    constructor(options = {}) {
        this.#idFactory = options.idFactory ?? ((kind) => `${kind}:${randomUUID()}`);
        this.#now = options.now ?? Date.now;
    }
    get size() {
        return this.#backends.size;
    }
    register(backend) {
        validateRegistration(backend);
        const id = backend.descriptor.id;
        if (this.#backends.has(id))
            throw new SubagentBackendRegistryError("backend.duplicate", `A subagent backend is already registered as ${id}.`);
        this.#backends.set(id, backend);
        return () => this.unregister(id);
    }
    unregister(backendId) {
        if ([...this.#activeRuns.values()].some((run) => run.backend.descriptor.id === backendId)) {
            throw new SubagentBackendRegistryError("backend.active", `Cannot unregister backend ${backendId} while one of its runs is active or draining.`);
        }
        const removed = this.#backends.delete(backendId);
        if (!removed)
            return false;
        for (const [id, record] of this.#preflights)
            if (record.backendId === backendId)
                this.#preflights.delete(id);
        for (const [handle, record] of this.#traces)
            if (record.reference.backendId === backendId)
                this.#traces.delete(handle);
        return true;
    }
    descriptors() {
        return [...this.#backends.values()]
            .map((backend) => structuredClone(backend.descriptor))
            .sort((left, right) => left.id.localeCompare(right.id));
    }
    async preflight(backendId, request, snapshot, signal) {
        const backend = this.#requireBackend(backendId);
        const inputDiagnostics = [...validateAgentRequest(request), ...validateAgentProfileSnapshot(snapshot)];
        if (hasSubagentErrors(inputDiagnostics))
            return this.#rejectedPreflight(backend, inputDiagnostics);
        if (signal?.aborted)
            return this.#rejectedPreflight(backend, [diagnostic("preflight.cancelled", "Preflight was cancelled before backend discovery.")]);
        let result;
        try {
            result = await backend.preflight({ request: structuredClone(request), snapshot: structuredClone(snapshot), signal });
        }
        catch (error) {
            return this.#rejectedPreflight(backend, [diagnostic("preflight.backend-error", errorMessage(error))]);
        }
        const diagnostics = validateBackendPreflight(result, request, snapshot);
        if (result.backend?.id !== backendId || !sameDescriptor(result.backend, backend.descriptor)) {
            diagnostics.push(diagnostic("preflight.backend-identity", "Backend preflight descriptor does not match its registered identity.", "backend"));
        }
        if (this.#preflights.has(result.preflightId))
            diagnostics.push(diagnostic("preflight.duplicate-id", "Backend reused an existing preflightId.", "preflightId"));
        if (hasSubagentErrors(diagnostics))
            return this.#rejectedPreflight(backend, diagnostics, validOpaqueId(result.preflightId) ? result.preflightId : undefined);
        if (result.status === "accepted") {
            this.#preflights.set(result.preflightId, {
                backendId,
                requestId: request.requestId,
                profileFingerprint: snapshot.profileFingerprint,
            });
        }
        return structuredClone(result);
    }
    async prepare(backendId, input, hostPreparer, signal) {
        const backend = this.#requireBackend(backendId);
        this.#assertPreflightBinding(input.preflight, input.request, input.snapshot);
        if (signal?.aborted)
            throw new SubagentBackendRegistryError("preparation.cancelled", "Preparation was cancelled before it started.");
        const fidelity = backend.descriptor.capabilities.promptRuntimeFidelity;
        if (fidelity === "partial")
            throw new SubagentBackendRegistryError("preparation.partial", "A partial prompt runtime cannot prepare an execution plan.");
        if (fidelity === "exact-preflight")
            return structuredClone(await hostPreparer(structuredClone(input)));
        if (!backend.prepare)
            throw new SubagentBackendRegistryError("preparation.unsupported", `Backend ${backendId} advertises backend-assisted preparation but has no prepare method.`);
        return structuredClone(await backend.prepare(structuredClone(input), { signal, prepare: hostPreparer }));
    }
    async execute(plan, options) {
        const backend = this.#requireBackend(plan.backendId);
        const planDiagnostics = validateAgentExecutionPlan(plan);
        if (hasSubagentErrors(planDiagnostics))
            throw new SubagentBackendRegistryError("execution.invalid-plan", summarizeDiagnostics(planDiagnostics));
        const preflightRecord = this.#preflights.get(plan.preflightId);
        if (!preflightRecord
            || preflightRecord.backendId !== plan.backendId
            || preflightRecord.requestId !== plan.requestId
            || preflightRecord.profileFingerprint !== plan.profile.profileFingerprint) {
            throw new SubagentBackendRegistryError("execution.unbound-preflight", "Execution plan is not bound to an accepted registry preflight.");
        }
        if (!validNamespace(options.authorizationScope))
            throw new SubagentBackendRegistryError("execution.authorization", "authorizationScope must be a normalized namespace.");
        if (this.#activeRuns.has(plan.runId))
            throw new SubagentBackendRegistryError("execution.duplicate-run", `Run ${plan.runId} is already active.`);
        const startedAt = this.#now();
        const controller = new AbortController();
        let resolveTerminal;
        const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
        const active = { backend, plan, controller, settled: false };
        this.#activeRuns.set(plan.runId, active);
        let timeout;
        let externalAbort;
        const settle = (response) => {
            if (active.settled)
                return false;
            active.settled = true;
            if (timeout)
                clearTimeout(timeout);
            if (externalAbort && options.signal)
                options.signal.removeEventListener("abort", externalAbort);
            resolveTerminal(response);
            return true;
        };
        const cancelRun = (kind, reason) => {
            if (active.settled)
                return;
            controller.abort(reason);
            active.cancelPromise = Promise.resolve(backend.cancel?.({ runId: plan.runId, reason })).catch(() => undefined);
            const durationMs = elapsed(this.#now(), startedAt);
            settle(kind === "timed-out"
                ? { ...responseCommon(plan, durationMs), status: "timed-out", reason, enforcedTimeoutMs: plan.limits.timeoutMs.value }
                : { ...responseCommon(plan, durationMs), status: "cancelled", reason });
        };
        active.requestCancellation = cancelRun;
        if (options.signal) {
            externalAbort = () => cancelRun("cancelled", abortReason(options.signal, "user"));
            if (options.signal.aborted)
                externalAbort();
            else
                options.signal.addEventListener("abort", externalAbort, { once: true });
        }
        const timeoutLimit = plan.limits.timeoutMs;
        if (!active.settled && timeoutLimit?.enforcement === "host-abort") {
            timeout = setTimeout(() => cancelRun("timed-out", "host timeout"), timeoutLimit.value);
        }
        const backendExecution = Promise.resolve()
            .then(() => backend.execute(structuredClone(plan), { signal: controller.signal }))
            .then((result) => {
            if (active.settled)
                return;
            settle(this.#normalizeBackendResponse(result, plan, options.authorizationScope, elapsed(this.#now(), startedAt)));
        })
            .catch((error) => {
            if (active.settled)
                return;
            settle({
                ...responseCommon(plan, elapsed(this.#now(), startedAt)),
                status: "failed",
                error: { code: "backend-execution", message: errorMessage(error), retryable: false },
            });
        })
            .finally(() => {
            if (timeout)
                clearTimeout(timeout);
            if (externalAbort && options.signal)
                options.signal.removeEventListener("abort", externalAbort);
            if (this.#activeRuns.get(plan.runId) === active)
                this.#activeRuns.delete(plan.runId);
        });
        void backendExecution;
        return terminal;
    }
    async cancel(runId, reason = "user") {
        const active = this.#activeRuns.get(runId);
        if (!active || active.settled)
            return false;
        active.requestCancellation?.("cancelled", reason);
        await active.cancelPromise;
        return true;
    }
    async inspectTrace(reference, authorizationScope, signal) {
        const diagnostics = validateSubagentTraceReference(reference);
        if (hasSubagentErrors(diagnostics))
            throw new SubagentBackendRegistryError("trace.invalid", summarizeDiagnostics(diagnostics));
        const record = this.#traces.get(reference.handle);
        if (!record || !sameTraceReference(record.reference, reference))
            throw new SubagentBackendRegistryError("trace.unknown", "Trace handle is unknown or does not match its registered route.");
        if (reference.authorizationScope !== authorizationScope)
            throw new SubagentBackendRegistryError("trace.forbidden", "Trace authorization scope does not match the caller.");
        if (reference.expiresAt && Date.parse(reference.expiresAt) <= this.#now()) {
            this.#traces.delete(reference.handle);
            throw new SubagentBackendRegistryError("trace.expired", "Trace handle has expired.");
        }
        const backend = this.#requireBackend(reference.backendId);
        if (!backend.descriptor.capabilities.traceInspection || !backend.inspectTrace) {
            throw new SubagentBackendRegistryError("trace.unsupported", `Backend ${reference.backendId} does not support trace inspection.`);
        }
        return backend.inspectTrace({ traceId: record.backendTraceId, signal });
    }
    forgetTrace(handle) {
        return this.#traces.delete(handle);
    }
    #requireBackend(backendId) {
        const backend = this.#backends.get(backendId);
        if (!backend)
            throw new SubagentBackendRegistryError("backend.unknown", `Unknown subagent backend: ${backendId}`);
        return backend;
    }
    #assertPreflightBinding(preflight, request, snapshot) {
        const record = this.#preflights.get(preflight.preflightId);
        if (!record
            || record.backendId !== preflight.backend.id
            || record.requestId !== request.requestId
            || record.profileFingerprint !== snapshot.profileFingerprint) {
            throw new SubagentBackendRegistryError("preparation.unbound-preflight", "Preparation input is not bound to an accepted registry preflight.");
        }
    }
    #rejectedPreflight(backend, diagnostics, preflightId) {
        return {
            status: "rejected",
            preflightId: preflightId ?? this.#idFactory("preflight"),
            backend: structuredClone(backend.descriptor),
            diagnostics: ensureErrorDiagnostics(diagnostics),
        };
    }
    #normalizeBackendResponse(result, plan, authorizationScope, durationMs) {
        let trace;
        if (result.trace) {
            if (!validOpaqueId(result.trace.id) || (result.trace.expiresAt !== undefined && !validIsoDate(result.trace.expiresAt))) {
                return invalidBackendResponse(plan, durationMs, "Backend returned malformed trace routing metadata.");
            }
            trace = {
                handle: this.#uniqueId("trace", this.#traces),
                backendId: plan.backendId,
                authorizationScope,
                expiresAt: result.trace.expiresAt,
            };
        }
        const { trace: _backendTrace, ...responseFields } = result;
        const response = { ...responseFields, durationMs, trace };
        const diagnostics = validateAgentResponse(response, { plan });
        if (hasSubagentErrors(diagnostics))
            return invalidBackendResponse(plan, durationMs, summarizeDiagnostics(diagnostics));
        if (trace && result.trace)
            this.#traces.set(trace.handle, { reference: trace, backendTraceId: result.trace.id });
        return structuredClone(response);
    }
    #uniqueId(kind, values) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const id = this.#idFactory(kind);
            if (validOpaqueId(id) && !values.has(id))
                return id;
        }
        throw new SubagentBackendRegistryError(`${kind}.id`, `Could not allocate a unique valid ${kind} identifier.`);
    }
}
function validateRegistration(backend) {
    if (!backend || typeof backend !== "object")
        throw new SubagentBackendRegistryError("backend.type", "Subagent backend must be an object.");
    if (typeof backend.preflight !== "function" || typeof backend.execute !== "function") {
        throw new SubagentBackendRegistryError("backend.methods", "Subagent backend must implement preflight and execute.");
    }
    const diagnostics = validateBackendPreflight({
        status: "rejected",
        preflightId: "descriptor-check",
        backend: backend.descriptor,
        diagnostics: [diagnostic("backend.descriptor-check", "Descriptor validation sentinel.")],
    });
    if (hasSubagentErrors(diagnostics))
        throw new SubagentBackendRegistryError("backend.descriptor", summarizeDiagnostics(diagnostics));
    if (backend.descriptor.capabilities.promptRuntimeFidelity === "backend-assisted" && typeof backend.prepare !== "function") {
        throw new SubagentBackendRegistryError("backend.prepare", "A backend-assisted backend must implement prepare.");
    }
    if (backend.descriptor.capabilities.traceInspection && typeof backend.inspectTrace !== "function") {
        throw new SubagentBackendRegistryError("backend.trace", "A trace-inspection backend must implement inspectTrace.");
    }
}
function responseCommon(plan, durationMs) {
    return {
        schemaVersion: SUBAGENT_CONTRACT_VERSION,
        requestId: plan.requestId,
        runId: plan.runId,
        backendId: plan.backendId,
        profileFingerprint: plan.profile.profileFingerprint,
        executionFingerprint: plan.executionFingerprint,
        model: structuredClone(plan.model),
        effectiveToolIds: [...plan.effectiveToolIds],
        enforcement: { access: structuredClone(plan.access), limits: structuredClone(plan.limits) },
        durationMs,
        artifacts: [],
    };
}
function invalidBackendResponse(plan, durationMs, detail) {
    return {
        ...responseCommon(plan, durationMs),
        status: "failed",
        error: { code: "backend-invalid-response", message: detail, retryable: false },
    };
}
function diagnostic(code, message, path) {
    return { level: "error", code, message, path };
}
function ensureErrorDiagnostics(diagnostics) {
    const cloned = structuredClone(diagnostics);
    if (cloned.some((item) => item.level === "error"))
        return [...cloned];
    return [diagnostic("registry.rejected", "Registry rejected the backend operation."), ...cloned];
}
function summarizeDiagnostics(diagnostics) {
    return diagnostics.filter((item) => item.level === "error").slice(0, 4).map((item) => `${item.code}: ${item.message}`).join("; ") || "Subagent validation failed.";
}
function sameDescriptor(left, right) {
    try {
        return canonicalSubagentJson(left) === canonicalSubagentJson(right);
    }
    catch {
        return false;
    }
}
function sameTraceReference(left, right) {
    return left.handle === right.handle
        && left.backendId === right.backendId
        && left.authorizationScope === right.authorizationScope
        && left.expiresAt === right.expiresAt;
}
function validOpaqueId(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function validNamespace(value) {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
function validIsoDate(value) {
    return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function elapsed(now, start) {
    return Math.max(0, now - start);
}
function abortReason(signal, fallback) {
    if (!signal)
        return fallback;
    return typeof signal.reason === "string" && signal.reason.trim() ? signal.reason : fallback;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=backend-registry.js.map