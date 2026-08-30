import type { LoadedPromptStack, PromptStack, PromptStackDiagnostic } from "../types.ts";
export type PromptStackScope = "global" | "project";
/**
 * Parse, normalize, and validate a preset from its serialized source.
 * This is the single entry point for turning stack JSON text into a
 * LoadedPromptStack; loaders only add file-system concerns on top.
 */
export declare function parsePromptStack(source: string, filePath: string, scope: PromptStackScope): LoadedPromptStack;
/** Build a fail-closed LoadedPromptStack when the source cannot be read or parsed. */
export declare function createPromptStackFault(filePath: string, scope: PromptStackScope, message: string): LoadedPromptStack;
/**
 * Single canonical serializer for presets. Every writer (web host,
 * repository, migration tooling) must go through this function so serialized
 * output stays identical across all write paths.
 */
export declare function serializePromptStack(stack: PromptStack): string;
export declare function validatePromptStack(stack: PromptStack): PromptStackDiagnostic[];
//# sourceMappingURL=prompt-stack.d.ts.map