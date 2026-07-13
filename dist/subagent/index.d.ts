/**
 * Experimental runner-neutral subagent adapter surface.
 *
 * The package root continues to re-export these names for 0.4 compatibility.
 * New adapter integrations should import from `@zihanw/pi-forge/subagent` so
 * they do not depend on the Pi extension composition entry point.
 */
export * from "../subagent-contract.ts";
export { appendProtectedAgentTask, collectMacroCommandNames, collectSubagentPromptDependencies, compileProtectedAgentTaskMessages, currentSubagentPromptRegistrationCatalog, isProtectedAgentTaskPreserved, resolveSubagentHostProfile, type SubagentHostResolution, type SubagentPromptRegistration, type SubagentPromptRegistrationCatalog, } from "../subagent-host.ts";
export { SubagentBackendRegistry, SubagentBackendRegistryError, type SubagentBackend, type SubagentBackendCancelInput, type SubagentBackendExecutionContext, type SubagentBackendExecutionResult, type SubagentBackendPreparationContext, type SubagentBackendPreflightInput, type SubagentBackendRegistryOptions, type SubagentBackendTraceInput, type SubagentBackendTraceResult, type SubagentExecutionOptions, } from "./backend-registry.ts";
//# sourceMappingURL=index.d.ts.map