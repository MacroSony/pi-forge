import { SUBAGENT_LIMIT_NAMES, error, isRecord, validateAccessEnforcement, validateAccessReceipt, validateBackendDescriptor, validateDiagnosticArray, validateLimitReceipt, validateModelReference, validateOpaqueId, validatePreparationRuntime, validateToolCatalog } from "./validation.js";
export function validateBackendPreflight(value, request, snapshot) {
    const diagnostics = [];
    if (!isRecord(value))
        return [error("preflight.type", "BackendPreflightResult must be an object.", "$")];
    if (value.status !== "accepted" && value.status !== "rejected")
        return [error("preflight.status", "status must be accepted or rejected.", "status")];
    validateOpaqueId(value.preflightId, "preflightId", diagnostics);
    if (!isRecord(value.backend))
        diagnostics.push(error("preflight.backend", "backend must be an object.", "backend"));
    else
        validateBackendDescriptor(value.backend, "backend", diagnostics);
    if (!Array.isArray(value.diagnostics))
        diagnostics.push(error("preflight.diagnostics", "diagnostics must be an array.", "diagnostics"));
    else
        validateDiagnosticArray(value.diagnostics, "diagnostics", diagnostics);
    if (value.status === "rejected") {
        if (!Array.isArray(value.diagnostics) || !value.diagnostics.some((item) => isRecord(item) && item.level === "error")) {
            diagnostics.push(error("preflight.rejection-error", "A rejected preflight must include an error diagnostic.", "diagnostics"));
        }
        return diagnostics;
    }
    if (Array.isArray(value.diagnostics) && value.diagnostics.some((item) => isRecord(item) && item.level === "error"))
        diagnostics.push(error("preflight.accepted-error", "An accepted preflight cannot contain error diagnostics.", "diagnostics"));
    validateModelReference(value.model, "model", diagnostics);
    if (typeof value.thinkingLevel !== "string")
        diagnostics.push(error("preflight.thinking", "thinkingLevel must be a string.", "thinkingLevel"));
    if (!Array.isArray(value.toolCatalog))
        diagnostics.push(error("preflight.tool-catalog", "toolCatalog must be an array.", "toolCatalog"));
    else
        validateToolCatalog(value.toolCatalog, diagnostics);
    validateAccessReceipt(value.access, "access", diagnostics);
    validateLimitReceipt(value.limits, "limits", diagnostics);
    if (isRecord(value.backend) && isRecord(value.backend.capabilities)) {
        const fidelity = value.backend.capabilities.promptRuntimeFidelity;
        if (fidelity === "exact-preflight") {
            validatePreparationRuntime(value.promptRuntime, "promptRuntime", diagnostics, "exact-preflight");
        }
        else if (value.promptRuntime !== undefined) {
            diagnostics.push(error("preflight.runtime-extra", "Only exact-preflight backends may include promptRuntime in preflight.", "promptRuntime"));
        }
    }
    if (request) {
        try {
            diagnostics.push(...validatePreflightAgainstRequest(value, request));
        }
        catch (validationError) {
            diagnostics.push(error("preflight.malformed", `Cannot compare malformed preflight with request: ${validationError instanceof Error ? validationError.message : String(validationError)}`, "$"));
        }
    }
    if (snapshot && isRecord(value.model)) {
        if (value.model.provider !== snapshot.profile.model.provider || value.model.id !== snapshot.profile.model.id) {
            diagnostics.push(error("preflight.model-mismatch", "Preflight model does not match the profile snapshot.", "model"));
        }
        if (value.thinkingLevel !== snapshot.profile.thinkingLevel) {
            diagnostics.push(error("preflight.thinking-mismatch", "Preflight thinkingLevel does not match the profile snapshot.", "thinkingLevel"));
        }
        if (isRecord(value.promptRuntime) && isRecord(value.promptRuntime.model)
            && (value.promptRuntime.model.provider !== value.model.provider || value.promptRuntime.model.id !== value.model.id)) {
            diagnostics.push(error("preflight.runtime-model", "Prompt runtime model does not match the resolved backend model.", "promptRuntime.model"));
        }
    }
    return diagnostics;
}
export function validatePreflightAgainstRequest(preflight, request) {
    const diagnostics = [];
    const capabilities = preflight.backend.capabilities;
    if (capabilities.remoteTransport && !request.remoteEgressConsent) {
        diagnostics.push(error("preflight.egress", "Remote backend transport requires explicit remoteEgressConsent.", "remoteEgressConsent"));
    }
    for (const media of request.input.media ?? []) {
        if (!capabilities.mediaMimeTypes.includes(media.mimeType)) {
            diagnostics.push(error("preflight.media", `Backend does not support media type ${media.mimeType}.`, `input.media.${media.id}`));
        }
    }
    diagnostics.push(...validateAccessEnforcement(request.access, preflight.access));
    for (const field of ["readOnlyMountIsolation", "readWriteMountIsolation", "symlinkSafeContainment", "processIsolation", "agentNetworkIsolation"]) {
        if (preflight.access.enforcement[field] && !capabilities.access[field])
            diagnostics.push(error("preflight.access-capability", `Access receipt claims unsupported capability ${field}.`, `access.enforcement.${field}`));
    }
    for (const name of SUBAGENT_LIMIT_NAMES) {
        const requirement = request.limits[name];
        if (!requirement)
            continue;
        const accepted = preflight.limits[name];
        if (!accepted) {
            const level = requirement.enforcement === "required" ? "error" : "warning";
            diagnostics.push({ level, code: "preflight.limit-missing", path: `limits.${name}`, message: `Backend did not accept ${name}.` });
            continue;
        }
        if (accepted.value > requirement.value) {
            diagnostics.push(error("preflight.limit-value", `Enforced ${name} must not exceed the requested maximum.`, `limits.${name}`));
        }
        if (requirement.enforcement === "required" && accepted.enforcement !== "backend-hard") {
            diagnostics.push(error("preflight.limit-enforcement", `${name} requires backend-hard enforcement.`, `limits.${name}`));
        }
        if (!capabilities.limits[name].includes(accepted.enforcement))
            diagnostics.push(error("preflight.limit-capability", `${name} receipt claims unsupported enforcement ${accepted.enforcement}.`, `limits.${name}`));
        if (name === "timeoutMs" && accepted.enforcement === "host-abort" && !capabilities.cancellation)
            diagnostics.push(error("preflight.timeout-cancellation", "host-abort timeout enforcement requires backend cancellation support.", `limits.${name}`));
    }
    for (const name of SUBAGENT_LIMIT_NAMES) {
        if (preflight.limits[name] && !request.limits[name])
            diagnostics.push(error("preflight.limit-extra", `Backend produced an unrequested ${name} limit receipt.`, `limits.${name}`));
    }
    return diagnostics;
}
//# sourceMappingURL=preflight.js.map