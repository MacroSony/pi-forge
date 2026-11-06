import type { BuildSystemPromptOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptCompileOptions, PromptRuntimeSnapshot } from "./types.ts";
import { UNSUPPORTED_HOST_MESSAGE } from "./host-compatibility.ts";

/**
 * Convert Pi's extension-runtime prompt-building inputs into the host-neutral
 * compiler snapshot. This is the only adapter that should translate
 * `BuildSystemPromptOptions` / `ExtensionContext` into `PromptRuntimeSnapshot`.
 */
export function promptRuntimeFromPi(
	options: BuildSystemPromptOptions | undefined,
	ctx: Pick<ExtensionContext, "model"> | undefined,
	latestUserMessage?: string,
	now: Date = new Date(),
): PromptRuntimeSnapshot {
	return promptRuntimeFromCompileOptions(
		options,
		ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined,
		latestUserMessage,
		now,
	);
}

/**
 * Build a compiler snapshot from host-neutral compile options and an optional
 * host-neutral model identity. This is the adapter for preview and any non-Pi
 * consumer; it deliberately does not require Pi runtime types.
 */
export function promptRuntimeFromCompileOptions(
	options: PromptCompileOptions | undefined,
	model?: { provider: string; id: string; api?: string },
	latestUserMessage?: string,
	now: Date = new Date(),
): PromptRuntimeSnapshot {
	if (!options) throw new Error(UNSUPPORTED_HOST_MESSAGE);
	return {
		options: {
			cwd: options.cwd,
			selectedTools: options.selectedTools,
			hiddenTools: options.hiddenTools,
			toolSnippets: options.toolSnippets,
			promptGuidelines: options.promptGuidelines,
			appendSystemPrompt: options.appendSystemPrompt,
			contextFiles: options.contextFiles,
			skills: options.skills,
		},
		model,
		latestUserMessage,
		now,
	};
}
