/**
 * Experimental runner-neutral subagent adapter surface.
 *
 * The package root continues to re-export these names for 0.4 compatibility.
 * New adapter integrations should import from `@zihanw/pi-forge/subagent` so
 * they do not depend on the Pi extension composition entry point.
 *
 * Execution ownership (backend registry, sealing, lifecycle, process
 * backends) now lives in `@zihanw/pi-subagent-runtime`; this surface keeps
 * the Forge host contracts: profiles, compilation, approval, and reporting.
 */
export * from "./contract.ts";
export { FORGE_HOST_CHANNEL, FORGE_HOST_PORT_NAMESPACE, FORGE_HOST_PORT_OPERATIONS, FORGE_HOST_PORT_VERSION, ForgeHost, ForgeHostClient, ForgeHostPortError, validateListProfilesRequest, validateListProfilesResponse, validatePrepareRequest, validatePrepareResponse, } from "./host-port.ts";
export type { ForgeAccessRequest, ForgeBackendFacts, ForgeBackendTool, ForgeHostConnection, ForgeHostClientOptions, ForgeHostOptions, ForgeHostPortOperation, ForgeHostPortResult, ForgeHostTransport, ForgePrepareRequest, ForgePrepareResponse, ForgeProfileSummary, } from "./host-port.ts";
export { appendProtectedAgentTask, collectMacroCommandNames, collectSubagentPromptDependencies, compileProtectedAgentTaskMessages, currentSubagentPromptRegistrationCatalog, isProtectedAgentTaskPreserved, prepareSubagentHostPlan, resolveSubagentHostProfile, type SubagentHostResolution, type SubagentPromptRegistration, type SubagentPromptRegistrationCatalog, } from "../subagent-host.ts";
//# sourceMappingURL=index.d.ts.map