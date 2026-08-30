import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import { resourcePatternMatches } from "./policy.ts";
import { formatResourceKey, isResourceScope, isValidResourceId, parseResourceSelector, type ResourceScope } from "./resource-identity.ts";
import type { LoadedPromptStack } from "./types.ts";
import { globalAgentProfilesDir } from "./storage.ts";
import {
	readAgentProfiles as readProjects,
	readAgentProfilesScoped as readScoped,
	readGlobalAgentProfiles as readGlobals,
	readSingleAgentProfileFile,
} from "./repositories/agent-profile.ts";
import {
	AGENT_PROFILE_TYPE,
	AGENT_PROFILE_THINKING_LEVELS,
	validateAgentProfile,
	validateAgentProfilePromptStackScope,
	type AgentProfile,
	type AgentProfileDiagnostic,
	type AgentProfileDiagnosticLevel,
	type AgentProfileModelReference,
	type LoadedAgentProfile,
} from "./codecs/agent-profile.ts";

export { AGENT_PROFILE_TYPE, AGENT_PROFILE_THINKING_LEVELS, validateAgentProfile, validateAgentProfilePromptStackScope } from "./codecs/agent-profile.ts";
export type { AgentProfile, AgentProfileDiagnostic, AgentProfileDiagnosticLevel, AgentProfileModelReference, LoadedAgentProfile } from "./codecs/agent-profile.ts";

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(AGENT_PROFILE_THINKING_LEVELS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function loadAgentProfileFile(filePath: string, scope: "global" | "project" = "project"): LoadedAgentProfile {
	return readSingleAgentProfileFile(filePath, scope);
}

export { agentProfilePath, agentProfilesDir } from "./storage.ts";

export function isValidAgentProfileId(id: string): boolean {
	return isValidResourceId(id);
}

export function loadAgentProfiles(cwd: string): LoadedAgentProfile[] {
	return readProjects(cwd);
}

export function loadAgentProfilesScoped(cwd: string, globalDir: string = globalAgentProfilesDir()): LoadedAgentProfile[] {
	return readScoped(cwd, globalDir);
}

export function loadGlobalAgentProfiles(globalDir: string = globalAgentProfilesDir()): LoadedAgentProfile[] {
	return readGlobals(globalDir);
}

export function chooseAutoActivateAgentProfile(profiles: readonly LoadedAgentProfile[]): LoadedAgentProfile | undefined {
	// Project auto-activation has explicit precedence. An invalid or ambiguous
	// project candidate fails closed instead of falling back to a global one.
	const projectCandidates = profiles.filter((loaded) => loaded.scope === "project" && loaded.profile.autoActivate === true);
	if (projectCandidates.length > 0) {
		return projectCandidates.length === 1 && !hasAgentProfileErrors(projectCandidates[0]!.diagnostics)
			? projectCandidates[0]
			: undefined;
	}
	const projectIds = new Set(
		profiles.filter((loaded) => loaded.scope === "project").map((loaded) => loaded.profile.id),
	);
	// Global candidates shadowed by a same-ID project profile must not activate:
	// normal resolution would never see them either.
	const globalCandidates = profiles.filter(
		(loaded) => loaded.scope === "global" && loaded.profile.autoActivate === true && !projectIds.has(loaded.profile.id),
	);
	return globalCandidates.length === 1 && !hasAgentProfileErrors(globalCandidates[0]!.diagnostics)
		? globalCandidates[0]
		: undefined;
}

export function hasAutoActivateAgentProfile(profiles: readonly LoadedAgentProfile[]): boolean {
	// Shadow-aware: a global auto-activate profile whose ID exists in project
	// scope is not a candidate (see chooseAutoActivateAgentProfile), so it must
	// not count as requesting activation either.
	if (profiles.some((loaded) => loaded.scope === "project" && loaded.profile.autoActivate === true)) return true;
	const projectIds = new Set(
		profiles.filter((loaded) => loaded.scope === "project").map((loaded) => loaded.profile.id),
	);
	return profiles.some(
		(loaded) => loaded.scope === "global" && loaded.profile.autoActivate === true && !projectIds.has(loaded.profile.id),
	);
}

export function resolveAgentProfile(
	loaded: LoadedAgentProfile,
	resources: AgentProfileResolutionResources,
): ResolvedAgentProfile {
	const diagnostics = [...loaded.diagnostics];
	const reference = loaded.profile.model;
	const model = findModel(resources.models, reference);
	let effectiveThinkingLevel = loaded.profile.thinkingLevel;

	if (!model) {
		diagnostics.push({
			level: "error",
			field: "model",
			message: `Unknown model: ${reference.provider}/${reference.id}`,
		});
	} else {
		if (resources.availableModels && !findModel(resources.availableModels, reference)) {
			diagnostics.push({
				level: "error",
				field: "model",
				message: `Model ${reference.provider}/${reference.id} has no configured authentication.`,
			});
		}

		effectiveThinkingLevel = clampThinkingLevel(model, loaded.profile.thinkingLevel) as ThinkingLevel;
		if (effectiveThinkingLevel !== loaded.profile.thinkingLevel) {
			diagnostics.push({
				level: "error",
				field: "thinkingLevel",
				message: `Model ${reference.provider}/${reference.id} does not support thinking level ${loaded.profile.thinkingLevel}; Pi would clamp it to ${effectiveThinkingLevel}.`,
			});
		}
	}

	let promptStack: LoadedPromptStack | undefined;
	if (loaded.profile.promptStack !== null) {
		const resolution = resolveProfilePromptStack(loaded, resources.promptStacks);
		diagnostics.push(...resolution.diagnostics);
		promptStack = resolution.stack;
		if (promptStack) {
			for (const diagnostic of promptStack.diagnostics) {
				diagnostics.push({
					level: diagnostic.level,
					field: "promptStack",
					message: `Preset ${promptStack.stack.id}: ${diagnostic.message}`,
				});
			}
			const allowedPatterns = promptStack.stack.tools?.allow?.filter((pattern) => pattern !== "*") ?? [];
			if (resources.toolNames && !promptStack.stack.tools?.allow?.includes("*")) {
				for (const pattern of allowedPatterns) {
					if (resources.toolNames.some((name) => resourcePatternMatches(name, pattern))) continue;
					diagnostics.push({
						level: "warning",
						field: "promptStack",
						message: `Preset ${promptStack.stack.id} allows tool pattern "${pattern}", but it matches no registered tools.`,
					});
				}
			}
		}
	}

	return { loaded, model, promptStack, effectiveThinkingLevel, diagnostics };
}

export function isUsableAgentProfile(loaded: LoadedAgentProfile): boolean {
	return !hasAgentProfileErrors(loaded.diagnostics);
}

export function isResolvedAgentProfileUsable(resolved: ResolvedAgentProfile): boolean {
	return !hasAgentProfileErrors(resolved.diagnostics) && !!resolved.model;
}

export function hasAgentProfileErrors(diagnostics: readonly AgentProfileDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.level === "error");
}

export function renderAgentProfileDiagnostics(diagnostics: readonly AgentProfileDiagnostic[]): string {
	if (diagnostics.length === 0) return "No diagnostics.";
	return diagnostics
		.map((diagnostic) => `${diagnostic.level.toUpperCase()}: ${diagnostic.field ? `${diagnostic.field}: ` : ""}${diagnostic.message}`)
		.join("\n");
}

export function agentProfileFingerprint(profile: AgentProfile): string {
	return JSON.stringify(profile);
}

export function isAgentProfileProvenance(value: unknown): value is AgentProfileProvenance {
	if (!isPlainObject(value) || !isPlainObject(value.snapshot) || !isPlainObject(value.snapshot.model)) return false;
	return typeof value.profileId === "string"
		&& isValidAgentProfileId(value.profileId)
		&& (value.scope === undefined || isResourceScope(value.scope))
		&& typeof value.sourcePath === "string"
		&& typeof value.sourceFingerprint === "string"
		&& typeof value.appliedAt === "string"
		&& !!nonEmptyString(value.snapshot.model.provider)
		&& !!nonEmptyString(value.snapshot.model.id)
		&& typeof value.snapshot.thinkingLevel === "string"
		&& VALID_THINKING_LEVELS.has(value.snapshot.thinkingLevel as ThinkingLevel)
		&& (value.snapshot.promptStack === null || !!nonEmptyString(value.snapshot.promptStack));
}

function resolveProfilePromptStack(
	loaded: LoadedAgentProfile,
	promptStacks: readonly LoadedPromptStack[],
): { stack: LoadedPromptStack | undefined; diagnostics: AgentProfileDiagnostic[] } {
	const diagnostics: AgentProfileDiagnostic[] = [];
	const reference = loaded.profile.promptStack!;
	const parsed = parseResourceSelector(reference);
	if (!parsed.ok) {
		diagnostics.push({ level: "error", field: "promptStack", message: parsed.error });
		return { stack: undefined, diagnostics };
	}

	if (loaded.scope === "global" && parsed.selector.scope === "project") {
		diagnostics.push({
			level: "error",
			field: "promptStack",
			message: `Global profile ${loaded.profile.id} cannot reference project preset ${parsed.selector.id}.`,
		});
		return { stack: undefined, diagnostics };
	}

	const scope = parsed.selector.scope ?? loaded.scope;
	const matches = promptStacks.filter((candidate) => candidate.scope === scope && candidate.stack.id === parsed.selector.id);
	if (matches.length === 1) return { stack: matches[0], diagnostics };

	if (matches.length === 0) {
		const suggestion = loaded.scope === "project" && scope === "project"
			&& promptStacks.some((candidate) => candidate.scope === "global" && candidate.stack.id === parsed.selector.id)
			? ` Use ${formatResourceKey({ scope: "global", id: parsed.selector.id })} to reference the global stack.`
			: "";
		diagnostics.push({
			level: "error",
			field: "promptStack",
			message: `Unknown preset: ${reference}.${suggestion}`,
		});
		return { stack: undefined, diagnostics };
	}

	diagnostics.push({
		level: "error",
		field: "promptStack",
		message: `Preset id is ambiguous: ${reference}`,
	});
	return { stack: undefined, diagnostics };
}

function findModel(models: readonly Model<any>[], reference: AgentProfileModelReference): Model<any> | undefined {
	return models.find((model) => model.provider === reference.provider && model.id === reference.id);
}

export interface AgentProfileResolutionResources {
	models: readonly Model<any>[];
	availableModels?: readonly Model<any>[];
	promptStacks: readonly LoadedPromptStack[];
	toolNames?: readonly string[];
}

export interface ResolvedAgentProfile {
	loaded: LoadedAgentProfile;
	model?: Model<any>;
	promptStack?: LoadedPromptStack;
	effectiveThinkingLevel: ThinkingLevel;
	diagnostics: AgentProfileDiagnostic[];
}

export interface AgentProfileRuntimeSnapshot {
	model: AgentProfileModelReference;
	thinkingLevel: ThinkingLevel;
	promptStack: string | null;
}

export interface AgentProfileProvenance {
	profileId: string;
	/** Scope of the applied profile. Absent on legacy records, which are project-scoped. */
	scope?: ResourceScope;
	sourcePath: string;
	sourceFingerprint: string;
	appliedAt: string;
	snapshot: AgentProfileRuntimeSnapshot;
}
