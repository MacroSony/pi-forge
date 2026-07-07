import { isAbsolute, join, relative, resolve } from "node:path";
export function promptStacksDir(cwd) {
    return join(cwd, ".pi", "forge", "prompt-stacks");
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