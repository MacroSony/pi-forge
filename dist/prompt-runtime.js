/**
 * Convert Pi's extension-runtime prompt-building inputs into the host-neutral
 * compiler snapshot. This is the only adapter that should translate
 * `BuildSystemPromptOptions` / `ExtensionContext` into `PromptRuntimeSnapshot`.
 */
export function promptRuntimeFromPi(options, ctx, latestUserMessage, now = new Date()) {
    return promptRuntimeFromCompileOptions(options, ctx?.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined, latestUserMessage, now);
}
/**
 * Build a compiler snapshot from host-neutral compile options and an optional
 * host-neutral model identity. This is the adapter for preview and any non-Pi
 * consumer; it deliberately does not require Pi runtime types.
 */
export function promptRuntimeFromCompileOptions(options, model, latestUserMessage, now = new Date()) {
    return {
        options: {
            cwd: options.cwd,
            selectedTools: options.selectedTools,
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
//# sourceMappingURL=prompt-runtime.js.map