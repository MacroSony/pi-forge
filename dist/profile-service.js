import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AGENT_PROFILE_TYPE, agentProfileFingerprint, agentProfilePath, hasAgentProfileErrors, isResolvedAgentProfileUsable, loadAgentProfileFile, validateAgentProfile, } from "./agent-profile.js";
import { PROFILE_ENTRY_TYPE } from "./runtime-state.js";
import { isSafeAgentProfileMutationPath } from "./storage.js";
export function captureAgentProfile(id, runtime, existing) {
    if (!runtime.model) {
        return {
            ok: false,
            diagnostics: [{ level: "error", field: "model", message: "Cannot capture an agent profile without a selected model." }],
        };
    }
    const profile = {
        schemaVersion: 1,
        type: AGENT_PROFILE_TYPE,
        id,
        name: existing?.profile.name ?? id,
        description: existing?.profile.description,
        autoActivate: existing?.profile.autoActivate,
        model: { ...runtime.model },
        thinkingLevel: runtime.thinkingLevel,
        promptStack: runtime.promptStack,
    };
    const diagnostics = validateAgentProfile(profile);
    return hasAgentProfileErrors(diagnostics)
        ? { ok: false, diagnostics }
        : { ok: true, profile, diagnostics };
}
export function writeAgentProfile(cwd, profile, options = {}) {
    const diagnostics = validateAgentProfile(profile);
    if (hasAgentProfileErrors(diagnostics))
        return { ok: false, reason: "validation", diagnostics };
    const filePath = options.filePath ?? agentProfilePath(cwd, profile.id);
    if (!isSafeAgentProfileMutationPath(cwd, filePath)) {
        return {
            ok: false,
            reason: "invalid-path",
            diagnostics,
            error: `Profile path is outside project agent-profile storage or traverses a symbolic link: ${filePath}`,
        };
    }
    if (existsSync(filePath) && !options.overwrite)
        return { ok: false, reason: "exists", diagnostics };
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, JSON.stringify(profile, null, 2) + "\n", { encoding: "utf8", flag: options.overwrite ? "w" : "wx" });
        return { ok: true, profile, filePath };
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (code === "EEXIST")
            return { ok: false, reason: "exists", diagnostics };
        return { ok: false, reason: "io", diagnostics, error: error instanceof Error ? error.message : String(error) };
    }
}
export function deleteAgentProfile(cwd, loaded) {
    const filePath = loaded.filePath;
    if (!isSafeAgentProfileMutationPath(cwd, filePath))
        return { ok: false, reason: "invalid-path", filePath };
    if (!existsSync(filePath))
        return { ok: false, reason: "missing", filePath };
    const current = loadAgentProfileFile(filePath);
    if (current.profile.id !== loaded.profile.id
        || agentProfileFingerprint(current.profile) !== agentProfileFingerprint(loaded.profile)) {
        return { ok: false, reason: "changed", filePath };
    }
    try {
        unlinkSync(filePath);
        return { ok: true, filePath };
    }
    catch (error) {
        return { ok: false, reason: "io", filePath, error: error instanceof Error ? error.message : String(error) };
    }
}
export async function applyResolvedAgentProfile(pi, state, deps, resolved, ctx) {
    if (!isResolvedAgentProfileUsable(resolved) || !resolved.model) {
        return { ok: false, detail: "Profile failed preflight; runtime state was not changed", rollbackErrors: [] };
    }
    const previousModel = ctx.model;
    const previousThinkingLevel = pi.getThinkingLevel();
    const previousPromptStack = state.active?.stack.id ?? null;
    const modelChanged = !sameModelReference(previousModel, resolved.model);
    try {
        if (modelChanged && !(await pi.setModel(resolved.model))) {
            throw new Error(`Pi could not activate model ${resolved.model.provider}/${resolved.model.id}; authentication may have changed after preflight.`);
        }
        pi.setThinkingLevel(resolved.effectiveThinkingLevel);
        const actualThinkingLevel = pi.getThinkingLevel();
        if (actualThinkingLevel !== resolved.effectiveThinkingLevel) {
            throw new Error(`Pi applied thinking level ${actualThinkingLevel} instead of ${resolved.effectiveThinkingLevel}.`);
        }
        if (!deps.setActive(resolved.loaded.profile.promptStack ?? "none", ctx)) {
            throw new Error(`Prompt stack ${String(resolved.loaded.profile.promptStack)} disappeared after preflight.`);
        }
    }
    catch (error) {
        const rollbackErrors = await rollbackAgentProfileApplication(pi, deps, ctx, {
            model: previousModel,
            thinkingLevel: previousThinkingLevel,
            promptStack: previousPromptStack,
            modelChanged,
        });
        return { ok: false, detail: error instanceof Error ? error.message : String(error), rollbackErrors };
    }
    const provenance = {
        profileId: resolved.loaded.profile.id,
        sourcePath: resolved.loaded.filePath,
        sourceFingerprint: agentProfileFingerprint(resolved.loaded.profile),
        appliedAt: new Date().toISOString(),
        snapshot: {
            model: { provider: resolved.model.provider, id: resolved.model.id },
            thinkingLevel: resolved.effectiveThinkingLevel,
            promptStack: resolved.loaded.profile.promptStack,
        },
    };
    state.lastAppliedProfile = provenance;
    pi.appendEntry(PROFILE_ENTRY_TYPE, { provenance });
    return {
        ok: true,
        warningCount: resolved.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length,
        provenance,
    };
}
export function forgetAgentProfileProvenance(pi, state) {
    if (!state.lastAppliedProfile)
        return false;
    state.lastAppliedProfile = undefined;
    pi.appendEntry(PROFILE_ENTRY_TYPE, { provenance: null });
    return true;
}
export function createAgentProfilePreview(resolved, current, targetEffectiveTools) {
    const profile = resolved.loaded.profile;
    return {
        profileId: profile.id,
        name: profile.name,
        description: profile.description,
        sourcePath: resolved.loaded.filePath,
        autoActivate: profile.autoActivate === true,
        current: cloneCurrentRuntime(current),
        target: {
            model: { ...profile.model },
            thinkingLevel: resolved.effectiveThinkingLevel,
            promptStack: profile.promptStack,
            effectiveTools: [...targetEffectiveTools],
            toolPolicy: resolved.promptStack?.stack.tools ? structuredClone(resolved.promptStack.stack.tools) : undefined,
        },
        applicable: isResolvedAgentProfileUsable(resolved),
        diagnostics: resolved.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
}
export function getAgentProfileRuntimeStatus(profiles, provenance, current) {
    const status = { current: cloneCurrentRuntime(current) };
    if (!provenance)
        return status;
    const currentSource = profiles.find((loaded) => loaded.filePath === provenance.sourcePath);
    const sourceState = !currentSource
        ? "missing"
        : agentProfileFingerprint(currentSource.profile) === provenance.sourceFingerprint ? "unchanged" : "changed";
    status.lastApplied = {
        provenance: structuredClone(provenance),
        sourceState,
        drift: {
            model: driftField(provenance.snapshot.model, current.model, sameModelReferenceValue),
            thinkingLevel: driftField(provenance.snapshot.thinkingLevel, current.thinkingLevel),
            promptStack: driftField(provenance.snapshot.promptStack, current.promptStack),
        },
    };
    return status;
}
async function rollbackAgentProfileApplication(pi, deps, ctx, previous) {
    const errors = [];
    try {
        if (!deps.setActive(previous.promptStack ?? "none", ctx))
            errors.push(`could not restore prompt stack ${String(previous.promptStack)}`);
    }
    catch (error) {
        errors.push(`prompt stack restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (previous.modelChanged) {
        if (!previous.model) {
            errors.push("Pi has no API for restoring an unset model");
        }
        else {
            try {
                if (!(await pi.setModel(previous.model)))
                    errors.push(`could not restore model ${previous.model.provider}/${previous.model.id}`);
            }
            catch (error) {
                errors.push(`model restore failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    try {
        pi.setThinkingLevel(previous.thinkingLevel);
        if (pi.getThinkingLevel() !== previous.thinkingLevel)
            errors.push(`could not restore thinking level ${previous.thinkingLevel}`);
    }
    catch (error) {
        errors.push(`thinking-level restore failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return errors;
}
function cloneCurrentRuntime(current) {
    return {
        model: current.model ? { ...current.model } : null,
        thinkingLevel: current.thinkingLevel,
        promptStack: current.promptStack,
        effectiveTools: [...current.effectiveTools],
    };
}
function driftField(expected, actual, equals = Object.is) {
    return { expected, actual, changed: !equals(expected, actual) };
}
function sameModelReference(left, right) {
    return !!left && !!right && left.provider === right.provider && left.id === right.id;
}
function sameModelReferenceValue(left, right) {
    return left === null || right === null ? left === right : left.provider === right.provider && left.id === right.id;
}
//# sourceMappingURL=profile-service.js.map