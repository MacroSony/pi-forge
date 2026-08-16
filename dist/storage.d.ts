/** Development/test override for the user-owned global Forge root. */
export declare const GLOBAL_FORGE_DIR_ENV = "PI_FORGE_GLOBAL_DIR";
export declare function promptStacksDir(cwd: string): string;
export declare function agentProfilesDir(cwd: string): string;
export declare function agentProfilePath(cwd: string, id: string): string;
export declare function isInsideAgentProfileStorage(cwd: string, filePath: string): boolean;
export declare function isSafeAgentProfileMutationPath(cwd: string, filePath: string): boolean;
export declare function forgeDir(cwd: string): string;
export declare function forgeExtensionsDir(cwd: string): string;
export declare function globalForgeDir(): string;
export declare function globalPromptStacksDir(): string;
export declare function globalAgentProfilesDir(): string;
export declare function globalAgentProfilePath(id: string): string;
export declare function globalForgeExtensionsDir(): string;
export declare function isInsideGlobalAgentProfileStorage(filePath: string): boolean;
export declare function isSafeGlobalAgentProfileMutationPath(filePath: string): boolean;
export declare function legacyPromptStacksDir(cwd: string): string;
export declare function promptStackReadDirs(cwd: string): string[];
export declare function promptStackPath(cwd: string, id: string): string;
export declare function isInsidePromptStackStorage(cwd: string, filePath: string): boolean;
export declare function isSafePromptStackMutationPath(cwd: string, filePath: string): boolean;
export declare function isInsideGlobalPromptStackStorage(filePath: string): boolean;
export declare function isSafeGlobalPromptStackMutationPath(filePath: string): boolean;
//# sourceMappingURL=storage.d.ts.map