import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showText } from "../preview.ts";
import { createWebEditorHost, loadWebEditorSettings, type WebHostRuntime } from "../web-host.ts";
import { startWebEditorServer, type WebEditorServer } from "../web-editor/index.ts";

const WEB_EDITOR_GLOBAL_KEY = "__piForgeWebEditor";

interface SharedWebEditorState {
	server?: WebEditorServer;
	cwd?: string;
	preferredPort?: number;
}

interface SharedWebEditorRegistry {
	byCwd: Record<string, SharedWebEditorState | undefined>;
}

type PiForgeGlobal = typeof globalThis & {
	__piForgeWebEditor?: SharedWebEditorRegistry;
};

export interface WebEditorRuntime {
	refreshHost(ctx: ExtensionContext): void;
	open(ctx: ExtensionCommandContext, mode?: "open" | "restart"): Promise<void>;
	stop(ctx: ExtensionCommandContext): Promise<void>;
}

export function createWebEditorRuntime(createRuntime: (ctx: ExtensionCommandContext) => WebHostRuntime): WebEditorRuntime {
	const sharedWebEditors = getSharedWebEditorRegistry();
	let webEditor: WebEditorServer | undefined;
	let webEditorCwd: string | undefined;
	let preferredPort: number | undefined;

	function createHost(ctx: ExtensionCommandContext) {
		return createWebEditorHost(ctx, createRuntime(ctx));
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
	}

	function remember(server: WebEditorServer, cwd: string, nextPreferredPort: number | undefined): void {
		const shared = sharedForCwd(cwd);
		webEditor = server;
		webEditorCwd = cwd;
		preferredPort = nextPreferredPort;
		shared.server = server;
		shared.cwd = cwd;
		shared.preferredPort = nextPreferredPort;
	}

	function clear(server: WebEditorServer): void {
		if (webEditor === server) {
			webEditor = undefined;
			webEditorCwd = undefined;
			preferredPort = undefined;
		}
		for (const [cwd, shared] of Object.entries(sharedWebEditors.byCwd)) {
			if (shared?.server === server) delete sharedWebEditors.byCwd[cwd];
		}
	}

	function refreshHost(ctx: ExtensionContext): void {
		syncFromShared(ctx.cwd);
		if (!webEditor) return;
		const commandCtx = ctx as ExtensionCommandContext;
		webEditor.updateHost(createHost(commandCtx));
		remember(webEditor, ctx.cwd, preferredPort);
		ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
	}

	async function open(ctx: ExtensionCommandContext, mode: "open" | "restart" = "open"): Promise<void> {
		syncFromShared(ctx.cwd);
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
				webEditor = await startWebEditorServer(createHost(ctx), { port: settings.preferredPort });
			} catch (error) {
				if (settings.preferredPort !== undefined) {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`pi-forge: preferred editor port 127.0.0.1:${settings.preferredPort} was unavailable (${detail}); using an available port instead.`, "warning");
					try {
						webEditor = await startWebEditorServer(createHost(ctx));
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
			remember(webEditor, ctx.cwd, settings.preferredPort);
			ctx.ui.setStatus("pi-forge-editor", ctx.ui.theme.fg("accent", `editor:${webEditor.port}`));
			ctx.ui.notify(`pi-forge: stack editor running at ${webEditor.url}`, "info");
		} else {
			webEditor.updateHost(createHost(ctx));
			remember(webEditor, ctx.cwd, settings.preferredPort);
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

function getSharedWebEditorRegistry(): SharedWebEditorRegistry {
	const globalScope = globalThis as PiForgeGlobal;
	globalScope[WEB_EDITOR_GLOBAL_KEY] ??= { byCwd: {} };
	return globalScope[WEB_EDITOR_GLOBAL_KEY];
}
