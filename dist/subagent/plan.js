import { canonicalSubagentJson, subagentExecutionFingerprint } from "./canonical.js";
import { budgetSubagentContext, isProtectedSubagentTaskPreserved, renderSubagentSelectedContext } from "./context.js";
import { validateBackendPreflight } from "./preflight.js";
import { validateAgentProfileSnapshot, validateAgentRequest } from "./request.js";
import { negotiateSubagentTools } from "./tools.js";
import { SUBAGENT_CONTRACT_VERSION } from "./types.js";
import { error, hasErrors, isFingerprint, isPositiveInteger, isRecord, validateAccessReceipt, validateContextBudgetReceipt, validateFingerprint, validateLimitReceipt, validateModelReference, validateOpaqueId, validatePreparedMessage, validateUniqueStringArray } from "./validation.js";
export function createAgentExecutionPlan(input) {
    const diagnostics = [
        ...validateAgentRequest(input.request),
        ...validateAgentProfileSnapshot(input.snapshot),
        ...validateBackendPreflight(input.preflight, input.request, input.snapshot),
        ...input.preparation.diagnostics,
        ...input.preparation.toolNegotiation.diagnostics,
    ];
    validateOpaqueId(input.runId, "runId", diagnostics);
    validateFingerprint(input.runtime.promptRuntimeFingerprint, "runtime.promptRuntimeFingerprint", diagnostics);
    if (input.request.profileId !== input.snapshot.profile.id)
        diagnostics.push(error("plan.profile-id", "Request profileId does not match the resolved snapshot.", "profileId"));
    if (input.request.expectedProfileFingerprint && input.request.expectedProfileFingerprint !== input.snapshot.profileFingerprint)
        diagnostics.push(error("plan.profile-drift", "Resolved profile fingerprint does not match expectedProfileFingerprint.", "expectedProfileFingerprint"));
    if (!isProtectedSubagentTaskPreserved(input.preparation.messages, input.request.input)) {
        diagnostics.push(error("plan.protected-task", "Prepared messages do not preserve the delegated task as the final user message.", "messages"));
    }
    const expectedTools = negotiateSubagentTools(input.preflight.toolCatalog, input.snapshot.promptStack?.tools, input.request.access);
    diagnostics.push(...expectedTools.diagnostics);
    if (canonicalSubagentJson(input.preparation.toolNegotiation.effectiveToolIds) !== canonicalSubagentJson(expectedTools.effectiveToolIds)
        || canonicalSubagentJson(input.preparation.toolNegotiation.effectiveToolNames) !== canonicalSubagentJson(expectedTools.effectiveToolNames)) {
        diagnostics.push(error("plan.tool-negotiation", "Prepared effective tools do not match catalog, stack policy, and request access.", "toolNegotiation"));
    }
    if (input.request.selectedContext) {
        const expectedBudget = budgetSubagentContext(input.request.selectedContext);
        diagnostics.push(...expectedBudget.diagnostics.filter((diagnostic) => diagnostic.level === "error"));
        if (!input.preparation.contextBudget || canonicalSubagentJson(input.preparation.contextBudget) !== canonicalSubagentJson(expectedBudget.receipt))
            diagnostics.push(error("plan.context-budget", "Preparation context budget receipt does not match the deterministic request budget.", "contextBudget"));
        const expectedText = renderSubagentSelectedContext(expectedBudget.items);
        const contextMessages = input.preparation.messages.filter((message) => message.source === "selected-context");
        if (expectedText) {
            if (contextMessages.length !== 1 || canonicalSubagentJson(contextMessages[0]?.content) !== canonicalSubagentJson([{ type: "text", text: expectedText }]))
                diagnostics.push(error("plan.selected-context", "Prepared messages do not contain the exact budgeted selected context.", "messages"));
        }
        else if (contextMessages.length > 0)
            diagnostics.push(error("plan.selected-context-empty", "Prepared messages contain selected context when the deterministic budget selected none.", "messages"));
    }
    else if (input.preparation.contextBudget) {
        diagnostics.push(error("plan.context-budget-extra", "Preparation returned a context budget for a request without selected context.", "contextBudget"));
    }
    else if (input.preparation.messages.some((message) => message.source === "selected-context")) {
        diagnostics.push(error("plan.selected-context-extra", "Preparation contains selected context for a request that did not select any.", "messages"));
    }
    if (input.preflight.backend.capabilities.promptRuntimeFidelity === "partial")
        diagnostics.push(error("plan.partial-runtime", "A partial prompt-runtime preflight cannot produce an execution plan.", "preflight.backend.capabilities.promptRuntimeFidelity"));
    if (input.runtime.fidelity === "exact-preflight" && input.preflight.backend.capabilities.promptRuntimeFidelity !== "exact-preflight") {
        diagnostics.push(error("plan.runtime-fidelity", "Preflight does not support exact-preflight prompt preparation.", "runtime.fidelity"));
    }
    if (input.runtime.fidelity === "backend-assisted" && input.preflight.backend.capabilities.promptRuntimeFidelity !== "backend-assisted") {
        diagnostics.push(error("plan.runtime-fidelity", "Preflight does not support backend-assisted prompt preparation.", "runtime.fidelity"));
    }
    if (hasErrors(diagnostics))
        return { diagnostics };
    const partial = {
        schemaVersion: SUBAGENT_CONTRACT_VERSION,
        runId: input.runId,
        requestId: input.request.requestId,
        backendId: input.preflight.backend.id,
        preflightId: input.preflight.preflightId,
        preflight: structuredClone(input.preflight),
        profile: structuredClone(input.snapshot),
        model: structuredClone(input.preflight.model),
        thinkingLevel: input.preflight.thinkingLevel,
        systemPrompt: input.preparation.systemPrompt,
        messages: structuredClone(input.preparation.messages),
        effectiveToolIds: [...input.preparation.toolNegotiation.effectiveToolIds],
        access: structuredClone(input.preflight.access),
        limits: structuredClone(input.preflight.limits),
        contextBudget: input.preparation.contextBudget ? structuredClone(input.preparation.contextBudget) : undefined,
        resultProjection: structuredClone(input.request.resultProjection),
        promptRuntimeFingerprint: input.runtime.promptRuntimeFingerprint,
    };
    return { plan: { ...partial, executionFingerprint: subagentExecutionFingerprint(partial) }, diagnostics };
}
export function validateAgentExecutionPlan(plan, request) {
    const diagnostics = [];
    if (!isRecord(plan))
        return [error("plan.type", "AgentExecutionPlan must be an object.", "$")];
    if (plan.schemaVersion !== SUBAGENT_CONTRACT_VERSION)
        diagnostics.push(error("plan.schema-version", "schemaVersion must be 1.", "schemaVersion"));
    for (const id of ["runId", "requestId", "backendId", "preflightId"])
        validateOpaqueId(plan[id], id, diagnostics);
    diagnostics.push(...validateBackendPreflight(plan.preflight, request, isRecord(plan.profile) ? plan.profile : undefined).map((diagnostic) => ({ ...diagnostic, path: diagnostic.path ? `preflight.${diagnostic.path}` : "preflight" })));
    diagnostics.push(...validateAgentProfileSnapshot(plan.profile).map((diagnostic) => ({ ...diagnostic, path: diagnostic.path ? `profile.${diagnostic.path}` : "profile" })));
    validateModelReference(plan.model, "model", diagnostics);
    if (typeof plan.thinkingLevel !== "string")
        diagnostics.push(error("plan.thinking", "thinkingLevel must be a string.", "thinkingLevel"));
    if (typeof plan.systemPrompt !== "string")
        diagnostics.push(error("plan.system-prompt", "systemPrompt must be a string.", "systemPrompt"));
    validateFingerprint(plan.promptRuntimeFingerprint, "promptRuntimeFingerprint", diagnostics);
    validateFingerprint(plan.executionFingerprint, "executionFingerprint", diagnostics);
    if (!Array.isArray(plan.messages))
        diagnostics.push(error("plan.messages", "messages must be an array.", "messages"));
    else
        plan.messages.forEach((message, index) => validatePreparedMessage(message, `messages[${index}]`, diagnostics));
    if (!Array.isArray(plan.effectiveToolIds))
        diagnostics.push(error("plan.tools", "effectiveToolIds must be an array.", "effectiveToolIds"));
    else
        validateUniqueStringArray(plan.effectiveToolIds, "effectiveToolIds", diagnostics);
    validateAccessReceipt(plan.access, "access", diagnostics);
    validateLimitReceipt(plan.limits, "limits", diagnostics);
    if (plan.contextBudget !== undefined)
        validateContextBudgetReceipt(plan.contextBudget, "contextBudget", diagnostics);
    if (!isRecord(plan.resultProjection) || !isPositiveInteger(plan.resultProjection.maxChars))
        diagnostics.push(error("plan.result-projection", "resultProjection.maxChars must be a positive integer.", "resultProjection.maxChars"));
    if (isRecord(plan.preflight)) {
        if (plan.preflightId !== plan.preflight.preflightId)
            diagnostics.push(error("plan.preflight-id", "preflightId does not match the embedded preflight receipt.", "preflightId"));
        if (isRecord(plan.preflight.backend) && plan.backendId !== plan.preflight.backend.id)
            diagnostics.push(error("plan.backend-id", "backendId does not match the embedded preflight receipt.", "backendId"));
        try {
            if (canonicalSubagentJson(plan.model) !== canonicalSubagentJson(plan.preflight.model))
                diagnostics.push(error("plan.model-receipt", "Plan model does not match the preflight receipt.", "model"));
            if (plan.thinkingLevel !== plan.preflight.thinkingLevel)
                diagnostics.push(error("plan.thinking-receipt", "Plan thinkingLevel does not match the preflight receipt.", "thinkingLevel"));
            if (canonicalSubagentJson(plan.access) !== canonicalSubagentJson(plan.preflight.access))
                diagnostics.push(error("plan.access-receipt", "Plan access does not match the preflight receipt.", "access"));
            if (canonicalSubagentJson(plan.limits) !== canonicalSubagentJson(plan.preflight.limits))
                diagnostics.push(error("plan.limit-receipt", "Plan limits do not match the preflight receipt.", "limits"));
            if (Array.isArray(plan.effectiveToolIds) && Array.isArray(plan.preflight.toolCatalog)) {
                const catalogIds = new Set(plan.preflight.toolCatalog.filter(isRecord).map((tool) => tool.id));
                if (plan.effectiveToolIds.some((id) => !catalogIds.has(id)))
                    diagnostics.push(error("plan.tool-receipt", "Plan contains an effective tool id absent from the preflight catalog.", "effectiveToolIds"));
            }
        }
        catch (validationError) {
            diagnostics.push(error("plan.receipt-malformed", `Cannot compare malformed plan receipt: ${validationError instanceof Error ? validationError.message : String(validationError)}`, "preflight"));
        }
    }
    if (request) {
        if (plan.requestId !== request.requestId)
            diagnostics.push(error("plan.request-id", "Plan requestId does not match the request.", "requestId"));
        if (isRecord(plan.resultProjection) && canonicalSubagentJson(plan.resultProjection) !== canonicalSubagentJson(request.resultProjection))
            diagnostics.push(error("plan.result-projection-mismatch", "Plan resultProjection does not match the request.", "resultProjection"));
    }
    if (Array.isArray(plan.messages) && request && !isProtectedSubagentTaskPreserved(plan.messages, request.input)) {
        diagnostics.push(error("plan.protected-task", "The final plan message does not preserve the request task.", "messages"));
    }
    if (isFingerprint(plan.executionFingerprint)) {
        try {
            if (subagentExecutionFingerprint(plan) !== plan.executionFingerprint) {
                diagnostics.push(error("plan.execution-fingerprint", "executionFingerprint does not match the plan.", "executionFingerprint"));
            }
        }
        catch (fingerprintError) {
            diagnostics.push(error("plan.fingerprint-input", fingerprintError instanceof Error ? fingerprintError.message : String(fingerprintError), "executionFingerprint"));
        }
    }
    return diagnostics;
}
//# sourceMappingURL=plan.js.map