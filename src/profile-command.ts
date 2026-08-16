import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	agentProfilePath,
	agentProfilesDir,
	isResolvedAgentProfileUsable,
	isValidAgentProfileId,
	renderAgentProfileDiagnostics,
	type LoadedAgentProfile,
	type ResolvedAgentProfile,
} from "./agent-profile.ts";
import { resolveResourceSelector } from "./catalog.ts";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.ts";
import { globalAgentProfilePath } from "./storage.ts";
import {
	applyResolvedAgentProfile,
	captureAgentProfile,
	createAgentProfilePreview,
	forgetAgentProfileProvenance,
	getAgentProfileRuntimeStatus,
	writeAgentProfile,
	type AgentProfileCurrentRuntime,
	type AgentProfileDriftField,
	type AgentProfilePreview,
} from "./profile-service.ts";
import { showText } from "./preview.ts";
import type { PiForgeRuntimeState } from "./runtime-state.ts";
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
		return profileSelectorCandidates(state)
			.filter((id) => id.startsWith(fragment))
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
			await deps.reloadProfiles(ctx);
			ctx.ui.notify(ctx.isProjectTrusted()
				? `pi-forge: reloaded ${state.profiles.length} agent profile(s); no profile was applied.`
				: `pi-forge: reloaded ${state.profiles.length} global agent profile(s); application and delegation remain disabled in this untrusted project.`,
				ctx.isProjectTrusted() ? "info" : "warning");
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

	const result = await applyResolvedAgentProfile(pi, state, deps, resolved, ctx);
	if (!result.ok) {
		const rollbackSuffix = result.rollbackErrors.length > 0 ? ` Rollback problems: ${result.rollbackErrors.join("; ")}` : " Previous runtime state was restored.";
		const detail = result.detail;
		ctx.ui.notify(`pi-forge: failed to apply profile ${id}: ${detail}${detail.endsWith(".") ? "" : "."}${rollbackSuffix}`, "error");
		return;
	}

	const warningCount = result.warningCount;
	ctx.ui.notify(`pi-forge: applied profile ${id} once${warningCount ? ` with ${warningCount} warning(s)` : ""}; later manual changes will be preserved.`, warningCount ? "warning" : "info");
}

async function saveProfile(
	pi: ExtensionAPI,
	state: PiForgeRuntimeState,
	deps: ProfileCommandDeps,
	rest: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	const selectorText = rest[0];
	const flags = new Set(rest.slice(1));
	if (!selectorText || [...flags].some((flag) => flag !== "--overwrite")) {
		ctx.ui.notify("Usage: /profile save <id|global:id> [--overwrite]", "warning");
		return;
	}
	const parsedSelector = parseResourceSelector(selectorText);
	if (!parsedSelector.ok) {
		ctx.ui.notify(parsedSelector.error, "error");
		return;
	}
	const id = parsedSelector.selector.id;
	const targetScope = parsedSelector.selector.scope ?? "project";
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

	const existingMatches = state.profiles.filter((loaded) => loaded.scope === targetScope && loaded.profile.id === id);
	if (existingMatches.length > 1) {
		ctx.ui.notify(`pi-forge: cannot save profile ${id} while duplicate ${targetScope} profile ids exist.`, "error");
		return;
	}
	const existing = existingMatches[0];
	const filePath = existing?.filePath ?? (targetScope === "project" ? agentProfilePath(ctx.cwd, id) : globalAgentProfilePath(id));
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

	const capture = captureAgentProfile(id, targetScope, {
		model: { provider: ctx.model.provider, id: ctx.model.id },
		thinkingLevel: pi.getThinkingLevel(),
		promptStack: state.active?.key ?? null,
	}, existing);
	if (!capture.ok) {
		ctx.ui.notify(`pi-forge: current runtime could not be saved as profile ${id}.`, "error");
		await showText(ctx, `pi-forge profile validation: ${id}`, renderAgentProfileDiagnostics(capture.diagnostics));
		return;
	}

	const write = writeAgentProfile(ctx.cwd, capture.profile, { filePath, overwrite, scope: targetScope });
	if (!write.ok) {
		if (write.reason === "exists") {
			ctx.ui.notify(`pi-forge: profile ${id} already exists; re-run with --overwrite.`, "error");
		} else if (write.reason === "validation") {
			ctx.ui.notify(`pi-forge: current runtime could not be saved as profile ${id}.`, "error");
			await showText(ctx, `pi-forge profile validation: ${id}`, renderAgentProfileDiagnostics(write.diagnostics));
		} else {
			ctx.ui.notify(`pi-forge: failed to save profile ${id}: ${write.error ?? write.reason}`, "error");
		}
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
	const targetEffectiveTools = resolved.promptStack || resolved.loaded.profile.promptStack === null
		? deps.previewToolNames(resolved.promptStack?.stack)
		: [];
	const preview = createAgentProfilePreview(resolved, currentRuntime(pi, state, ctx), targetEffectiveTools);
	await showText(ctx, `pi-forge profile preview: ${id}`, renderProfilePreview(preview));
}

async function validateProfiles(
	state: PiForgeRuntimeState,
	deps: ProfileCommandDeps,
	id: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const targets = id ? [findProfile(state, id)].filter((loaded): loaded is LoadedAgentProfile => !!loaded) : state.profiles;
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
	if (!forgetAgentProfileProvenance(pi, state)) {
		ctx.ui.notify("pi-forge: there is no last-applied profile provenance to forget.", "info");
		return;
	}
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
		const markers = [
			loaded.profile.autoActivate === true ? "auto" : undefined,
			state.lastAppliedProfile?.sourcePath === loaded.filePath ? "last applied" : "profile",
		].filter((marker): marker is string => !!marker);
		const suffix = errors || warnings ? ` (${errors} errors, ${warnings} warnings)` : "";
		lines.push(`${loaded.profile.id}${loaded.profile.name ? ` — ${loaded.profile.name}` : ""} [${markers.join(", ")}]${suffix}`);
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

function renderProfilePreview(preview: AgentProfilePreview): string {
	return [
		`Profile: ${preview.profileId}${preview.name ? ` — ${preview.name}` : ""}`,
		`Source: ${preview.sourcePath}`,
		preview.description ? `Description: ${preview.description}` : undefined,
		`Auto-activate for fresh sessions: ${preview.autoActivate ? "yes" : "no"}`,
		"",
		`Model: ${modelReferenceLabel(preview.current.model)} → ${modelReferenceLabel(preview.target.model)}`,
		`Thinking level: ${preview.current.thinkingLevel} → ${preview.target.thinkingLevel}`,
		`Prompt stack: ${preview.current.promptStack ?? "(none)"} → ${preview.target.promptStack ?? "(none)"}`,
		`Tool policy: ${formatToolPolicy(preview.target.toolPolicy)}`,
		`Effective tools after stack policy: ${preview.target.effectiveTools.length > 0 ? preview.target.effectiveTools.join(", ") : "(none)"}`,
		`Applicable: ${preview.applicable ? "yes" : "no"}`,
		"",
		"Diagnostics:",
		renderAgentProfileDiagnostics(preview.diagnostics),
	].filter((line): line is string => line !== undefined).join("\n");
}

function renderProfileStatus(pi: ExtensionAPI, state: PiForgeRuntimeState, ctx: ExtensionCommandContext): string {
	const status = getAgentProfileRuntimeStatus(state.profiles, state.lastAppliedProfile, currentRuntime(pi, state, ctx));
	const lines = [
		`Current model: ${modelReferenceLabel(status.current.model)}`,
		`Current thinking level: ${status.current.thinkingLevel}`,
		`Current prompt stack: ${status.current.promptStack ?? "(none)"}`,
		`Current effective tools: ${status.current.effectiveTools.join(", ") || "(none)"}`,
		"",
	];

	if (!status.lastApplied) {
		lines.push("Last applied profile: (none)");
		return lines.join("\n");
	}

	const { provenance, drift } = status.lastApplied;
	const sourceState = status.lastApplied.sourceState === "changed" ? "changed since application" : status.lastApplied.sourceState;

	lines.push(
		`Last applied profile: ${provenance.profileId}`,
		`Applied at: ${provenance.appliedAt}`,
		`Source: ${provenance.sourcePath}`,
		`Profile source: ${sourceState}`,
		"",
		"Runtime drift:",
		`  model: ${formatDrift(drift.model, modelReferenceLabel)}`,
		`  thinking level: ${formatDrift(drift.thinkingLevel, String)}`,
		`  prompt stack: ${formatDrift(drift.promptStack, (value) => value ?? "(none)")}`,
	);
	return lines.join("\n");
}

function profileSelectorCandidates(state: PiForgeRuntimeState): string[] {
	const collidingIds = new Set<string>();
	const byId = new Map<string, number>();
	for (const loaded of state.profiles) {
		const count = (byId.get(loaded.profile.id) ?? 0) + 1;
		byId.set(loaded.profile.id, count);
		if (count === 2) collidingIds.add(loaded.profile.id);
	}

	const candidates: string[] = [];
	for (const loaded of state.profiles) {
		candidates.push(collidingIds.has(loaded.profile.id) ? formatResourceKey(loaded.key) : loaded.profile.id);
	}
	return [...new Set(candidates)].sort();
}

function findProfile(state: PiForgeRuntimeState, selector: string): LoadedAgentProfile | undefined {
	const parsed = parseResourceSelector(selector);
	if (!parsed.ok) return undefined;
	return resolveResourceSelector(state.profiles, parsed.selector);
}

function currentRuntime(pi: ExtensionAPI, state: PiForgeRuntimeState, ctx: ExtensionContext): AgentProfileCurrentRuntime {
	return {
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
		thinkingLevel: pi.getThinkingLevel(),
		promptStack: state.active ? formatResourceKey(state.active.key) : null,
		effectiveTools: pi.getActiveTools(),
	};
}

function modelReferenceLabel(model: { provider: string; id: string } | null): string {
	return model ? `${model.provider}/${model.id}` : "(none)";
}

function formatDrift<T>(field: AgentProfileDriftField<T>, render: (value: T) => string): string {
	return field.changed ? `${render(field.expected)} → ${render(field.actual)}` : "unchanged";
}

function formatToolPolicy(policy: PromptStack["tools"]): string {
	if (policy?.allow?.length) return `allow ${policy.allow.join(", ")}`;
	if (policy?.deny?.length) return `deny ${policy.deny.join(", ")}`;
	return "unrestricted runtime baseline";
}
