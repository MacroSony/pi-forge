import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatResourceKey } from "./resource-identity.ts";
import { showText } from "./preview.ts";
import type { InstructionRuntime } from "./runtime/instruction-runtime.ts";

export function registerInstructionCommand(pi: ExtensionAPI, runtime: InstructionRuntime): void {
	pi.registerCommand("system-update", {
		description: "Manage session instruction modes: add/list/bindings/use/use-bound/off/status/reset (no inference)",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
			const operation = match?.[1] ?? "status";
			const value = match?.[2] ?? "";
			try {
				if (operation === "list") return await showText(ctx, "Instruction mode library", runtime.library(ctx));
				if (operation === "status") return await showText(ctx, "Session instructions", runtime.status(ctx));
				if (operation === "bindings") {
					const res = runtime.readBindings(ctx);
					if (!res.ok) throw new Error(res.error);
					const content = res.bindings.length
						? res.bindings
							.map(
								(b) =>
									`${b.id}${b.modelCallable ? " [modelCallable]" : ""}: ${formatResourceKey(b.ref)}${b.mode.name ? ` — ${b.mode.name}` : ""}`,
							)
							.join("\n")
						: "No instruction mode bindings in active preset.";
					return await showText(ctx, "Preset instruction mode bindings", content);
				}
				if (operation === "use-bound") {
					if (!value.trim()) throw new Error("Usage: /system-update use-bound <id>");
					const res = runtime.useBound(ctx, value.trim(), "user");
					if (!res.ok) throw new Error(res.error);
					if (ctx.hasUI) ctx.ui.notify(res.message, "info");
					else console.log(res.message);
					return;
				}
				if (operation !== "add" && operation !== "use" && operation !== "off" && operation !== "reset") {
					throw new Error("Usage: /system-update add <text> | list | bindings | use <[scope:]id> | use-bound <id> | off <activation-or-mode-id> | status | reset");
				}
				if (operation === "reset" && value) throw new Error("Usage: /system-update reset");
				const result = runtime.change(ctx, operation, value);
				if (ctx.hasUI) ctx.ui.notify(result, "info");
				else console.log(result);
			} catch (error) {
				const message = `pi-forge: ${error instanceof Error ? error.message : "Instruction update failed."}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else console.error(message);
			}
		},
	});
}
