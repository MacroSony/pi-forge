import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProviderPayloadCapture } from "./payload-capture.ts";
import type { PayloadDisplayTarget, PiForgeRuntimeState } from "./runtime-state.ts";
import type { LoadedPromptStack } from "./types.ts";
import type { WebEditorPayloadCapture, WebEditorPayloadSnapshot } from "./web-editor/index.ts";

export function registerPayloadCommands(pi: ExtensionAPI, state: PiForgeRuntimeState): void {
	pi.registerCommand("intercept", {
		description: "Display the next provider payload before it is sent",
		handler: async (_args, ctx) => {
			armPayloadIntercept(state, ctx);
		},
	});

	pi.registerCommand("payload", {
		description: "Inspect or save provider payloads: /payload next [save=<path>]",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1 && !prefix.endsWith(" ")) {
				return ["next"].filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
			}
			if (parts[0] === "next" && parts.length <= 2) {
				const suggestion = "save=.pi/forge/payloads/last.json";
				return suggestion.startsWith(parts[1] ?? "") ? [{ value: `next ${suggestion}`, label: suggestion }] : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [command = "next", ...rest] = args.trim() ? args.trim().split(/\s+/) : ["next"];
			if (command !== "next") {
				ctx.ui.notify(`Unknown /payload subcommand: ${command}`, "warning");
				return;
			}
			const saveArg = rest.find((arg) => arg.startsWith("save="));
			const savePath = saveArg?.slice("save=".length).trim() || undefined;
			armPayloadIntercept(state, ctx, savePath);
		},
	});
}

export function registerPayloadRequestHandler(
	pi: ExtensionAPI,
	state: PiForgeRuntimeState,
	getActive: () => LoadedPromptStack | undefined,
): void {
	pi.on("before_provider_request", async (event, ctx) => {
		if (!state.interceptNextProviderPayload) return;
		const savePath = state.interceptPayloadSavePath;
		const displayTarget = state.interceptPayloadDisplayTarget;
		state.interceptNextProviderPayload = false;
		state.interceptPayloadSavePath = undefined;
		state.interceptPayloadDisplayTarget = "editor";
		state.payloadCaptureArmedAt = undefined;
		ctx.ui.setStatus("pi-forge-intercept", undefined);

		const capture = captureProviderPayload(state, getActive(), event.payload, savePath);
		if (savePath) {
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("pi-forge: project is not trusted; refusing to save provider payload.", "warning");
			} else {
				const resolvedPath = savePath.startsWith("/") ? savePath : join(ctx.cwd, savePath);
				mkdirSync(dirname(resolvedPath), { recursive: true });
				writeFileSync(resolvedPath, capture.text, "utf8");
				ctx.ui.notify(`pi-forge: provider payload saved to ${resolvedPath} (${capture.chars} chars, ~${capture.approxTokens} tokens)`, "info");
			}
		}

		if (displayTarget === "web") {
			ctx.ui.notify(`pi-forge: provider payload captured for web editor (${capture.chars} chars, ~${capture.approxTokens} tokens).`, "info");
			return;
		}

		if (ctx.hasUI) {
			await ctx.ui.editor(`pi-forge: provider payload (${capture.chars} chars, ~${capture.approxTokens} tokens)`, capture.text);
			return;
		}

		console.log(capture.text);
	});
}

export function armPayloadIntercept(
	state: PiForgeRuntimeState,
	ctx: ExtensionCommandContext,
	savePath?: string,
	displayTarget: PayloadDisplayTarget = "editor",
): void {
	state.interceptNextProviderPayload = true;
	state.interceptPayloadSavePath = savePath;
	state.interceptPayloadDisplayTarget = displayTarget;
	state.payloadCaptureArmedAt = new Date().toISOString();
	state.latestProviderPayloadCapture = undefined;
	ctx.ui.setStatus("pi-forge-intercept", ctx.ui.theme.fg("warning", savePath ? "payload:armed+save" : "payload:armed"));
	if (displayTarget === "web") {
		ctx.ui.notify(savePath ? `pi-forge: next provider payload will be captured in the web editor and saved to ${savePath}.` : "pi-forge: next provider payload will be captured in the web editor.", "info");
		return;
	}
	ctx.ui.notify(savePath ? `pi-forge: next provider payload will be displayed and saved to ${savePath}.` : "pi-forge: next provider payload will be displayed before sending.", "info");
}

export function clearPayloadCapture(state: PiForgeRuntimeState, ctx: ExtensionCommandContext): void {
	state.interceptNextProviderPayload = false;
	state.interceptPayloadSavePath = undefined;
	state.interceptPayloadDisplayTarget = "editor";
	state.payloadCaptureArmedAt = undefined;
	state.latestProviderPayloadCapture = undefined;
	ctx.ui.setStatus("pi-forge-intercept", undefined);
}

export function webPayloadSnapshot(state: PiForgeRuntimeState): WebEditorPayloadSnapshot {
	if (state.interceptNextProviderPayload) {
		return {
			status: "armed",
			armedAt: state.payloadCaptureArmedAt,
			savePath: state.interceptPayloadSavePath,
		};
	}
	if (state.latestProviderPayloadCapture) {
		return {
			status: "captured",
			capture: state.latestProviderPayloadCapture,
		};
	}
	return { status: "idle" };
}

function captureProviderPayload(
	state: PiForgeRuntimeState,
	active: LoadedPromptStack | undefined,
	value: unknown,
	savePath?: string,
): WebEditorPayloadCapture {
	const capture = createProviderPayloadCapture(value, { stackId: active?.stack.id, savePath });
	state.latestProviderPayloadCapture = capture;
	return capture;
}
