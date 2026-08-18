/**
 * Single canonical serializer for prompt stacks. Every writer (web host,
 * repositories, migration tooling) must go through this function so serialized
 * output stays identical across all write paths.
 */
export function serializePromptStack(stack) {
    return `${JSON.stringify(stack, null, 2)}\n`;
}
//# sourceMappingURL=prompt-stack.js.map