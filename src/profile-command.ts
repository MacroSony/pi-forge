import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AGENT_PROFILE_TYPE,
	agentProfileFingerprint,
	agentProfilePath,
	agentProfilesDir,
	hasAgentProfileErrors,
	isResolvedAgentProfileUsable,
	isValidAgentProfileId,
	renderAgentProfileDiagnostics,
	validateAgentProfile,
	type AgentProfile,
	type AgentProfileProvenance,
	type LoadedAgentProfile,
	type ResolvedAgentProfile,
} from "./agent-profile.ts";
import { showText } from "./preview.ts";
import { PROFILE_ENTRY_TYPE, type PiForgeRuntimeState } from "./runtime-state.ts";
import type { PromptStack } from "./types.ts";

export interface ProfileCommandDeps {
	reloadProfiles(ctx: ExtensionContext): void | Promise<void>;
	resolveProfile(target: LoadedAgentProfile, ctx: ExtensionContext): ResolvedAgentProfile;
	setActive(id: string | undefined, ctx?: ExtensionContext): boolean;
	previewToolNames(stack: PromptStack | undefined): string[];
}

export function registerProfileCommand(pi: ExtensionAPI, state: PiForgeRuntimeState, deps: ProfileCommandDeps): void {
	pi.registerCommand("profile", {
		description: "Manage pi-forge agent profiles: list, use, save, status, preview, validate, reload, forget",
		getArgumentCompletions: (prefix) => profileArgumentCompletions(state, prefix),
		handler: async (args, ctx) => {
			await handleProfileCommand(pi, state, deps, args, ctx);
		},
	});
}

function profileArgumentCompletions(state: PiForgeRuntimeState, prefix: string) {
	const parts = prefix.trimStart().split(/\s+/);
	if (parts.length <= 1 && !prefix.endsWith(" ")) {
		const commands = ["list", "use", "save", "status", "preview", "validate", "reload", "forget"];
		return commands.filter((command) => command.startsWith(parts[0] ?? "")).map((command) => ({ value: command, label: command }));
	}

	const command = parts[0];
	if (["use", "preview", "validate"].includes(command)) {
		const fragment = parts[1] ?? "";
		return state.profiles
			.map((loaded) => loaded.profile.id)
			.filter((id, index, ids) => ids.indexOf(id) === index && id.startsWith(fragment))
			.map((id) => ({ value: `${command} ${id}`, label: id }));
	}
	if (command === "save" && parts.length > 2) {
		const fragment = parts.at(-1) ?? "";
		return "--overwrite".startsWith(fragment) ? [{ value: `${parts.slice(0, -1).join(" ")} --overwrite`, label: "--overwrite" }] : [];
	}
	return null;
}

async function handleProfileCommand(
	pi: ExtensionAPI,
	state: PiForgeRuntimeState,
	deps: ProfileCommandDeps,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const trimmed = args.trim();
	const [command = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : ["list"];

	switch (command) {
		case "list":
			await showText(ctx, "pi-forge agent profiles", renderProfileList(state, deps, ctx));
			return;

		case "use":
			await useProfile(pi, state, deps, rest[0], ctx);
			return;

		case "save":
			await saveProfile(pi, state, deps, rest, ctx);
			return;

		case "status":
			await showText(ctx, "pi-forge profile status", renderProfileStatus(pi, state, ctx));
			return;

		case "preview":
			await previewProfile(pi, state, deps, rest[0], ctx);
			return;

		case "validate":
			await validateProfiles(state, deps, rest[0], ctx);
			return;

		case "reload":
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("pi-forge: project is not trusted; agent profiles remain disabled.", "warning");
				return;
			}
			await deps.reloadProfiles(ctx);
			ctx.ui.notify(`pi-forge: reloaded ${state.profiles.length} agent profile(s); no profile was applied.`, "info");
			return;

		case "forget":
			forgetProfileProvenance(pi, state, ctx);
			return;

		default:
			ctx.ui.notify(`Unknown /profile subcommand: ${command}`, "warning");
	}
}

async function useProfile(
	pi: ExtensionAPI,
	state: PiForgeRuntimeState,
	deps: ProfileCommandDeps,
	id: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!id) {
		ctx.ui.notify("Usage: /profile use <id>", "warning");
		return;
	}
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("pi-forge: project is not trusted; refusing to apply an agent profile.", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("pi-forge: wait for the current agent operation to finish before applying a profile.", "warning");
		return;
	}

	const target = findProfile(state, id);
	if (!target) {
		ctx.ui.notify(`Unknown agent profile: ${id}`, "error");
		return;
	}

	const resolved = deps.resolveProfile(target, ctx);
	if (!isResolvedAgentProfileUsable(resolved) || !resolved.model) {
		ctx.ui.notify(`pi-forge: profile ${id} failed preflight; runtime state was not changed.`, "error");
		await showText(ctx, `pi-forge profile validation: ${id}`, renderAgentProfileDiagnostics(resolved.diagnostics));
		return;
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
		const rollbackErrors = await rollbackProfileApplication(pi, deps, ctx, {
			model: previousModel,
			thinkingLevel: previousThinkingLevel,
			promptStack: previousPromptStack,
			modelChanged,
		});
		const detail = error instanceof Error ? error.message : String(error);
		const rollbackSuffix = rollbackErrors.length > 0 ? ` Rollback problems: ${rollbackErrors.join("; ")}` : " Previous runtime state was restored.";
		ctx.ui.notify(`pi-forge: failed to apply profile ${id}: ${detail}${detail.endsWith(".") ? "" : "."}${rollbackSuffix}`, "error");
		return;
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

	const warningCount = resolved.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
	ctx.ui.notify(`pi-forge: applied profile ${id} once${warningCount ? ` with ${warningCount} warning(s)` : ""}; later manual changes will be preserved.`, warningCount ? "warning" : "info");
}

async function rollbackProfileApplication(
	pi: ExtensionAPI,
	deps: ProfileCommandDeps,
	ctx: ExtensionCommandContext,
	previous: { model: ExtensionContext["model"]; thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>; promptStack: string | null; modelChanged: boolean },
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

async function saveProfile(
	pi: ExtensionAPI,
	state: PiForgeRuntimeState,
	deps: ProfileCommandDeps,
	rest: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	const id = rest[0];
	const flags = new Set(rest.slice(1));
	if (!id || [...flags].some((flag) => flag !== "--overwrite")) {
		ctx.ui.notify("Usage: /profile save <id> [--overwrite]", "warning");
		return;
	}
	if (!isValidAgentProfileId(id)) {
		ctx.ui.notify("Profile id must start with a letter or number and contain only letters, numbers, dots, underscores, and hyphens.", "error");
		return;
	}
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("pi-forge: project is not trusted; refusing to write an agent profile.", "warning");
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify("pi-forge: cannot save a profile because no model is currently selected.", "error");
		return;
	}

	const existingMatches = state.profiles.filter((loaded) => loaded.profile.id === id);
	if (existingMatches.length > 1) {
		ctx.ui.notify(`pi-forge: cannot save profile ${id} while duplicate profile ids exist.`, "error");
		return;
	}
	const existing = existingMatches[0];
	const filePath = existing?.filePath ?? agentProfilePath(ctx.cwd, id);
	let overwrite = flags.has("--overwrite");
	if (existsSync(filePath) && !overwrite) {
		if (!ctx.hasUI) {
			ctx.ui.notify(`pi-forge: profile ${id} already exists; re-run with --overwrite.`, "error");
			return;
		}
		overwrite = await ctx.ui.confirm("Overwrite agent profile?", `Replace ${filePath} with the current model, thinking level, and prompt-stack selection?`);
		if (!overwrite) {
			ctx.ui.notify("pi-forge: profile save cancelled; the existing file was left unchanged.", "info");
			return;
		}
	}

	const profile: AgentProfile = {
		schemaVersion: 1,
		type: AGENT_PROFILE_TYPE,
		id,
		name: existing?.profile.name ?? id,
		description: existing?.profile.description,
		model: { provider: ctx.model.provider, id: ctx.model.id },
		thinkingLevel: pi.getThinkingLevel(),
		promptStack: state.active?.stack.id ?? null,
	};
	const diagnostics = validateAgentProfile(profile);
	if (hasAgentProfileErrors(diagnostics)) {
		ctx.ui.notify(`pi-forge: current runtime could not be saved as profile ${id}.`, "error");
		await showText(ctx, `pi-forge profile validation: ${id}`, renderAgentProfileDiagnostics(diagnostics));
		return;
	}

	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(profile, null, 2) + "\n", "utf8");
	} catch (error) {
		ctx.ui.notify(`pi-forge: failed to save profile ${id}: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	await deps.reloadProfiles(ctx);
	ctx.ui.notify(`pi-forge: saved current runtime as profile ${id}; the profile was not applied or marked active.`, "info");
}

async function previewProfile(
	pi: ExtensionAPI,
	state: PiForgeRuntimeState,
	deps: ProfileCommandDeps,
	id: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!id) {
		ctx.ui.notify("Usage: /profile preview <id>", "warning");
		return;
	}
	const target = findProfile(state, id);
	if (!target) {
		ctx.ui.notify(`Unknown agent profile: ${id}`, "error");
		return;
	}
	const resolved = deps.resolveProfile(target, ctx);
	await showText(ctx, `pi-forge profile preview: ${id}`, renderProfilePreview(pi, state, deps, resolved, ctx));
}

async function validateProfiles(
	state: PiForgeRuntimeState,
	deps: ProfileCommandDeps,
	id: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const targets = id ? state.profiles.filter((loaded) => loaded.profile.id === id) : state.profiles;
	if (targets.length === 0) {
		ctx.ui.notify(id ? `Unknown agent profile: ${id}` : "No agent profiles found.", "warning");
		return;
	}

	const text = targets.map((target) => {
		const resolved = deps.resolveProfile(target, ctx);
		return `## ${target.profile.id}\n\nSource: ${target.filePath}\n\n${renderAgentProfileDiagnostics(resolved.diagnostics)}`;
	}).join("\n\n");
	await showText(ctx, id ? `pi-forge profile validation: ${id}` : "pi-forge profile validation", text);
}

function forgetProfileProvenance(pi: ExtensionAPI, state: PiForgeRuntimeState, ctx: ExtensionCommandContext): void {
	if (!state.lastAppliedProfile) {
		ctx.ui.notify("pi-forge: there is no last-applied profile provenance to forget.", "info");
		return;
	}
	state.lastAppliedProfile = undefined;
	pi.appendEntry(PROFILE_ENTRY_TYPE, { provenance: null });
	ctx.ui.notify("pi-forge: forgot last-applied profile provenance; model, thinking level, and prompt stack were not changed.", "info");
}

function renderProfileList(state: PiForgeRuntimeState, deps: ProfileCommandDeps, ctx: ExtensionCommandContext): string {
	const lines = [
		`Agent profile directory: ${agentProfilesDir(ctx.cwd)}`,
		`Last applied: ${state.lastAppliedProfile?.profileId ?? "(none)"}`,
		"",
	];
	if (state.profiles.length === 0) {
		lines.push("No agent profiles found.", "Use /profile save <id> to capture the current runtime.");
		return lines.join("\n");
	}

	for (const loaded of state.profiles) {
		const resolved = deps.resolveProfile(loaded, ctx);
		const errors = resolved.diagnostics.filter((diagnostic) => diagnostic.level === "error").length;
		const warnings = resolved.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
		const marker = state.lastAppliedProfile?.sourcePath === loaded.filePath ? "last applied" : "profile";
		const suffix = errors || warnings ? ` (${errors} errors, ${warnings} warnings)` : "";
		lines.push(`${loaded.profile.id}${loaded.profile.name ? ` — ${loaded.profile.name}` : ""} [${marker}]${suffix}`);
		lines.push(`  ${loaded.filePath}`);
	}

	lines.push(
		"",
		"Commands:",
		"  /profile use <id>",
		"  /profile save <id> [--overwrite]",
		"  /profile status",
		"  /profile preview <id>",
		"  /profile validate [id]",
		"  /profile reload",
		"  /profile forget",
	);
	return lines.join("\n");
}

function renderProfilePreview(
	pi: ExtensionAPI,
	state: PiForgeRuntimeState,
	deps: ProfileCommandDeps,
	resolved: ResolvedAgentProfile,
	ctx: ExtensionCommandContext,
): string {
	const profile = resolved.loaded.profile;
	const currentModel = modelLabel(ctx.model);
	const targetModel = `${profile.model.provider}/${profile.model.id}`;
	const currentStack = state.active?.stack.id ?? "(none)";
	const targetStack = profile.promptStack ?? "(none)";
	const effectiveTools = resolved.promptStack || profile.promptStack === null
		? deps.previewToolNames(resolved.promptStack?.stack)
		: [];
	const policy = resolved.promptStack?.stack.tools;

	return [
		`Profile: ${profile.id}${profile.name ? ` — ${profile.name}` : ""}`,
		`Source: ${resolved.loaded.filePath}`,
		profile.description ? `Description: ${profile.description}` : undefined,
		"",
		`Model: ${currentModel} → ${targetModel}`,
		`Thinking level: ${pi.getThinkingLevel()} → ${resolved.effectiveThinkingLevel}`,
		`Prompt stack: ${currentStack} → ${targetStack}`,
		`Tool policy: ${formatToolPolicy(policy)}`,
		`Effective tools after stack policy: ${effectiveTools.length > 0 ? effectiveTools.join(", ") : "(none)"}`,
		`Applicable: ${isResolvedAgentProfileUsable(resolved) ? "yes" : "no"}`,
		"",
		"Diagnostics:",
		renderAgentProfileDiagnostics(resolved.diagnostics),
	].filter((line): line is string => line !== undefined).join("\n");
}

function renderProfileStatus(pi: ExtensionAPI, state: PiForgeRuntimeState, ctx: ExtensionCommandContext): string {
	const provenance = state.lastAppliedProfile;
	const currentModel = modelLabel(ctx.model);
	const currentThinking = pi.getThinkingLevel();
	const currentStack = state.active?.stack.id ?? null;
	const lines = [
		`Current model: ${currentModel}`,
		`Current thinking level: ${currentThinking}`,
		`Current prompt stack: ${currentStack ?? "(none)"}`,
		`Current effective tools: ${pi.getActiveTools().join(", ") || "(none)"}`,
		"",
	];

	if (!provenance) {
		lines.push("Last applied profile: (none)");
		return lines.join("\n");
	}

	const currentSource = state.profiles.find((loaded) => loaded.filePath === provenance.sourcePath);
	const sourceState = !currentSource
		? "missing"
		: agentProfileFingerprint(currentSource.profile) === provenance.sourceFingerprint ? "unchanged" : "changed since application";
	const modelDrift = currentModel === modelReferenceLabel(provenance.snapshot.model)
		? "unchanged"
		: `${modelReferenceLabel(provenance.snapshot.model)} → ${currentModel}`;
	const thinkingDrift = currentThinking === provenance.snapshot.thinkingLevel
		? "unchanged"
		: `${provenance.snapshot.thinkingLevel} → ${currentThinking}`;
	const stackDrift = currentStack === provenance.snapshot.promptStack
		? "unchanged"
		: `${provenance.snapshot.promptStack ?? "(none)"} → ${currentStack ?? "(none)"}`;

	lines.push(
		`Last applied profile: ${provenance.profileId}`,
		`Applied at: ${provenance.appliedAt}`,
		`Source: ${provenance.sourcePath}`,
		`Profile source: ${sourceState}`,
		"",
		"Runtime drift:",
		`  model: ${modelDrift}`,
		`  thinking level: ${thinkingDrift}`,
		`  prompt stack: ${stackDrift}`,
	);
	return lines.join("\n");
}

function findProfile(state: PiForgeRuntimeState, id: string): LoadedAgentProfile | undefined {
	return state.profiles.find((loaded) => loaded.profile.id === id);
}

function sameModelReference(left: ExtensionContext["model"], right: ExtensionContext["model"]): boolean {
	return !!left && !!right && left.provider === right.provider && left.id === right.id;
}

function modelLabel(model: ExtensionContext["model"]): string {
	return model ? `${model.provider}/${model.id}` : "(none)";
}

function modelReferenceLabel(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function formatToolPolicy(policy: PromptStack["tools"]): string {
	if (policy?.allow?.length) return `allow ${policy.allow.join(", ")}`;
	if (policy?.deny?.length) return `deny ${policy.deny.join(", ")}`;
	return "unrestricted runtime baseline";
}
