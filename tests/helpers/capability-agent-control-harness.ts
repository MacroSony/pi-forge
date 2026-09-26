import {
	BUILTIN_TOOLS,
	DEFAULT_INITIAL_TOOLS,
	createCapabilityAgentHarness,
	type CapabilityAgentHarness,
	type CapabilityAgentHarnessOptions,
} from "./capability-agent-harness.ts";

export * from "./capability-agent-harness.ts";

export const DEFAULT_AGENT_CONTROL_INITIAL_TOOLS = [
	...DEFAULT_INITIAL_TOOLS,
	"forge_capability",
];

export interface CapabilityAgentControlHarnessOptions extends CapabilityAgentHarnessOptions {
	/** The control tool is explicitly registered for this specialized fixture. */
	allowedTools?: string[];
}

export type CapabilityAgentControlHarness = CapabilityAgentHarness;

/**
 * Specialized view of the original hermetic harness. Keep the implementation
 * in one place so fetch and process-environment isolation cannot drift.
 */
export async function createCapabilityAgentControlHarness(
	options: CapabilityAgentControlHarnessOptions,
): Promise<CapabilityAgentControlHarness> {
	return createCapabilityAgentHarness({
		...options,
		initialTools: options.initialTools ?? DEFAULT_AGENT_CONTROL_INITIAL_TOOLS,
		allowedTools: options.allowedTools ?? DEFAULT_AGENT_CONTROL_INITIAL_TOOLS,
	});
}

export { BUILTIN_TOOLS };
