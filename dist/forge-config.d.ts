import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export interface ForgeSubagentSettings {
    allowAgentInvocationWithoutApproval: boolean;
    configPath: string;
    warnings: string[];
}
export declare function loadForgeSubagentSettings(ctx: ExtensionContext): ForgeSubagentSettings;
//# sourceMappingURL=forge-config.d.ts.map