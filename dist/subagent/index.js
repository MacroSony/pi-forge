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
export * from "./contract.js";
export { FORGE_HOST_CHANNEL, FORGE_HOST_PORT_NAMESPACE, FORGE_HOST_PORT_OPERATIONS, FORGE_HOST_PORT_VERSION, ForgeHost, ForgeHostClient, ForgeHostPortError, validateListProfilesRequest, validateListProfilesResponse, validatePrepareRequest, validatePrepareResponse, validateResolveProfileRequest, validateResolveProfileResponse, } from "./host-port.js";
export { appendProtectedAgentTask, collectMacroCommandNames, collectSubagentPromptDependencies, compileProtectedAgentTaskMessages, currentSubagentPromptRegistrationCatalog, isProtectedAgentTaskPreserved, prepareSubagentHostPlan, resolveSubagentHostProfile, } from "../subagent-host.js";
//# sourceMappingURL=index.js.map