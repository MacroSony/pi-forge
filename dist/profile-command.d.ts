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
export declare function registerProfileCommand(pi: ExtensionAPI, state: PiForgeRuntimeState, deps: ProfileCommandDeps): void;
//# sourceMappingURL=profile-command.d.ts.map