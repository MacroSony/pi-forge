import { showText } from "../preview.js";
import { createWebEditorHost, loadWebEditorSettings } from "../web-host.js";
import { startWebEditorServer } from "../web-editor/index.js";
const WEB_EDITOR_GLOBAL_KEY = "__piForgeWebEditor";
export function createWebEditorRuntime(createRuntime) {
    const sharedWebEditors = getSharedWebEditorRegistry();
    let webEditor;
    let webEditorCwd;
    let preferredPort;
    function createHost(ctx) {
        return createWebEditorHost(ctx, createRuntime(ctx));
    }
    function sharedForCwd(cwd) {
        sharedWebEditors.byCwd[cwd] ??= {};
        return sharedWebEditors.byCwd[cwd];
    }
    function syncFromShared(cwd) {
        const shared = sharedForCwd(cwd);
        webEditor = shared.server;
        webEditorCwd = shared.cwd;
        preferredPort = shared.preferredPort;
    }
    function remember(server, cwd, nextPreferredPort) {
        const shared = sharedForCwd(cwd);
        webEditor = server;
        webEditorCwd = cwd;
        preferredPort = nextPreferredPort;
        shared.server = server;
        shared.cwd = cwd;
        shared.preferredPort = nextPreferredPort;
    }
    function clear(server) {
        if (webEditor === server) {
            webEditor = undefined;
            webEditorCwd = undefined;
            preferredPort = undefined;
        }
        for (const [cwd, shared] of Object.entries(sharedWebEditors.byCwd)) {
            if (shared?.server === server)
                delete sharedWebEditors.byCwd[cwd];
        }
    }
    function refreshHost(ctx) {
        syncFromShared(ctx.cwd);
        if (!webEditor)
            return;
        const commandCtx = ctx;
        webEditor.updateHost(createHost(commandCtx));
        remember(webEditor, ctx.cwd, preferredPort);
        ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
    }
    async function open(ctx, mode = "open") {
        syncFromShared(ctx.cwd);
        const settings = loadWebEditorSettings(ctx);
        for (const warning of settings.warnings)
            ctx.ui.notify(warning, "warning");
        if (webEditor && (mode === "restart" || preferredPort !== settings.preferredPort)) {
            const server = webEditor;
            await server.close();
            clear(server);
            ctx.ui.setStatus("pi-forge-editor", undefined);
        }
        if (!webEditor) {
            try {
                webEditor = await startWebEditorServer(createHost(ctx), { port: settings.preferredPort });
            }
            catch (error) {
                if (settings.preferredPort !== undefined) {
                    const detail = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`pi-forge: preferred editor port 127.0.0.1:${settings.preferredPort} was unavailable (${detail}); using an available port instead.`, "warning");
                    try {
                        webEditor = await startWebEditorServer(createHost(ctx));
                    }
                    catch (fallbackError) {
                        const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                        ctx.ui.setStatus("pi-forge-editor", undefined);
                        ctx.ui.notify(`pi-forge: failed to start stack editor on an available localhost port: ${fallbackDetail}.`, "error");
                        return;
                    }
                }
                else {
                    const detail = error instanceof Error ? error.message : String(error);
                    ctx.ui.setStatus("pi-forge-editor", undefined);
                    ctx.ui.notify(`pi-forge: failed to start stack editor on an available localhost port: ${detail}.`, "error");
                    return;
                }
            }
            remember(webEditor, ctx.cwd, settings.preferredPort);
            ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
            ctx.ui.notify(`pi-forge: stack editor running at ${webEditor.url}`, "info");
        }
        else {
            webEditor.updateHost(createHost(ctx));
            remember(webEditor, ctx.cwd, settings.preferredPort);
            ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
            ctx.ui.notify(`pi-forge: stack editor already running at ${webEditor.url}`, "info");
        }
        await showText(ctx, "pi-forge stack editor", `Open the local stack editor:\n\n${webEditor.url}\n\nServer bound to 127.0.0.1:${webEditor.port}\nOptional config: ${settings.configPath}\nProject: ${webEditorCwd}`);
    }
    async function stop(ctx) {
        syncFromShared(ctx.cwd);
        if (!webEditor) {
            ctx.ui.notify("pi-forge: stack editor is not running.", "info");
            return;
        }
        const server = webEditor;
        await server.close();
        clear(server);
        ctx.ui.setStatus("pi-forge-editor", undefined);
        ctx.ui.notify("pi-forge: stack editor stopped.", "info");
    }
    return { refreshHost, open, stop };
}
function getSharedWebEditorRegistry() {
    const globalScope = globalThis;
    globalScope[WEB_EDITOR_GLOBAL_KEY] ??= { byCwd: {} };
    return globalScope[WEB_EDITOR_GLOBAL_KEY];
}
//# sourceMappingURL=web-editor-runtime.js.map