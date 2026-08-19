import type { BuildSystemPromptOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptCompileOptions, PromptRuntimeSnapshot } from "./types.ts";
/**
 * Convert Pi's extension-runtime prompt-building inputs into the host-neutral
 * compiler snapshot. This is the only adapter that should translate
 * `BuildSystemPromptOptions` / `ExtensionContext` into `PromptRuntimeSnapshot`.
 */
export declare function promptRuntimeFromPi(options: BuildSystemPromptOptions, ctx: Pick<ExtensionContext, "model"> | undefined, latestUserMessage?: string, now?: Date): PromptRuntimeSnapshot;
/**
 * Build a compiler snapshot from host-neutral compile options and an optional
 * host-neutral model identity. This is the adapter for preview and any non-Pi
 * consumer; it deliberately does not require Pi runtime types.
 */
export declare function promptRuntimeFromCompileOptions(options: PromptCompileOptions, model?: {
    provider: string;
    id: string;
    api?: string;
}, latestUserMessage?: string, now?: Date): PromptRuntimeSnapshot;
//# sourceMappingURL=prompt-runtime.d.ts.map