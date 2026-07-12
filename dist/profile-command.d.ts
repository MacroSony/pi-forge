import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type LoadedAgentProfile, type ResolvedAgentProfile } from "./agent-profile.ts";
import { type PiForgeRuntimeState } from "./runtime-state.ts";
import type { PromptStack } from "./types.ts";
export interface ProfileCommandDeps {
    reloadProfiles(ctx: ExtensionContext): void | Promise<void>;
    resolveProfile(target: LoadedAgentProfile, ctx: ExtensionContext): ResolvedAgentProfile;
    setActive(id: string | undefined, ctx?: ExtensionContext): boolean;
    previewToolNames(stack: PromptStack | undefined): string[];
}
export type ProfileApplicationResult = {
    ok: true;
    warningCount: number;
} | {
    ok: false;
    detail: string;
    rollbackErrors: string[];
};
export declare function registerProfileCommand(pi: ExtensionAPI, state: PiForgeRuntimeState, deps: ProfileCommandDeps): void;
export declare function applyResolvedAgentProfile(pi: ExtensionAPI, state: PiForgeRuntimeState, deps: Pick<ProfileCommandDeps, "setActive">, resolved: ResolvedAgentProfile, ctx: ExtensionContext): Promise<ProfileApplicationResult>;
//# sourceMappingURL=profile-command.d.ts.map