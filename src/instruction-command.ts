import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatResourceKey } from "./resource-identity.ts";
import { showText } from "./preview.ts";
import type { InstructionRuntime } from "./runtime/instruction-runtime.ts";

const INSTRUCTION_USAGE = "/instruction add <text> | list | bindings | use <[scope:]id> | use-bound <id> | off <activation-id> | status | reset | help";
const INSTRUCTION_VERBS = ["add", "list", "bindings", "use", "use-bound", "off", "status", "reset", "help"];

export function registerInstructionCommand(pi: ExtensionAPI, runtime: InstructionRuntime): void {
	const command = {
		description: "Manage session instruction modes (no inference); /system-update is a legacy alias",
		getArgumentCompletions: (prefix: string) => instructionArgumentCompletions(runtime, prefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await handleInstructionCommand(runtime, args, ctx);
		},
	};
	// Keep the legacy registration as a true alias: the handler and completion
	// projection are intentionally the same functions, not two command paths.
	pi.registerCommand("instruction", command);
	pi.registerCommand("system-update", command);
}

async function handleInstructionCommand(runtime: InstructionRuntime, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { operation, value } = parseInstructionInvocation(args);
	try {
		if (operation === "help") {
			if (value.trim()) throw new Error(`Usage: ${INSTRUCTION_USAGE}`);
			return await showText(ctx, "pi-forge instruction help", instructionHelp());
		}
		if (operation === "list") {
			assertNoValue(value);
			return await showText(ctx, "Instruction mode library", runtime.library(ctx));
		}
		if (operation === "status") {
			assertNoValue(value);
			return await showText(ctx, "Session instructions", runtime.status(ctx));
		}
		if (operation === "bindings") {
			assertNoValue(value);
			const res = runtime.readBindings(ctx);
			if (!res.ok) throw new Error(res.error);
			const content = res.bindings.length
				? res.bindings
					.map(
						(b) =>
							`${b.id}${b.modelCallable ? " [modelCallable]" : " [human-only]"}: ${formatResourceKey(b.ref)}${b.mode.name ? ` — ${b.mode.name}` : ""}`,
					)
					.join("\n")
				: "No instruction mode bindings in active preset.";
			return await showText(ctx, "Preset instruction mode bindings", content);
		}
		if (operation === "use-bound") {
			assertSingleValue(value, "use-bound <id>");
			const res = runtime.useBound(ctx, value.trim(), "user");
			if (!res.ok) throw new Error(res.error);
			notify(ctx, res.message, "info");
			return;
		}
		if (operation !== "add" && operation !== "use" && operation !== "off" && operation !== "reset") {
			throw new Error(`Usage: ${INSTRUCTION_USAGE}`);
		}
		if (operation === "reset") {
			assertNoValue(value);
		} else if (operation !== "add") {
			assertSingleValue(value, `${operation} <${operation === "off" ? "activation-id" : "id"}>`);
		} else if (!value.trim()) {
			throw new Error("Usage: /instruction add <text>");
		}
		const result = runtime.change(ctx, operation, operation === "add" ? value : value.trim());
		notify(ctx, result, "info");
	} catch (error) {
		const message = `pi-forge: ${error instanceof Error ? error.message : "Instruction update failed."}`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else console.error(message);
	}
}

function instructionArgumentCompletions(runtime: InstructionRuntime, prefix: string) {
	const input = prefix.trimStart();
	if (!input) return INSTRUCTION_VERBS.map((verb) => ({ value: verb, label: verb }));
	const match = input.match(/^(\S+)([\s\S]*)$/);
	if (!match) return INSTRUCTION_VERBS.map((verb) => ({ value: verb, label: verb }));
	const operation = match[1]!;
	const remainder = match[2] ?? "";
	if (!remainder && !prefix.endsWith(" ")) {
		return INSTRUCTION_VERBS
			.filter((verb) => verb.startsWith(operation))
			.map((verb) => ({ value: verb, label: verb }));
	}
	if (operation === "add") return null;
	if (!["use", "use-bound", "off"].includes(operation)) return [];
	const argument = remainder.trim();
	if (argument && /\s/.test(argument)) return [];
	// The command API does not pass a context to completion callbacks. The
	// runtime retains only the current session context, and rejects a disposed
	// or cross-session view rather than exposing stale resources.
	const projected = runtime.completionView();
	if (!projected.ok) return [];
	if (operation === "use") {
		return projected.modes
			.filter((candidate) => candidate.id.startsWith(argument))
			.map((candidate) => ({ value: `use ${candidate.id}`, label: candidate.label }));
	}
	if (operation === "use-bound") {
		return projected.bindings
			.filter((candidate) => candidate.id.startsWith(argument))
			.map((candidate) => ({ value: `use-bound ${candidate.id}`, label: candidate.label }));
	}
	return projected.active
		.filter((candidate) => candidate.id.startsWith(argument))
		.map((candidate) => ({ value: `off ${candidate.id}`, label: candidate.label }));
}

function parseInstructionInvocation(args: string): { operation: string; value: string } {
	const input = args.trimStart();
	if (!input) return { operation: "status", value: "" };
	const match = input.match(/^(\S+)([\s\S]*)$/);
	if (!match) return { operation: "status", value: "" };
	const operation = match[1]!;
	const remainder = match[2] ?? "";
	// Remove only the first syntax separator for add. The rest is user text,
	// including internal and trailing whitespace.
	return { operation, value: operation === "add" && remainder.startsWith(" ") ? remainder.slice(1) : remainder.trim() };
}

function assertNoValue(value: string): void {
	if (value.trim()) throw new Error(`Usage: ${INSTRUCTION_USAGE}`);
}

function assertSingleValue(value: string, usage: string): void {
	const trimmed = value.trim();
	if (!trimmed || /\s/.test(trimmed)) throw new Error(`Usage: /instruction ${usage}`);
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else if (level === "error") console.error(message);
	else console.log(message);
}

function instructionHelp(): string {
	return [
		"Usage:",
	`  ${INSTRUCTION_USAGE}`,
	"",
	"add preserves the free-form text after the command and does not infer a mode ID.",
	"use completions use qualified project:<id> or global:<id> resource IDs.",
	"use-bound completes bindings saved on the current active preset, including human-only bindings.",
	"off completes exact active activation IDs; the label identifies the source and actor.",
	"Completions use the current session and last published workspace snapshot only.",
	"Run /instruction list to explicitly reload the instruction-mode library; no watcher or per-keystroke scan is used.",
	"/system-update is the legacy alias for /instruction.",
	].join("\n");
}
