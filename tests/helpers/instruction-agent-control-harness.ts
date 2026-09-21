import {
	BUILTIN_TOOLS,
	DEFAULT_INITIAL_TOOLS,
	createInstructionAgentHarness,
	type InstructionAgentHarness,
	type InstructionAgentHarnessOptions,
} from "./instruction-agent-harness.ts";

export * from "./instruction-agent-harness.ts";

export const DEFAULT_AGENT_CONTROL_INITIAL_TOOLS = [
	...DEFAULT_INITIAL_TOOLS,
	"forge_system_update",
];

export interface InstructionAgentControlHarnessOptions extends InstructionAgentHarnessOptions {
	/** The control tool is explicitly registered for this specialized fixture. */
	allowedTools?: string[];
}

export type InstructionAgentControlHarness = InstructionAgentHarness;

/**
 * Specialized view of the original hermetic harness. Keep the implementation
 * in one place so fetch and process-environment isolation cannot drift.
 */
export async function createInstructionAgentControlHarness(
	options: InstructionAgentControlHarnessOptions,
): Promise<InstructionAgentControlHarness> {
	return createInstructionAgentHarness({
		...options,
		initialTools: options.initialTools ?? DEFAULT_AGENT_CONTROL_INITIAL_TOOLS,
		allowedTools: options.allowedTools ?? DEFAULT_AGENT_CONTROL_INITIAL_TOOLS,
	});
}

export { BUILTIN_TOOLS };
