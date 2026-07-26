import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadForgeSubagentSettings, resolveSubagentBackend, type ForgeSubagentBackendSource } from "./forge-config.ts";
import {
	isResolvedAgentProfileUsable,
	type AgentProfileDiagnostic,
	type LoadedAgentProfile,
	type ResolvedAgentProfile,
} from "./agent-profile.ts";

const MAX_VISIBLE_DESCRIPTION_CHARS = 1_000;

const ForgeSubagentProfilesParameters = Type.Object({});

export interface ForgeSubagentProfileSummary {
	id: string;
	name?: string;
	description?: string;
	model: { provider: string; id: string };
	thinkingLevel: string;
	promptStack: string | null;
	status: "ready" | "unavailable";
	diagnostics: AgentProfileDiagnostic[];
}

export interface ForgeSubagentProfilesToolDetails {
	status: "completed" | "disabled";
	invocationToolAvailable: boolean;
	approvalMode: "interactive" | "unattended-config";
	defaultBackend?: { id: string; source: ForgeSubagentBackendSource };
	configWarnings: string[];
	profiles: ForgeSubagentProfileSummary[];
}

export function registerForgeSubagentProfilesTool(
	pi: ExtensionAPI,
	profiles: () => readonly LoadedAgentProfile[],
	resolveProfile: (profile: LoadedAgentProfile, ctx: ExtensionContext) => ResolvedAgentProfile,
): void {
	pi.registerTool({
		name: "forge_subagent_profiles",
		label: "Forge Subagent Profiles",
		description: [
			"List the currently loaded Pi Forge subagent profiles, descriptions, default backend, and active approval mode.",
			"Use this before forge_subagent when the user has not already specified a profile ID.",
			"This reads only in-memory profile metadata and performs no provider request or subagent prompt preparation.",
		].join(" "),
		parameters: ForgeSubagentProfilesParameters,

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult<ForgeSubagentProfilesToolDetails>> {
			if (!ctx.isProjectTrusted()) {
				return result(
					"Subagent profile discovery is disabled because the project is not trusted.",
					{ status: "disabled", invocationToolAvailable: false, approvalMode: "interactive", configWarnings: [], profiles: [] },
				);
			}

			const invocationToolAvailable = pi.getActiveTools().includes("forge_subagent");
			const settings = loadForgeSubagentSettings(ctx);
			const approvalMode = settings.allowAgentInvocationWithoutApproval ? "unattended-config" : "interactive";
			const defaultBackend = resolveSubagentBackend(settings);
			const summaries = profiles().map((loaded) => summarizeProfile(loaded, resolveProfile(loaded, ctx)));
			return result(
				renderProfileCatalog(summaries, invocationToolAvailable, approvalMode, settings.warnings, defaultBackend),
				{ status: "completed", invocationToolAvailable, approvalMode, defaultBackend, configWarnings: settings.warnings, profiles: summaries },
			);
		},
	});
}

export function summarizeProfile(
	loaded: LoadedAgentProfile,
	resolved: ResolvedAgentProfile,
): ForgeSubagentProfileSummary {
	return {
		id: loaded.profile.id,
		name: loaded.profile.name,
		description: loaded.profile.description,
		model: structuredClone(loaded.profile.model),
		thinkingLevel: loaded.profile.thinkingLevel,
		promptStack: loaded.profile.promptStack,
		status: isResolvedAgentProfileUsable(resolved) ? "ready" : "unavailable",
		diagnostics: structuredClone(resolved.diagnostics),
	};
}

export function renderProfileCatalog(
	profiles: readonly ForgeSubagentProfileSummary[],
	invocationToolAvailable: boolean,
	approvalMode: "interactive" | "unattended-config" = "interactive",
	configWarnings: readonly string[] = [],
	defaultBackend?: { id: string; source: ForgeSubagentBackendSource },
): string {
	if (profiles.length === 0) {
		return [
			`No Pi Forge subagent profiles are currently loaded. Parent invocation tool: ${invocationToolAvailable ? "active" : "inactive"}. Approval mode: ${approvalMode}.`,
			...(defaultBackend ? [`Default backend: ${defaultBackend.id} (${defaultBackend.source}).`] : []),
			...configWarnings.map((warning) => `Configuration warning: ${warning}`),
		].join("\n");
	}

	const ready = profiles.filter((profile) => profile.status === "ready");
	const unavailable = profiles.filter((profile) => profile.status === "unavailable");
	const lines = [
		`Pi Forge subagent profiles: ${ready.length} ready, ${unavailable.length} unavailable.`,
		`Parent invocation tool: ${invocationToolAvailable ? "active" : "inactive; the current tool policy must permit forge_subagent before the main agent can invoke a profile"}.`,
		approvalMode === "unattended-config"
			? "Approval mode: unattended-config; exact backend preflight still runs, but forge_subagent may contact the provider without per-run human approval."
			: "Approval mode: interactive; a ready profile still undergoes exact backend preflight and per-run human approval.",
	];
	if (defaultBackend) lines.push(`Default backend: ${defaultBackend.id} (${defaultBackend.source}); the interactive forge_subagent backend parameter or /forge-agent --backend overrides it per run.`);
	if (configWarnings.length > 0) lines.push(...configWarnings.map((warning) => `Configuration warning: ${warning}`));

	if (ready.length > 0) {
		lines.push("", "Ready profiles:");
		for (const profile of ready) lines.push(...renderProfile(profile));
	}
	if (unavailable.length > 0) {
		lines.push("", "Unavailable profiles:");
		for (const profile of unavailable) lines.push(...renderProfile(profile, true));
	}

	return lines.join("\n");
}

function renderProfile(profile: ForgeSubagentProfileSummary, includeErrors = false): string[] {
	const title = `- ${profile.id}${profile.name ? ` — ${compact(profile.name)}` : ""}`;
	const description = profile.description ? truncate(compact(profile.description), MAX_VISIBLE_DESCRIPTION_CHARS) : "(no description provided)";
	const lines = [
		title,
		`  Description: ${description}`,
		`  Model: ${profile.model.provider}/${profile.model.id}; thinking: ${profile.thinkingLevel}; stack: ${profile.promptStack ?? "none"}`,
	];
	if (includeErrors) {
		const errors = profile.diagnostics.filter((diagnostic) => diagnostic.level === "error");
		lines.push(`  Unavailable because: ${errors.map((diagnostic) => diagnostic.message).join("; ") || "profile resolution failed"}`);
	}
	return lines;
}

function result(
	text: string,
	details: ForgeSubagentProfilesToolDetails,
): AgentToolResult<ForgeSubagentProfilesToolDetails> {
	return { content: [{ type: "text", text }], details: structuredClone(details) };
}

function compact(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
