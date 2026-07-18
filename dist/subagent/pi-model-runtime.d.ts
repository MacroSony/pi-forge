import { ModelRuntime, type ModelRegistry } from "@earendil-works/pi-coding-agent";
/**
 * Pi 0.80.10 exposes ModelRegistry to extensions as a compatibility facade,
 * while createAgentSession requires the canonical ModelRuntime. The facade
 * retains that runtime internally but does not yet publish a typed accessor.
 */
export declare function modelRuntimeFromRegistry(modelRegistry: ModelRegistry): ModelRuntime;
//# sourceMappingURL=pi-model-runtime.d.ts.map