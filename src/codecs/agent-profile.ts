import type { AgentProfile } from "../agent-profile.ts";

/**
 * Single canonical serializer for agent profiles. Every writer (profile
 * service, commands, repositories) must go through this function so serialized
 * output stays identical across all write paths.
 */
export function serializeAgentProfile(profile: AgentProfile): string {
	return `${JSON.stringify(profile, null, 2)}\n`;
}
