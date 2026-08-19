import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type LoadedAgentProfile, type ResolvedAgentProfile } from "../agent-profile.ts";
import type { ForgeWorkspace } from "../workspace.ts";
export interface ProfileRuntime {
    reloadProfiles(ctx: ExtensionContext): void;
    resolveProfile(target: LoadedAgentProfile, ctx: ExtensionContext): ResolvedAgentProfile;
    activateFreshSessionDefaults(ctx: ExtensionContext): Promise<void>;
}
export declare function createProfileRuntime(pi: ExtensionAPI, workspace: ForgeWorkspace, deps: {
    setActive(id: string | undefined, ctx?: ExtensionContext): boolean;
    updateStatus(ctx: ExtensionContext): void;
}): ProfileRuntime;
//# sourceMappingURL=profile-runtime.d.ts.map