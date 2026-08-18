import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeAgentProfile } from "../codecs/agent-profile.js";
import { agentProfilePath, globalAgentProfilePath, isSafeAgentProfileMutationPath, isSafeGlobalAgentProfileMutationPath, } from "../storage.js";
export function agentProfileTargetPath(cwd, scope, id) {
    return scope === "global" ? globalAgentProfilePath(id) : agentProfilePath(cwd, id);
}
function isSafeTarget(cwd, scope, filePath) {
    return scope === "project"
        ? isSafeAgentProfileMutationPath(cwd, filePath)
        : isSafeGlobalAgentProfileMutationPath(filePath);
}
function targetError(scope, filePath) {
    return `Profile path is outside ${scope} agent-profile storage or traverses a symbolic link: ${filePath}`;
}
/**
 * Write an agent profile. This is the only write path for agent-profile domain
 * resources. `overwrite: false` refuses to clobber an existing file, matching
 * the current replacement semantics (no expected-fingerprint conflict or atomic
 * replacement is introduced yet).
 */
export function writeAgentProfileFile(cwd, scope, filePath, profile, options) {
    if (!isSafeTarget(cwd, scope, filePath)) {
        return { ok: false, reason: "invalid-path", error: targetError(scope, filePath) };
    }
    if (!options.overwrite && existsSync(filePath)) {
        return { ok: false, reason: "exists", error: `Agent profile already exists: ${filePath}` };
    }
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, serializeAgentProfile(profile), { encoding: "utf8", flag: options.overwrite ? "w" : "wx" });
        return { ok: true, filePath };
    }
    catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
        if (code === "EEXIST") {
            return { ok: false, reason: "exists", error: `Agent profile already exists: ${filePath}` };
        }
        return {
            ok: false,
            reason: "io",
            error: `Failed to write agent profile ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
export function deleteAgentProfileFile(cwd, scope, filePath) {
    if (!isSafeTarget(cwd, scope, filePath)) {
        return { ok: false, reason: "invalid-path", error: targetError(scope, filePath) };
    }
    if (!existsSync(filePath)) {
        return { ok: false, reason: "missing", error: `Agent profile does not exist: ${filePath}` };
    }
    try {
        unlinkSync(filePath);
        return { ok: true, filePath };
    }
    catch (error) {
        return {
            ok: false,
            reason: "io",
            error: `Failed to delete agent profile ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
//# sourceMappingURL=agent-profile.js.map