import type { BuildSystemPromptOptions, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showText } from "../preview.ts";
import { createWebEditorHost, loadWebEditorSettings, type WebHostRuntime } from "../web-host.ts";
import { startWebEditorServer, type WebEditorServer } from "../web-editor/index.ts";

const WEB_EDITOR_GLOBAL_KEY = "__piForgeWebEditor";

interface SharedWebEditorState {
	server?: WebEditorServer;
	cwd?: string;
	preferredPort?: number;
	promptOptions?: BuildSystemPromptOptions;
}

interface SharedWebEditorRegistry {
	byCwd: Record<string, SharedWebEditorState | undefined>;
}

type PiForgeGlobal = typeof globalThis & {
	__piForgeWebEditor?: SharedWebEditorRegistry;
};

export interface WebEditorRuntime {
	refreshHost(ctx: ExtensionContext, promptOptions?: BuildSystemPromptOptions): void;
	open(ctx: ExtensionCommandContext, mode?: "open" | "restart"): Promise<void>;
	stop(ctx: ExtensionCommandContext): Promise<void>;
}

export function createWebEditorRuntime(
	createRuntime: (ctx: ExtensionContext, promptOptions: BuildSystemPromptOptions) => WebHostRuntime,
): WebEditorRuntime {
	const sharedWebEditors = getSharedWebEditorRegistry();
	let webEditor: WebEditorServer | undefined;
	let webEditorCwd: string | undefined;
	let preferredPort: number | undefined;
	let promptOptions: BuildSystemPromptOptions | undefined;

	function createHost(ctx: ExtensionContext, options: BuildSystemPromptOptions) {
		return createWebEditorHost(ctx, createRuntime(ctx, options));
	}

	function sharedForCwd(cwd: string): SharedWebEditorState {
		sharedWebEditors.byCwd[cwd] ??= {};
		return sharedWebEditors.byCwd[cwd];
	}

	function syncFromShared(cwd: string): void {
		const shared = sharedForCwd(cwd);
		webEditor = shared.server;
		webEditorCwd = shared.cwd;
		preferredPort = shared.preferredPort;
		promptOptions = shared.promptOptions;
	}

	function remember(server: WebEditorServer, cwd: string, nextPreferredPort: number | undefined, options: BuildSystemPromptOptions): void {
		const shared = sharedForCwd(cwd);
		webEditor = server;
		webEditorCwd = cwd;
		preferredPort = nextPreferredPort;
		promptOptions = options;
		shared.server = server;
		shared.cwd = cwd;
		shared.preferredPort = nextPreferredPort;
		shared.promptOptions = options;
	}

	function clear(server: WebEditorServer): void {
		if (webEditor === server) {
			webEditor = undefined;
			webEditorCwd = undefined;
			preferredPort = undefined;
			promptOptions = undefined;
		}
		for (const [cwd, shared] of Object.entries(sharedWebEditors.byCwd)) {
			if (shared?.server === server) delete sharedWebEditors.byCwd[cwd];
		}
	}

	function refreshHost(ctx: ExtensionContext, nextPromptOptions?: BuildSystemPromptOptions): void {
		syncFromShared(ctx.cwd);
		if (!webEditor) return;
		if (nextPromptOptions) promptOptions = snapshotPromptOptions(nextPromptOptions);
		if (!promptOptions) return;
		webEditor.updateHost(createHost(ctx, promptOptions));
		remember(webEditor, ctx.cwd, preferredPort, promptOptions);
		ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
	}

	async function open(ctx: ExtensionCommandContext, mode: "open" | "restart" = "open"): Promise<void> {
		syncFromShared(ctx.cwd);
		promptOptions = snapshotPromptOptions(ctx.getSystemPromptOptions());
		const settings = loadWebEditorSettings(ctx);
		for (const warning of settings.warnings) ctx.ui.notify(warning, "warning");

		if (webEditor && (mode === "restart" || preferredPort !== settings.preferredPort)) {
			const server = webEditor;
			await server.close();
			clear(server);
			ctx.ui.setStatus("pi-forge-editor", undefined);
		}

		if (!webEditor) {
			try {
				webEditor = await startWebEditorServer(createHost(ctx, promptOptions), { port: settings.preferredPort });
			} catch (error) {
				if (settings.preferredPort !== undefined) {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`pi-forge: preferred editor port 127.0.0.1:${settings.preferredPort} was unavailable (${detail}); using an available port instead.`, "warning");
					try {
						webEditor = await startWebEditorServer(createHost(ctx, promptOptions));
					} catch (fallbackError) {
						const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
						ctx.ui.setStatus("pi-forge-editor", undefined);
						ctx.ui.notify(`pi-forge: failed to start stack editor on an available localhost port: ${fallbackDetail}.`, "error");
						return;
					}
				} else {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.setStatus("pi-forge-editor", undefined);
					ctx.ui.notify(`pi-forge: failed to start stack editor on an available localhost port: ${detail}.`, "error");
					return;
				}
			}
			remember(webEditor, ctx.cwd, settings.preferredPort, promptOptions);
			ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
			ctx.ui.notify(`pi-forge: stack editor running at ${webEditor.url}`, "info");
		} else {
			webEditor.updateHost(createHost(ctx, promptOptions));
			remember(webEditor, ctx.cwd, settings.preferredPort, promptOptions);
			ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
			ctx.ui.notify(`pi-forge: stack editor already running at ${webEditor.url}`, "info");
		}

		await showText(ctx, "pi-forge stack editor", `Open the local stack editor:\n\n${webEditor.url}\n\nServer bound to 127.0.0.1:${webEditor.port}\nOptional config: ${settings.configPath}\nProject: ${webEditorCwd}`);
	}

	async function stop(ctx: ExtensionCommandContext): Promise<void> {
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

function snapshotPromptOptions(options: BuildSystemPromptOptions): BuildSystemPromptOptions {
	return structuredClone(options);
}

function getSharedWebEditorRegistry(): SharedWebEditorRegistry {
	const globalScope = globalThis as PiForgeGlobal;
	globalScope[WEB_EDITOR_GLOBAL_KEY] ??= { byCwd: {} };
	return globalScope[WEB_EDITOR_GLOBAL_KEY];
}
