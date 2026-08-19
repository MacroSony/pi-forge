/**
 * Versioned `/subagent` host port: the minimal Forge DTO host contract.
 *
 * Wire messages, recursive validators, transport, and client/host lifecycle,
 * plus the Forge-owned canonical fingerprint helpers used for host-issued
 * profile snapshots. The main package carries no dependency on
 * `@zihanw/pi-subagent-runtime`; the execution contract (request, preflight,
 * plan, response, context, tool negotiation) lives in the optional
 * `@zihanw/pi-forge-subagents` package, which consumes this port.
 */
export { FORGE_HOST_CHANNEL, FORGE_HOST_PORT_NAMESPACE, FORGE_HOST_PORT_OPERATIONS, FORGE_HOST_PORT_VERSION, ForgeHost, ForgeHostClient, ForgeHostPortError, validateListProfilesRequest, validateListProfilesResponse, validatePrepareRequest, validatePrepareResponse, validateResolveProfileRequest, validateResolveProfileResponse, } from "./host-port.js";
export { SUBAGENT_FINGERPRINT_PREFIX, canonicalSubagentJson, subagentFingerprint, subagentPromptStackFingerprint, subagentSourceProfileFingerprint, } from "./fingerprints.js";
//# sourceMappingURL=index.js.map