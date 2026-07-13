/**
 * Experimental runner-neutral subagent adapter surface.
 *
 * The package root continues to re-export these names for 0.4 compatibility.
 * New adapter integrations should import from `@zihanw/pi-forge/subagent` so
 * they do not depend on the Pi extension composition entry point.
 */
export * from "../subagent-contract.js";
export { appendProtectedAgentTask, collectMacroCommandNames, collectSubagentPromptDependencies, compileProtectedAgentTaskMessages, currentSubagentPromptRegistrationCatalog, isProtectedAgentTaskPreserved, resolveSubagentHostProfile, } from "../subagent-host.js";
export { SubagentBackendRegistry, SubagentBackendRegistryError, } from "./backend-registry.js";
//# sourceMappingURL=index.js.map