import { createForgeExtensionState, reloadForgeExtensions, unloadForgeExtensions } from "./forge-extensions.js";
import { registerLifecycleHandlers } from "./lifecycle.js";
import { chooseDefaultStack, isDisabledPromptStackId, loadPromptStacks } from "./loader.js";
import { registerPayloadCommands, registerPayloadRequestHandler, armPayloadIntercept, clearPayloadCapture, webPayloadSnapshot } from "./payload-command.js";
import { applyResourcePolicy, hasResourcePolicy } from "./policy.js";
import { buildPreview, showText } from "./preview.js";
import { registerPresetCommand, selectedActiveId as selectedActiveIdForState } from "./preset-command.js";
import { createRuntimeState, STATE_ENTRY_TYPE } from "./runtime-state.js";
import { createWebEditorHost, loadWebEditorSettings } from "./web-host.js";
import { startWebEditorServer } from "./web-editor/index.js";
export { getRegisteredMacros, registerMacro, } from "./macro-engine.js";
export { getRegisteredSlots, registerSlot, } from "./slot-renderers.js";
export { createVariableAccess, promptRenderHelpers, } from "./render-helpers.js";
const WEB_EDITOR_GLOBAL_KEY = "__piForgeWebEditor";
function getSharedWebEditorRegistry() {
    const globalScope = globalThis;
    globalScope[WEB_EDITOR_GLOBAL_KEY] ??= { byCwd: {} };
    return globalScope[WEB_EDITOR_GLOBAL_KEY];
}
export default function piForge(pi) {
    const sharedWebEditors = getSharedWebEditorRegistry();
    const state = createRuntimeState();
    let webEditor;
    let webEditorCwd;
    let webEditorPreferredPort;
    let toolPolicyBaseline;
    const forgeExtensionState = createForgeExtensionState();
    function activeId() {
        return state.active?.stack.id;
    }
    function selectedActiveId() {
        return selectedActiveIdForState(state);
    }
    function persistActiveSelection(id) {
        if (id === state.lastPersistedActiveId)
            return;
        pi.appendEntry(STATE_ENTRY_TYPE, { activeStackId: id });
        state.lastPersistedActiveId = id;
    }
    function setActive(id, ctx) {
        if (!id || isDisabledPromptStackId(id)) {
            state.active = undefined;
            if (id)
                persistActiveSelection("none");
            if (ctx)
                updateStatus(ctx);
            syncActiveToolPolicy(ctx);
            return true;
        }
        const found = state.stacks.find((candidate) => candidate.stack.id === id);
        if (!found)
            return false;
        state.active = found;
        persistActiveSelection(found.stack.id);
        if (ctx)
            updateStatus(ctx);
        syncActiveToolPolicy(ctx);
        return true;
    }
    async function reloadStacks(ctx, preferredId) {
        if (!ctx.isProjectTrusted()) {
            const unloadDiagnostics = unloadForgeExtensions(forgeExtensionState);
            state.forgeExtensionDiagnostics = unloadDiagnostics;
            state.forgeExtensionPaths = [];
            state.stacks = [];
            state.active = undefined;
            syncActiveToolPolicy(ctx);
            ctx.ui.notify("pi-forge: project is not trusted; prompt stacks are disabled.", "warning");
            updateStatus(ctx);
            return;
        }
        const extensionResult = await reloadForgeExtensions(ctx.cwd, forgeExtensionState);
        state.forgeExtensionDiagnostics = extensionResult.diagnostics;
        state.forgeExtensionPaths = extensionResult.loadedPaths;
        state.stacks = loadPromptStacks(ctx.cwd);
        if (state.forgeExtensionDiagnostics.length > 0) {
            for (const loaded of state.stacks)
                loaded.diagnostics.unshift(...state.forgeExtensionDiagnostics);
        }
        state.active = chooseDefaultStack(state.stacks, preferredId);
        updateStatus(ctx);
        syncActiveToolPolicy(ctx);
    }
    function updateStatus(ctx) {
        if (state.active) {
            ctx.ui.setStatus("pi-forge", ctx.ui.theme.fg("accent", "stack:" + state.active.stack.id));
        }
        else {
            ctx.ui.setStatus("pi-forge", undefined);
            state.latestCompileDiagnostics = [];
            ctx.ui.setStatus("pi-forge-diagnostics", undefined);
        }
    }
    function syncActiveToolPolicy(ctx) {
        const policy = state.active?.stack.tools;
        if (!hasResourcePolicy(policy)) {
            restoreToolPolicy(ctx);
            return;
        }
        const baseline = toolPolicyBaseline ?? pi.getActiveTools();
        toolPolicyBaseline ??= [...baseline];
        const nextTools = applyResourcePolicy(filterKnownTools(baseline), policy);
        pi.setActiveTools(nextTools);
        if (ctx) {
            const label = nextTools.length > 0 ? `tools:${nextTools.length}` : "tools:none";
            ctx.ui.setStatus("pi-forge-tools", ctx.ui.theme.fg(nextTools.length > 0 ? "accent" : "warning", label));
        }
    }
    function restoreToolPolicy(ctx) {
        if (toolPolicyBaseline) {
            pi.setActiveTools(filterKnownTools(toolPolicyBaseline));
            toolPolicyBaseline = undefined;
        }
        if (ctx)
            ctx.ui.setStatus("pi-forge-tools", undefined);
    }
    function filterKnownTools(names) {
        const known = new Set(pi.getAllTools().map((tool) => tool.name));
        if (known.size === 0)
            return names;
        return names.filter((name) => known.has(name));
    }
    function notifyActivePreset(ctx, detail) {
        if (!state.active)
            return;
        const errorCount = state.active.diagnostics.filter((d) => d.level === "error").length;
        const warningCount = state.active.diagnostics.filter((d) => d.level === "warning").length;
        const suffix = errorCount || warningCount ? " (" + errorCount + " errors, " + warningCount + " warnings)" : "";
        ctx.ui.notify("pi-forge: active preset " + state.active.stack.id + suffix + " (" + detail + ")", errorCount ? "error" : "info");
    }
    function recordCompileDiagnostics(ctx, diagnostics) {
        state.latestCompileDiagnostics = diagnostics;
        const errors = diagnostics.filter((d) => d.level === "error").length;
        const warnings = diagnostics.filter((d) => d.level === "warning").length;
        if (errors || warnings) {
            ctx.ui.setStatus("pi-forge-diagnostics", ctx.ui.theme.fg(errors ? "error" : "warning", `forge:${errors}e/${warnings}w`));
            return;
        }
        ctx.ui.setStatus("pi-forge-diagnostics", undefined);
    }
    function webHostRuntime(ctx) {
        return {
            getStacks: () => state.stacks,
            getActive: () => state.active,
            getActiveId: activeId,
            getSelectedActiveId: selectedActiveId,
            setActive: (id) => setActive(id, ctx),
            reloadStacks: (preferredId) => reloadStacks(ctx, preferredId),
            buildPreview: (target) => buildPreview(ctx, target, state.sessionVariables, previewOptionsForStack(ctx, target.stack)),
            getPolicyResources: () => getPolicyResources(ctx),
            getPayload: () => ({ ok: true, ...webPayloadSnapshot(state) }),
            armPayload: (savePath) => {
                armPayloadIntercept(state, ctx, savePath, "web");
                return { ok: true, ...webPayloadSnapshot(state) };
            },
            clearPayload: () => {
                clearPayloadCapture(state, ctx);
                return { ok: true, ...webPayloadSnapshot(state) };
            },
        };
    }
    function getPolicyResources(ctx) {
        const options = ctx.getSystemPromptOptions();
        const activeTools = new Set(pi.getActiveTools());
        const snippets = options.toolSnippets ?? {};
        const tools = pi.getAllTools()
            .map((tool) => normalizeToolResource(tool, activeTools, snippets))
            .filter(hasPolicyResourceName)
            .sort(comparePolicyResource);
        const skills = (options.skills ?? [])
            .map(normalizeSkillResource)
            .filter(hasPolicyResourceName)
            .sort(comparePolicyResource);
        return { tools, skills };
    }
    function previewOptionsForStack(ctx, stack) {
        const base = ctx.getSystemPromptOptions();
        const baseSelectedTools = Array.isArray(base.selectedTools) ? base.selectedTools : pi.getActiveTools();
        const policyActive = hasResourcePolicy(stack.tools);
        const baselineTools = policyActive ? (toolPolicyBaseline ?? pi.getActiveTools()) : baseSelectedTools;
        const selectedTools = policyActive
            ? applyResourcePolicy(filterKnownTools(baselineTools), stack.tools)
            : baseSelectedTools;
        const selectedToolSet = new Set(selectedTools);
        const toolSnippets = filterToolSnippets(base.toolSnippets ?? {}, selectedToolSet);
        const toolInfos = pi.getAllTools();
        for (const tool of toolInfos) {
            const name = stringValue(tool.name);
            if (!name || !selectedToolSet.has(name) || toolSnippets[name])
                continue;
            const snippet = stringValue(tool.promptSnippet);
            if (snippet)
                toolSnippets[name] = snippet;
        }
        const mappedGuidelines = toolInfos
            .filter((tool) => {
            const name = stringValue(tool.name);
            return !!name && selectedToolSet.has(name);
        })
            .flatMap((tool) => stringArrayValue(tool.promptGuidelines));
        const promptGuidelines = policyActive && !sameStringSet(baseSelectedTools, selectedTools)
            ? mappedGuidelines
            : (base.promptGuidelines ?? mappedGuidelines);
        return { ...base, selectedTools, toolSnippets, promptGuidelines };
    }
    function filterToolSnippets(snippets, selectedTools) {
        const filtered = {};
        for (const [name, snippet] of Object.entries(snippets)) {
            if (selectedTools.has(name) && snippet)
                filtered[name] = snippet;
        }
        return filtered;
    }
    function normalizeToolResource(tool, activeTools, snippets) {
        const name = String(tool.name ?? "");
        return {
            name,
            description: stringValue(tool.description) ?? stringValue(tool.promptSnippet) ?? snippets[name],
            source: sourceLabel(tool.sourceInfo),
            active: activeTools.has(name),
        };
    }
    function normalizeSkillResource(skill) {
        return {
            name: String(skill.name ?? ""),
            description: stringValue(skill.description),
            source: stringValue(skill.filePath),
            hidden: skill.disableModelInvocation === true,
        };
    }
    function stringValue(value) {
        return typeof value === "string" && value.trim() ? value : undefined;
    }
    function stringArrayValue(value) {
        return Array.isArray(value) ? value.filter((item) => typeof item === "string" && !!item.trim()) : [];
    }
    function sourceLabel(value) {
        if (!value || typeof value !== "object")
            return undefined;
        const source = stringValue(value.source);
        const path = stringValue(value.path);
        if (source && path)
            return `${source}: ${path}`;
        return source ?? path;
    }
    function comparePolicyResource(a, b) {
        return a.name.localeCompare(b.name);
    }
    function hasPolicyResourceName(resource) {
        return !!resource.name.trim();
    }
    function sameStringSet(a, b) {
        if (a.length !== b.length)
            return false;
        const bSet = new Set(b);
        return a.every((value) => bSet.has(value));
    }
    function sharedWebEditorForCwd(cwd) {
        sharedWebEditors.byCwd[cwd] ??= {};
        return sharedWebEditors.byCwd[cwd];
    }
    function syncWebEditorFromShared(cwd) {
        const shared = sharedWebEditorForCwd(cwd);
        webEditor = shared.server;
        webEditorCwd = shared.cwd;
        webEditorPreferredPort = shared.preferredPort;
    }
    function rememberWebEditor(server, cwd, preferredPort) {
        const shared = sharedWebEditorForCwd(cwd);
        webEditor = server;
        webEditorCwd = cwd;
        webEditorPreferredPort = preferredPort;
        shared.server = server;
        shared.cwd = cwd;
        shared.preferredPort = preferredPort;
    }
    function clearWebEditor(server) {
        if (webEditor === server) {
            webEditor = undefined;
            webEditorCwd = undefined;
            webEditorPreferredPort = undefined;
        }
        for (const [cwd, shared] of Object.entries(sharedWebEditors.byCwd)) {
            if (shared?.server === server)
                delete sharedWebEditors.byCwd[cwd];
        }
    }
    function refreshWebEditorHost(ctx) {
        syncWebEditorFromShared(ctx.cwd);
        if (!webEditor)
            return;
        const commandCtx = ctx;
        webEditor.updateHost(createWebEditorHost(commandCtx, webHostRuntime(commandCtx)));
        rememberWebEditor(webEditor, ctx.cwd, webEditorPreferredPort);
        ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
    }
    async function openWebEditor(ctx, mode = "open") {
        syncWebEditorFromShared(ctx.cwd);
        const settings = loadWebEditorSettings(ctx);
        for (const warning of settings.warnings)
            ctx.ui.notify(warning, "warning");
        if (webEditor && (mode === "restart" || webEditorPreferredPort !== settings.preferredPort)) {
            const server = webEditor;
            await server.close();
            clearWebEditor(server);
            ctx.ui.setStatus("pi-forge-editor", undefined);
        }
        if (!webEditor) {
            try {
                webEditor = await startWebEditorServer(createWebEditorHost(ctx, webHostRuntime(ctx)), { port: settings.preferredPort });
            }
            catch (error) {
                if (settings.preferredPort !== undefined) {
                    const detail = error instanceof Error ? error.message : String(error);
                    ctx.ui.notify(`pi-forge: preferred editor port 127.0.0.1:${settings.preferredPort} was unavailable (${detail}); using an available port instead.`, "warning");
                    try {
                        webEditor = await startWebEditorServer(createWebEditorHost(ctx, webHostRuntime(ctx)));
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
            rememberWebEditor(webEditor, ctx.cwd, settings.preferredPort);
            ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
            ctx.ui.notify(`pi-forge: stack editor running at ${webEditor.url}`, "info");
        }
        else {
            webEditor.updateHost(createWebEditorHost(ctx, webHostRuntime(ctx)));
            rememberWebEditor(webEditor, ctx.cwd, settings.preferredPort);
            ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
            ctx.ui.notify(`pi-forge: stack editor already running at ${webEditor.url}`, "info");
        }
        await showText(ctx, "pi-forge stack editor", `Open the local stack editor:\n\n${webEditor.url}\n\nServer bound to 127.0.0.1:${webEditor.port}\nOptional config: ${settings.configPath}\nProject: ${webEditorCwd}`);
    }
    async function stopWebEditor(ctx) {
        syncWebEditorFromShared(ctx.cwd);
        if (!webEditor) {
            ctx.ui.notify("pi-forge: stack editor is not running.", "info");
            return;
        }
        const server = webEditor;
        await server.close();
        clearWebEditor(server);
        ctx.ui.setStatus("pi-forge-editor", undefined);
        ctx.ui.notify("pi-forge: stack editor stopped.", "info");
    }
    registerLifecycleHandlers(pi, state, {
        reloadStacks,
        refreshWebEditorHost,
        notifyActivePreset,
        syncActiveToolPolicy,
        activeId,
        persistActiveSelection,
        recordCompileDiagnostics,
    });
    registerPayloadRequestHandler(pi, state, () => state.active);
    registerPayloadCommands(pi, state);
    registerPresetCommand(pi, state, {
        selectedActiveId,
        setActive,
        reloadStacks,
        openWebEditor,
        stopWebEditor,
    });
}
//# sourceMappingURL=index.js.map