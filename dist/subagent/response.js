import { canonicalSubagentJson } from "./canonical.js";
import { SUBAGENT_CONTRACT_VERSION } from "./types.js";
import { SUBAGENT_LIMIT_NAMES, error, isIsoDate, isNonNegativeFinite, isPositiveInteger, isRecord, isSafeRelativePath, validateAccessReceipt, validateFingerprint, validateLimitReceipt, validateModelReference, validateNamespace, validateOpaqueId, validateUniqueStringArray, validateUsage } from "./validation.js";
export function validateAgentResponse(response, context) {
    const diagnostics = [];
    if (!isRecord(response))
        return [error("response.type", "AgentResponse must be an object.", "$")];
    if (!SUBAGENT_RESPONSE_STATUSES.includes(response.status))
        diagnostics.push(error("response.status", "Unsupported response status.", "status"));
    if (response.schemaVersion !== SUBAGENT_CONTRACT_VERSION)
        diagnostics.push(error("response.schema-version", "schemaVersion must be 1.", "schemaVersion"));
    for (const id of ["requestId", "runId", "backendId"])
        validateOpaqueId(response[id], id, diagnostics);
    validateFingerprint(response.profileFingerprint, "profileFingerprint", diagnostics);
    validateFingerprint(response.executionFingerprint, "executionFingerprint", diagnostics);
    validateModelReference(response.model, "model", diagnostics);
    if (!Array.isArray(response.effectiveToolIds))
        diagnostics.push(error("response.tools", "effectiveToolIds must be a string array.", "effectiveToolIds"));
    else
        validateUniqueStringArray(response.effectiveToolIds, "effectiveToolIds", diagnostics);
    if (!isNonNegativeFinite(response.durationMs))
        diagnostics.push(error("response.duration", "durationMs must be a non-negative finite number.", "durationMs"));
    if (!Array.isArray(response.artifacts))
        diagnostics.push(error("response.artifacts", "artifacts must be an array.", "artifacts"));
    else
        response.artifacts.forEach((artifact, index) => diagnostics.push(...validateSubagentArtifactReference(artifact, `artifacts[${index}]`)));
    if (response.trace !== undefined) {
        diagnostics.push(...validateSubagentTraceReference(response.trace, "trace"));
        if (isRecord(response.trace) && response.trace.backendId !== response.backendId)
            diagnostics.push(error("response.trace-backend", "Trace backendId must match response backendId.", "trace.backendId"));
    }
    if (response.usage !== undefined)
        validateUsage(response.usage, "usage", diagnostics);
    if (!isRecord(response.enforcement))
        diagnostics.push(error("response.enforcement", "enforcement must be an object.", "enforcement"));
    else {
        validateAccessReceipt(response.enforcement.access, "enforcement.access", diagnostics);
        validateLimitReceipt(response.enforcement.limits, "enforcement.limits", diagnostics);
    }
    validateResponseStatusMatrix(response, diagnostics);
    if (context?.request && response.requestId !== context.request.requestId)
        diagnostics.push(error("response.request-id", "requestId does not match the request.", "requestId"));
    if (context?.plan) {
        if (response.requestId !== context.plan.requestId)
            diagnostics.push(error("response.request-plan-id", "requestId does not match the execution plan.", "requestId"));
        if (response.runId !== context.plan.runId)
            diagnostics.push(error("response.run-id", "runId does not match the execution plan.", "runId"));
        if (response.backendId !== context.plan.backendId)
            diagnostics.push(error("response.backend-id", "backendId does not match the execution plan.", "backendId"));
        if (response.executionFingerprint !== context.plan.executionFingerprint)
            diagnostics.push(error("response.execution-fingerprint", "executionFingerprint does not match the execution plan.", "executionFingerprint"));
        if (response.profileFingerprint !== context.plan.profile.profileFingerprint)
            diagnostics.push(error("response.profile-fingerprint", "profileFingerprint does not match the execution plan.", "profileFingerprint"));
        if (response.status === "timed-out" && response.enforcedTimeoutMs !== context.plan.limits.timeoutMs?.value)
            diagnostics.push(error("response.timeout-receipt", "enforcedTimeoutMs does not match the execution plan timeout receipt.", "enforcedTimeoutMs"));
        if (response.status === "limit-reached" && !context.plan.limits[response.reachedLimit])
            diagnostics.push(error("response.limit-receipt-missing", "reachedLimit has no enforcement receipt in the execution plan.", "reachedLimit"));
        if (response.trace !== undefined && !context.plan.preflight.backend.capabilities.traceInspection)
            diagnostics.push(error("response.trace-capability", "Backend returned a trace without advertising traceInspection.", "trace"));
        if (Array.isArray(response.artifacts) && response.artifacts.length > 0 && !context.plan.preflight.backend.capabilities.artifactRetention)
            diagnostics.push(error("response.artifact-capability", "Backend returned artifacts without advertising artifactRetention.", "artifacts"));
        try {
            if (canonicalSubagentJson(response.model) !== canonicalSubagentJson(context.plan.model))
                diagnostics.push(error("response.model-mismatch", "Response model does not match the execution plan.", "model"));
            if (Array.isArray(response.effectiveToolIds) && canonicalSubagentJson(response.effectiveToolIds) !== canonicalSubagentJson(context.plan.effectiveToolIds))
                diagnostics.push(error("response.tools-mismatch", "effectiveToolIds do not match the execution plan.", "effectiveToolIds"));
            if (isRecord(response.enforcement)) {
                if (canonicalSubagentJson(response.enforcement.access) !== canonicalSubagentJson(context.plan.access))
                    diagnostics.push(error("response.access-receipt", "Access enforcement receipt does not match the execution plan.", "enforcement.access"));
                if (canonicalSubagentJson(response.enforcement.limits) !== canonicalSubagentJson(context.plan.limits))
                    diagnostics.push(error("response.limit-receipt", "Limit enforcement receipt does not match the execution plan.", "enforcement.limits"));
            }
        }
        catch (validationError) {
            diagnostics.push(error("response.malformed", `Cannot compare malformed response with plan: ${validationError instanceof Error ? validationError.message : String(validationError)}`, "$"));
        }
    }
    return diagnostics;
}
export function validateSubagentArtifactReference(value, path = "artifact") {
    const diagnostics = [];
    if (!isRecord(value))
        return [error("artifact.type", "Artifact reference must be an object.", path)];
    validateOpaqueId(value.id, `${path}.id`, diagnostics);
    validateNamespace(value.workspaceNamespace, `${path}.workspaceNamespace`, diagnostics);
    if (!isSafeRelativePath(value.path))
        diagnostics.push(error("artifact.path", "Artifact path must be a normalized relative POSIX path without dot segments.", `${path}.path`));
    if (value.authorization !== "read" && value.authorization !== "write")
        diagnostics.push(error("artifact.authorization", "authorization must be read or write.", `${path}.authorization`));
    if (!SUBAGENT_ARTIFACT_LIFETIMES.includes(value.lifetime))
        diagnostics.push(error("artifact.lifetime", "Unsupported artifact lifetime.", `${path}.lifetime`));
    if (!SUBAGENT_ARTIFACT_CLEANUP.includes(value.cleanup))
        diagnostics.push(error("artifact.cleanup", "Unsupported artifact cleanup owner.", `${path}.cleanup`));
    return diagnostics;
}
export function validateSubagentTraceReference(value, path = "trace") {
    const diagnostics = [];
    if (!isRecord(value))
        return [error("trace.type", "Trace reference must be an object.", path)];
    validateOpaqueId(value.handle, `${path}.handle`, diagnostics);
    validateOpaqueId(value.backendId, `${path}.backendId`, diagnostics);
    validateNamespace(value.authorizationScope, `${path}.authorizationScope`, diagnostics);
    if (value.expiresAt !== undefined && !isIsoDate(value.expiresAt))
        diagnostics.push(error("trace.expiry", "expiresAt must be an ISO date-time string.", `${path}.expiresAt`));
    return diagnostics;
}
const SUBAGENT_RESPONSE_STATUSES = ["completed", "failed", "cancelled", "timed-out", "limit-reached"];
const SUBAGENT_ARTIFACT_LIFETIMES = ["run", "session", "persistent"];
const SUBAGENT_ARTIFACT_CLEANUP = ["backend", "host", "user"];
function validateResponseStatusMatrix(response, diagnostics) {
    const output = response.output;
    if (output !== undefined) {
        if (!isRecord(output) || typeof output.text !== "string" || typeof output.partial !== "boolean")
            diagnostics.push(error("response.output", "output must contain text and partial.", "output"));
    }
    if (response.status === "completed") {
        if (response.error !== undefined || response.reason !== undefined || response.reachedLimit !== undefined || response.enforcedTimeoutMs !== undefined)
            diagnostics.push(error("response.completed-fields", "Completed responses cannot contain terminal error/reason/limit fields.", "status"));
        if (isRecord(output) && output.partial !== false)
            diagnostics.push(error("response.completed-partial", "Completed output cannot be partial.", "output.partial"));
    }
    else {
        if (isRecord(output) && output.partial !== true)
            diagnostics.push(error("response.partial", "Non-completed output must be marked partial.", "output.partial"));
        if (response.status === "failed") {
            if (!isRecord(response.error) || typeof response.error.code !== "string" || typeof response.error.message !== "string")
                diagnostics.push(error("response.failed-error", "Failed responses require a structured error.", "error"));
            forbidResponseFields(response, ["reason", "reachedLimit", "enforcedTimeoutMs"], diagnostics);
        }
        if (response.status === "cancelled") {
            if (typeof response.reason !== "string" || !response.reason.trim())
                diagnostics.push(error("response.reason", "cancelled responses require a reason.", "reason"));
            forbidResponseFields(response, ["error", "reachedLimit", "enforcedTimeoutMs"], diagnostics);
        }
        if (response.status === "timed-out") {
            if (typeof response.reason !== "string" || !response.reason.trim())
                diagnostics.push(error("response.reason", "timed-out responses require a reason.", "reason"));
            if (!isPositiveInteger(response.enforcedTimeoutMs))
                diagnostics.push(error("response.timeout", "Timed-out responses require enforcedTimeoutMs.", "enforcedTimeoutMs"));
            forbidResponseFields(response, ["error", "reachedLimit"], diagnostics);
        }
        if (response.status === "limit-reached") {
            if (!SUBAGENT_LIMIT_NAMES.includes(response.reachedLimit))
                diagnostics.push(error("response.reached-limit", "limit-reached responses require a valid reachedLimit.", "reachedLimit"));
            forbidResponseFields(response, ["error", "reason", "enforcedTimeoutMs"], diagnostics);
        }
    }
}
function forbidResponseFields(response, fields, diagnostics) {
    for (const field of fields) {
        if (response[field] !== undefined)
            diagnostics.push(error("response.forbidden-field", `${response.status} response cannot contain ${field}.`, field));
    }
}
//# sourceMappingURL=response.js.map