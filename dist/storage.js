import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
export function promptStacksDir(cwd) {
    return join(cwd, ".pi", "forge", "prompt-stacks");
}
export function agentProfilesDir(cwd) {
    return join(cwd, ".pi", "forge", "agent-profiles");
}
export function agentProfilePath(cwd, id) {
    return join(agentProfilesDir(cwd), `${id}.json`);
}
export function forgeDir(cwd) {
    return join(cwd, ".pi", "forge");
}
export function forgeExtensionsDir(cwd) {
    return join(forgeDir(cwd), "extensions");
}
export function globalForgeDir() {
    return join(homedir(), ".pi", "forge");
}
export function globalForgeExtensionsDir() {
    return join(globalForgeDir(), "extensions");
}
export function legacyPromptStacksDir(cwd) {
    return join(cwd, ".pi", "prompt-stacks");
}
export function promptStackReadDirs(cwd) {
    return [promptStacksDir(cwd), legacyPromptStacksDir(cwd)];
}
export function promptStackPath(cwd, id) {
    return join(promptStacksDir(cwd), `${id}.json`);
}
export function isInsidePromptStackStorage(cwd, filePath) {
    return promptStackReadDirs(cwd).some((dir) => isInsideDir(dir, filePath));
}
function isInsideDir(rootDir, filePath) {
    const root = resolve(rootDir);
    const target = resolve(filePath);
    const rel = relative(root, target);
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
//# sourceMappingURL=storage.js.map