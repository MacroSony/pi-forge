import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AGENT_PROFILE_TYPE,
	agentProfileFingerprint,
	agentProfilePath,
	hasAgentProfileErrors,
	isResolvedAgentProfileUsable,
	loadAgentProfileFile,
	validateAgentProfile,
	type AgentProfile,
	type AgentProfileDiagnostic,
	type AgentProfileModelReference,
	type AgentProfileProvenance,
	type LoadedAgentProfile,
	type ResolvedAgentProfile,
} from "./agent-profile.ts";
import { PROFILE_ENTRY_TYPE } from "./runtime-state.ts";
import { isSafeAgentProfileMutationPath } from "./storage.ts";
import type { LoadedPromptStack, PromptResourcePolicy } from "./types.ts";

export interface AgentProfileCurrentRuntime {
	model: AgentProfileModelReference | null;
	thinkingLevel: ThinkingLevel;
	promptStack: string | null;
	effectiveTools: string[];
}

export interface AgentProfileCaptureInput {
	model: AgentProfileModelReference | null;
	thinkingLevel: ThinkingLevel;
	promptStack: string | null;
}

export type AgentProfileCaptureResult =
	| { ok: true; profile: AgentProfile; diagnostics: AgentProfileDiagnostic[] }
	| { ok: false; diagnostics: AgentProfileDiagnostic[] };

export type AgentProfileWriteResult =
	| { ok: true; profile: AgentProfile; filePath: string }
	| { ok: false; reason: "exists" | "invalid-path" | "validation" | "io"; diagnostics: AgentProfileDiagnostic[]; error?: string };

export type AgentProfileDeleteResult =
	| { ok: true; filePath: string }
	| { ok: false; reason: "missing" | "invalid-path" | "changed" | "io"; filePath: string; error?: string };

export interface AgentProfileApplicationState {
	active?: LoadedPromptStack;
	lastAppliedProfile?: AgentProfileProvenance;
}

export interface AgentProfileApplicationDeps {
	setActive(id: string | undefined, ctx?: ExtensionContext): boolean;
}

export type AgentProfileApplicationResult =
	| { ok: true; warningCount: number; provenance: AgentProfileProvenance }
	| { ok: false; detail: string; rollbackErrors: string[] };

export interface AgentProfilePreview {
	profileId: string;
	name?: string;
	description?: string;
	sourcePath: string;
	autoActivate: boolean;
	current: AgentProfileCurrentRuntime;
	target: {
		model: AgentProfileModelReference;
		thinkingLevel: ThinkingLevel;
		promptStack: string | null;
		effectiveTools: string[];
		toolPolicy?: PromptResourcePolicy;
	};
	applicable: boolean;
	diagnostics: AgentProfileDiagnostic[];
}

export interface AgentProfileDriftField<T> {
	expected: T;
	actual: T;
	changed: boolean;
}

export interface AgentProfileRuntimeStatus {
	current: AgentProfileCurrentRuntime;
	lastApplied?: {
		provenance: AgentProfileProvenance;
		sourceState: "unchanged" | "changed" | "missing";
		drift: {
			model: AgentProfileDriftField<AgentProfileModelReference | null>;
			thinkingLevel: AgentProfileDriftField<ThinkingLevel>;
			promptStack: AgentProfileDriftField<string | null>;
		};
	};
}

export function captureAgentProfile(
	id: string,
	runtime: AgentProfileCaptureInput,
	existing?: LoadedAgentProfile,
): AgentProfileCaptureResult {
	if (!runtime.model) {
		return {
			ok: false,
			diagnostics: [{ level: "error", field: "model", message: "Cannot capture an agent profile without a selected model." }],
		};
	}

	const profile: AgentProfile = {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id,
		name: existing?.profile.name ?? id,
		description: existing?.profile.description,
		autoActivate: existing?.profile.autoActivate,
		model: { ...runtime.model },
		thinkingLevel: runtime.thinkingLevel,
		promptStack: runtime.promptStack,
	};
	const diagnostics = validateAgentProfile(profile);
	return hasAgentProfileErrors(diagnostics)
		? { ok: false, diagnostics }
		: { ok: true, profile, diagnostics };
}

export function writeAgentProfile(
	cwd: string,
	profile: AgentProfile,
	options: { filePath?: string; overwrite?: boolean } = {},
): AgentProfileWriteResult {
	const diagnostics = validateAgentProfile(profile);
	if (hasAgentProfileErrors(diagnostics)) return { ok: false, reason: "validation", diagnostics };

	const filePath = options.filePath ?? agentProfilePath(cwd, profile.id);
	if (!isSafeAgentProfileMutationPath(cwd, filePath)) {
		return {
			ok: false,
			reason: "invalid-path",
			diagnostics,
			error: `Profile path is outside project agent-profile storage or traverses a symbolic link: ${filePath}`,
		};
	}
	if (existsSync(filePath) && !options.overwrite) return { ok: false, reason: "exists", diagnostics };

	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(profile, null, 2) + "\n", { encoding: "utf8", flag: options.overwrite ? "w" : "wx" });
		return { ok: true, profile, filePath };
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
		if (code === "EEXIST") return { ok: false, reason: "exists", diagnostics };
		return { ok: false, reason: "io", diagnostics, error: error instanceof Error ? error.message : String(error) };
	}
}

export function deleteAgentProfile(cwd: string, loaded: LoadedAgentProfile): AgentProfileDeleteResult {
	const filePath = loaded.filePath;
	if (!isSafeAgentProfileMutationPath(cwd, filePath)) return { ok: false, reason: "invalid-path", filePath };
	if (!existsSync(filePath)) return { ok: false, reason: "missing", filePath };
	const current = loadAgentProfileFile(filePath);
	if (
		current.profile.id !== loaded.profile.id
		|| agentProfileFingerprint(current.profile) !== agentProfileFingerprint(loaded.profile)
	) {
		return { ok: false, reason: "changed", filePath };
	}

	try {
		unlinkSync(filePath);
		return { ok: true, filePath };
	} catch (error) {
		return { ok: false, reason: "io", filePath, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function applyResolvedAgentProfile(
	pi: ExtensionAPI,
	state: AgentProfileApplicationState,
	deps: AgentProfileApplicationDeps,
	resolved: ResolvedAgentProfile,
	ctx: ExtensionContext,
): Promise<AgentProfileApplicationResult> {
	if (!isResolvedAgentProfileUsable(resolved) || !resolved.model) {
		return { ok: false, detail: "Profile failed preflight; runtime state was not changed", rollbackErrors: [] };
	}

	const previousModel = ctx.model;
	const previousThinkingLevel = pi.getThinkingLevel();
	const previousPromptStack = state.active?.stack.id ?? null;
	const modelChanged = !sameModelReference(previousModel, resolved.model);

	try {
		if (modelChanged && !(await pi.setModel(resolved.model))) {
			throw new Error(`Pi could not activate model ${resolved.model.provider}/${resolved.model.id}; authentication may have changed after preflight.`);
		}

		pi.setThinkingLevel(resolved.effectiveThinkingLevel);
		const actualThinkingLevel = pi.getThinkingLevel();
		if (actualThinkingLevel !== resolved.effectiveThinkingLevel) {
			throw new Error(`Pi applied thinking level ${actualThinkingLevel} instead of ${resolved.effectiveThinkingLevel}.`);
		}

		if (!deps.setActive(resolved.loaded.profile.promptStack ?? "none", ctx)) {
			throw new Error(`Prompt stack ${String(resolved.loaded.profile.promptStack)} disappeared after preflight.`);
		}
	} catch (error) {
		const rollbackErrors = await rollbackAgentProfileApplication(pi, deps, ctx, {
			model: previousModel,
			thinkingLevel: previousThinkingLevel,
			promptStack: previousPromptStack,
			modelChanged,
		});
		return { ok: false, detail: error instanceof Error ? error.message : String(error), rollbackErrors };
	}

	const provenance: AgentProfileProvenance = {
		profileId: resolved.loaded.profile.id,
		sourcePath: resolved.loaded.filePath,
		sourceFingerprint: agentProfileFingerprint(resolved.loaded.profile),
		appliedAt: new Date().toISOString(),
		snapshot: {
			model: { provider: resolved.model.provider, id: resolved.model.id },
			thinkingLevel: resolved.effectiveThinkingLevel,
			promptStack: resolved.loaded.profile.promptStack,
		},
	};
	state.lastAppliedProfile = provenance;
	pi.appendEntry(PROFILE_ENTRY_TYPE, { provenance });

	return {
		ok: true,
		warningCount: resolved.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length,
		provenance,
	};
}

export function forgetAgentProfileProvenance(pi: ExtensionAPI, state: AgentProfileApplicationState): boolean {
	if (!state.lastAppliedProfile) return false;
	state.lastAppliedProfile = undefined;
	pi.appendEntry(PROFILE_ENTRY_TYPE, { provenance: null });
	return true;
}

export function createAgentProfilePreview(
	resolved: ResolvedAgentProfile,
	current: AgentProfileCurrentRuntime,
	targetEffectiveTools: string[],
): AgentProfilePreview {
	const profile = resolved.loaded.profile;
	return {
		profileId: profile.id,
		name: profile.name,
		description: profile.description,
		sourcePath: resolved.loaded.filePath,
		autoActivate: profile.autoActivate === true,
		current: cloneCurrentRuntime(current),
		target: {
			model: { ...profile.model },
			thinkingLevel: resolved.effectiveThinkingLevel,
			promptStack: profile.promptStack,
			effectiveTools: [...targetEffectiveTools],
			toolPolicy: resolved.promptStack?.stack.tools ? structuredClone(resolved.promptStack.stack.tools) : undefined,
		},
		applicable: isResolvedAgentProfileUsable(resolved),
		diagnostics: resolved.diagnostics.map((diagnostic) => ({ ...diagnostic })),
	};
}

export function getAgentProfileRuntimeStatus(
	profiles: readonly LoadedAgentProfile[],
	provenance: AgentProfileProvenance | undefined,
	current: AgentProfileCurrentRuntime,
): AgentProfileRuntimeStatus {
	const status: AgentProfileRuntimeStatus = { current: cloneCurrentRuntime(current) };
	if (!provenance) return status;

	const currentSource = profiles.find((loaded) => loaded.filePath === provenance.sourcePath);
	const sourceState = !currentSource
		? "missing"
		: agentProfileFingerprint(currentSource.profile) === provenance.sourceFingerprint ? "unchanged" : "changed";
	status.lastApplied = {
		provenance: structuredClone(provenance),
		sourceState,
		drift: {
			model: driftField(provenance.snapshot.model, current.model, sameModelReferenceValue),
			thinkingLevel: driftField(provenance.snapshot.thinkingLevel, current.thinkingLevel),
			promptStack: driftField(provenance.snapshot.promptStack, current.promptStack),
		},
	};
	return status;
}

async function rollbackAgentProfileApplication(
	pi: ExtensionAPI,
	deps: AgentProfileApplicationDeps,
	ctx: ExtensionContext,
	previous: { model: ExtensionContext["model"]; thinkingLevel: ThinkingLevel; promptStack: string | null; modelChanged: boolean },
): Promise<string[]> {
	const errors: string[] = [];
	try {
		if (!deps.setActive(previous.promptStack ?? "none", ctx)) errors.push(`could not restore prompt stack ${String(previous.promptStack)}`);
	} catch (error) {
		errors.push(`prompt stack restore failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (previous.modelChanged) {
		if (!previous.model) {
			errors.push("Pi has no API for restoring an unset model");
		} else {
			try {
				if (!(await pi.setModel(previous.model))) errors.push(`could not restore model ${previous.model.provider}/${previous.model.id}`);
			} catch (error) {
				errors.push(`model restore failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	try {
		pi.setThinkingLevel(previous.thinkingLevel);
		if (pi.getThinkingLevel() !== previous.thinkingLevel) errors.push(`could not restore thinking level ${previous.thinkingLevel}`);
	} catch (error) {
		errors.push(`thinking-level restore failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return errors;
}

function cloneCurrentRuntime(current: AgentProfileCurrentRuntime): AgentProfileCurrentRuntime {
	return {
		model: current.model ? { ...current.model } : null,
		thinkingLevel: current.thinkingLevel,
		promptStack: current.promptStack,
		effectiveTools: [...current.effectiveTools],
	};
}

function driftField<T>(expected: T, actual: T, equals: (left: T, right: T) => boolean = Object.is): AgentProfileDriftField<T> {
	return { expected, actual, changed: !equals(expected, actual) };
}

function sameModelReference(left: ExtensionContext["model"], right: ExtensionContext["model"]): boolean {
	return !!left && !!right && left.provider === right.provider && left.id === right.id;
}

function sameModelReferenceValue(left: AgentProfileModelReference | null, right: AgentProfileModelReference | null): boolean {
	return left === null || right === null ? left === right : left.provider === right.provider && left.id === right.id;
}
