import { join } from "node:path";
import { globalForgeDir } from "./storage.js";
/**
 * Development/test override for the global config location. Keeps automated
 * tests hermetic regardless of the developer's real ~/.pi/forge/config.json.
 * Not part of the supported user-facing configuration surface.
 */
export const GLOBAL_FORGE_CONFIG_PATH_ENV = "PI_FORGE_GLOBAL_CONFIG_PATH";
export function globalForgeConfigPath() {
    return process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] ?? join(globalForgeDir(), "config.json");
}
export function projectForgeConfigPath(cwd) {
    return join(cwd, ".pi", "forge", "config.json");
}
//# sourceMappingURL=forge-config.js.map