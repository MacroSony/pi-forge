import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";

/** Local, synchronous discovery only. Not an RPC/authorization or execution boundary. */
export const FORGE_COMMAND_DISCOVERY_EVENT = "pi-forge:command-contribution:v1";
export interface ForgeCommandContribution {
	/** One non-reserved word below /forge, e.g. subagent. */
	name: string;
	description: string;
	handler: RegisteredCommand["handler"];
	getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
}
export interface ForgeCommandDiscovery {
	version: 1;
	provide(contribution: ForgeCommandContribution): void;
}
export interface ForgeCommandEvents {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}
/** The extension owns the returned unsubscribe; no singleton registry or persistent state. */
export function contributeForgeCommand(events: ForgeCommandEvents, contribution: ForgeCommandContribution): () => void {
	if (!/^[a-z][a-z0-9-]*$/.test(contribution.name) || ["help", "ui", "payload"].includes(contribution.name)) {
		throw new Error(`Invalid or reserved Forge command contribution: ${contribution.name}`);
	}
	return events.on(FORGE_COMMAND_DISCOVERY_EVENT, (data) => {
		const request = data as Partial<ForgeCommandDiscovery> | null;
		if (request?.version === 1 && typeof request.provide === "function") request.provide(contribution);
	});
}
