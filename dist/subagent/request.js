import { validateAgentProfile } from "../agent-profile.js";
import { formatResourceKey, parseResourceSelector } from "../resource-identity.js";
import { subagentPromptStackFingerprint, subagentSourceProfileFingerprint } from "./canonical.js";
import { SUBAGENT_CONTRACT_VERSION } from "./types.js";
import { error, isFingerprint, isNonNegativeInteger, isPositiveInteger, isRecord, validateAccessRequest, validateFingerprint, validateLimitRequest, validateMediaReference, validateOpaqueId, validateSelectedContext } from "./validation.js";
export function validateAgentRequest(value) {
    const diagnostics = [];
    if (!isRecord(value))
        return [error("request.type", "AgentRequest must be an object.", "$")];
    if (value.schemaVersion !== SUBAGENT_CONTRACT_VERSION)
        diagnostics.push(error("request.schema-version", "schemaVersion must be 1.", "schemaVersion"));
    validateOpaqueId(value.requestId, "requestId", diagnostics);
    validateOpaqueId(value.profileId, "profileId", diagnostics);
    if (value.expectedProfileFingerprint !== undefined)
        validateFingerprint(value.expectedProfileFingerprint, "expectedProfileFingerprint", diagnostics);
    if (!isRecord(value.input)) {
        diagnostics.push(error("request.input", "input must be an object.", "input"));
    }
    else {
        const text = value.input.text;
        const media = value.input.media;
        if (typeof text !== "string")
            diagnostics.push(error("request.input-text", "input.text must be a string.", "input.text"));
        if (media !== undefined && !Array.isArray(media))
            diagnostics.push(error("request.media", "input.media must be an array.", "input.media"));
        if (Array.isArray(media))
            media.forEach((item, index) => validateMediaReference(item, `input.media[${index}]`, diagnostics));
        if (typeof text === "string" && !text.trim() && (!Array.isArray(media) || media.length === 0)) {
            diagnostics.push(error("request.empty-task", "The delegated task must contain text or media.", "input"));
        }
    }
    if (value.selectedContext !== undefined)
        validateSelectedContext(value.selectedContext, "selectedContext", diagnostics);
    validateAccessRequest(value.access, "access", diagnostics);
    validateLimitRequest(value.limits, "limits", diagnostics);
    if (!isRecord(value.resultProjection) || !isPositiveInteger(value.resultProjection.maxChars)) {
        diagnostics.push(error("request.result-projection", "resultProjection.maxChars must be a positive integer.", "resultProjection.maxChars"));
    }
    if (!isRecord(value.parent)) {
        diagnostics.push(error("request.parent", "parent must be an object.", "parent"));
    }
    else {
        if (!isNonNegativeInteger(value.parent.depth))
            diagnostics.push(error("request.depth", "parent.depth must be a non-negative integer.", "parent.depth"));
        if (!isPositiveInteger(value.parent.maxDepth))
            diagnostics.push(error("request.max-depth", "parent.maxDepth must be a positive integer.", "parent.maxDepth"));
        if (isNonNegativeInteger(value.parent.depth) && isPositiveInteger(value.parent.maxDepth) && value.parent.depth >= value.parent.maxDepth) {
            diagnostics.push(error("request.depth-limit", "parent.depth must be less than parent.maxDepth.", "parent.depth"));
        }
        if (value.parent.runId !== undefined)
            validateOpaqueId(value.parent.runId, "parent.runId", diagnostics);
        if (value.parent.sessionId !== undefined)
            validateOpaqueId(value.parent.sessionId, "parent.sessionId", diagnostics);
    }
    if (typeof value.remoteEgressConsent !== "boolean")
        diagnostics.push(error("request.egress-consent", "remoteEgressConsent must be boolean.", "remoteEgressConsent"));
    return diagnostics;
}
export function validateAgentProfileSnapshot(value) {
    const diagnostics = [];
    if (!isRecord(value))
        return [error("snapshot.type", "AgentProfileSnapshot must be an object.", "$")];
    if (value.schemaVersion !== SUBAGENT_CONTRACT_VERSION)
        diagnostics.push(error("snapshot.schema-version", "schemaVersion must be 1.", "schemaVersion"));
    if (typeof value.profileId !== "string" || !parseResourceSelector(value.profileId).ok)
        diagnostics.push(error("snapshot.profile-id", "profileId must be a valid scoped profile selector.", "profileId"));
    if (!isRecord(value.profile))
        diagnostics.push(error("snapshot.profile", "profile must be an object.", "profile"));
    else {
        try {
            for (const profileDiagnostic of validateAgentProfile(value.profile)) {
                diagnostics.push({
                    level: profileDiagnostic.level,
                    code: "snapshot.profile-validation",
                    path: profileDiagnostic.field ? `profile.${profileDiagnostic.field}` : "profile",
                    message: profileDiagnostic.message,
                });
            }
        }
        catch (validationError) {
            diagnostics.push(error("snapshot.profile-malformed", `Malformed profile: ${validationError instanceof Error ? validationError.message : String(validationError)}`, "profile"));
        }
    }
    if (!(value.promptStack === null || isRecord(value.promptStack)))
        diagnostics.push(error("snapshot.stack", "promptStack must be an object or null.", "promptStack"));
    if (!Array.isArray(value.dependencies))
        diagnostics.push(error("snapshot.dependencies", "dependencies must be an array.", "dependencies"));
    else {
        const identities = new Set();
        value.dependencies.forEach((dependency, index) => {
            if (!isRecord(dependency) || (dependency.kind !== "macro" && dependency.kind !== "slot") || typeof dependency.name !== "string" || typeof dependency.identity !== "string") {
                diagnostics.push(error("snapshot.dependency", "Dependency requires kind, name, and identity.", `dependencies[${index}]`));
                return;
            }
            if (identities.has(dependency.identity))
                diagnostics.push(error("snapshot.duplicate-dependency", `Duplicate dependency identity: ${dependency.identity}`, `dependencies[${index}].identity`));
            identities.add(dependency.identity);
        });
    }
    validateFingerprint(value.profileFingerprint, "profileFingerprint", diagnostics);
    if (value.promptStackId !== null && (typeof value.promptStackId !== "string" || !parseResourceSelector(value.promptStackId).ok)) {
        diagnostics.push(error("snapshot.stack-id", "promptStackId must be a valid scoped prompt-stack selector or null.", "promptStackId"));
    }
    if (value.promptStackFingerprint !== null)
        validateFingerprint(value.promptStackFingerprint, "promptStackFingerprint", diagnostics);
    if (isRecord(value.profile) && isFingerprint(value.profileFingerprint)) {
        if (subagentSourceProfileFingerprint(value.profile) !== value.profileFingerprint) {
            diagnostics.push(error("snapshot.profile-fingerprint", "profileFingerprint does not match profile.", "profileFingerprint"));
        }
    }
    if (isRecord(value.promptStack) && isFingerprint(value.promptStackFingerprint)) {
        if (subagentPromptStackFingerprint(value.promptStack) !== value.promptStackFingerprint) {
            diagnostics.push(error("snapshot.stack-fingerprint", "promptStackFingerprint does not match promptStack.", "promptStackFingerprint"));
        }
    }
    if (value.promptStack === null && value.promptStackFingerprint !== null) {
        diagnostics.push(error("snapshot.null-stack-fingerprint", "A null promptStack must have a null promptStackFingerprint.", "promptStackFingerprint"));
    }
    if (isRecord(value.profile)) {
        const referencedStack = value.profile.promptStack;
        if (referencedStack === null) {
            if (value.promptStack !== null)
                diagnostics.push(error("snapshot.unexpected-stack", "Profile references no prompt stack, but the snapshot contains one.", "promptStack"));
            if (value.promptStackId !== null)
                diagnostics.push(error("snapshot.null-stack-id", "A null promptStack must have a null promptStackId.", "promptStackId"));
        }
        else if (typeof referencedStack === "string") {
            const parsedReference = parseResourceSelector(referencedStack);
            if (!parsedReference.ok) {
                diagnostics.push(error("snapshot.stack-reference", parsedReference.error, "promptStack"));
            }
            else {
                const parsedProfile = parseResourceSelector(typeof value.profileId === "string" ? value.profileId : "");
                const profileScope = parsedProfile.ok ? (parsedProfile.selector.scope ?? "project") : "project";
                if (profileScope === "global" && parsedReference.selector.scope === "project") {
                    diagnostics.push(error("snapshot.stack-reference", `Global profile cannot reference project prompt stack ${parsedReference.selector.id}.`, "promptStack"));
                }
                const expectedPromptStackId = formatResourceKey({
                    scope: parsedReference.selector.scope ?? profileScope,
                    id: parsedReference.selector.id,
                });
                const resolvedPromptStack = isRecord(value.promptStack) ? value.promptStack : undefined;
                if (!resolvedPromptStack || resolvedPromptStack.id !== parsedReference.selector.id) {
                    diagnostics.push(error("snapshot.stack-reference", "Snapshot promptStack does not match profile.promptStack.", "promptStack"));
                }
                if (value.promptStackId !== expectedPromptStackId) {
                    diagnostics.push(error("snapshot.stack-reference-scope", "Snapshot promptStackId does not match the profile.promptStack selector scope.", "promptStackId"));
                }
            }
        }
    }
    return diagnostics;
}
//# sourceMappingURL=request.js.map