import type { AgentProfile } from "../agent-profile.ts";
import { type LoadedAgentProfile } from "../codecs/agent-profile.ts";
import type { ResourceScope } from "../resource-identity.ts";
export type RepositoryScope = Extract<ResourceScope, "project" | "global">;
export declare function readAgentProfiles(cwd: string): LoadedAgentProfile[];
export declare function readAgentProfilesScoped(cwd: string, globalDir?: string): LoadedAgentProfile[];
export declare function readGlobalAgentProfiles(globalDir?: string): LoadedAgentProfile[];
export declare function readSingleAgentProfileFile(filePath: string, scope?: "global" | "project"): LoadedAgentProfile;
export type AgentProfileWriteResult = {
    ok: true;
    filePath: string;
} | {
    ok: false;
    reason: "invalid-path" | "exists" | "io";
    error?: string;
};
export type AgentProfileDeleteResult = {
    ok: true;
    filePath: string;
} | {
    ok: false;
    reason: "invalid-path" | "missing" | "io";
    error?: string;
};
export declare function agentProfileTargetPath(cwd: string, scope: RepositoryScope, id: string): string;
/**
 * Write an agent profile. This is the only write path for agent-profile domain
 * resources. `overwrite: false` refuses to clobber an existing file, matching
 * the current replacement semantics (no expected-fingerprint conflict or atomic
 * replacement is introduced yet).
 */
export declare function writeAgentProfileFile(cwd: string, scope: RepositoryScope, filePath: string, profile: AgentProfile, options: {
    overwrite: boolean;
}): AgentProfileWriteResult;
export declare function deleteAgentProfileFile(cwd: string, scope: RepositoryScope, filePath: string): AgentProfileDeleteResult;
//# sourceMappingURL=agent-profile.d.ts.map