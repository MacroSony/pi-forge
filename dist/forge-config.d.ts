/**
 * Development/test override for the global config location. Keeps automated
 * tests hermetic regardless of the developer's real ~/.pi/forge/config.json.
 * Not part of the supported user-facing configuration surface.
 */
export declare const GLOBAL_FORGE_CONFIG_PATH_ENV = "PI_FORGE_GLOBAL_CONFIG_PATH";
export declare function globalForgeConfigPath(): string;
export declare function projectForgeConfigPath(cwd: string): string;
//# sourceMappingURL=forge-config.d.ts.map