import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	loadForgeSubagentSettings,
	resolveSubagentBackend,
	resolveSubagentProfilePolicy,
	type ResolvedSubagentBackend,
} from "./forge-config.ts";
import { formatResourceKey, type ResourceKey } from "./resource-identity.ts";
import { showText } from "./preview.ts";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
import { requestForgeSubagentApproval } from "./subagent-tool.ts";
import type { AgentResponse, SubagentDiagnostic } from "./subagent/contract.ts";

export function registerForgeSubagentCommand(
	pi: ExtensionAPI,
	runtime: ForgeSubagentRuntime,
	profileIds: () => string[],
	resolveProfileKey: (selector: string) => ResourceKey | undefined,
): void {
	pi.registerCommand("forge-agent", {
		description: "Plan or run a foreground human-approved read-only agent profile",
		getArgumentCompletions: (prefix) => completeForgeAgentArguments(prefix, profileIds(), runtime.backendIds()),
		handler: async (args, ctx) => {
			const parsed = parseForgeAgentArgs(args);
			if (parsed.command === "help") {
				await showText(ctx, "pi-forge agent backend", helpText());
				return;
			}
			const settings = loadForgeSubagentSettings(ctx);
			if (parsed.command === "backends") {
				const resolved = resolveSubagentBackend(settings);
				const descriptors = runtime.descriptors(ctx);
				const loadedProfileIds = profileIds();
				const lines = descriptors.map((descriptor) => [
					`${descriptor.id} @ ${descriptor.version}${descriptor.id === resolved.id ? ` (default: ${backendSourceLabel(resolved)})` : ""}`,
					`  default boundary: shared-user subprocess with read-only model tools`,
					`  prompt runtime: ${descriptor.capabilities.promptRuntimeFidelity}`,
					`  cancellation: ${descriptor.capabilities.cancellation ? "yes" : "no"}`,
					`  remote transport: ${descriptor.capabilities.remoteTransport ? "yes" : "no"}`,
				].join("\n"));
				if (!descriptors.some((descriptor) => descriptor.id === resolved.id)) {
					lines.push(`Configured default backend "${resolved.id}" (${backendSourceLabel(resolved)}) is not registered.`);
				}
				lines.push(`Configured timeout: ${settings.timeoutMs} ms (${settings.timeoutSource}; best-effort host abort).`);
				const enabledPolicies = loadedProfileIds
					.map((profileId) => resolveSubagentProfilePolicy(settings, profileId))
					.filter((policy) => policy.enabled);
				lines.push(enabledPolicies.length === 0
					? "Enabled subagent profiles: none. Add subagents.profiles.<id>.enabled: true to the trusted project's .pi/forge/config.json."
					: [
						"Enabled subagent profiles:",
						...enabledPolicies.map((policy) =>
							`  ${policy.profileId}: backend ${policy.backend.id} (${backendSourceLabel(policy.backend)}${descriptors.some((descriptor) => descriptor.id === policy.backend.id) ? "" : "; not registered"}); timeout ${policy.timeout.milliseconds} ms (${policy.timeout.source}).`
						),
					].join("\n"));
				for (const warning of settings.warnings) lines.push(`Configuration warning: ${warning}`);
				await showText(ctx, "pi-forge subagent backends", lines.join("\n\n") || "No subagent backends registered.");
				return;
			}
			if (parsed.error) {
				ctx.ui.notify(`pi-forge: ${parsed.error}`, "warning");
				return;
			}
			if (!parsed.profileId || !parsed.task) {
				ctx.ui.notify(`Usage: /forge-agent ${parsed.command} <profile> [--backend <id>] <task>`, "warning");
				return;
			}
			for (const warning of settings.warnings) ctx.ui.notify(warning, "warning");
			const profileKey = resolveProfileKey(parsed.profileId);
			if (!profileKey) {
				ctx.ui.notify(`pi-forge: unknown agent profile: ${parsed.profileId}`, "error");
				return;
			}
			const canonicalProfileId = formatResourceKey(profileKey);
			const policy = resolveSubagentProfilePolicy(settings, canonicalProfileId, parsed.backend);
			if (!policy.enabled) {
				ctx.ui.notify(`pi-forge: agent profile "${parsed.profileId}" is not enabled for subagent delegation in subagents.profiles.`, "error");
				return;
			}
			if (parsed.command === "run" && !ctx.hasUI) {
				ctx.ui.notify("pi-forge: subagent execution requires interactive provider-egress confirmation; use /forge-agent plan in non-UI mode.", "error");
				return;
			}
			ctx.ui.setStatus("pi-forge-subagent", ctx.ui.theme.fg("accent", parsed.command === "plan" ? "agent:preparing" : "agent:running"));
			let prepared: ForgeSubagentPreparedRun | undefined;
			try {
				const result = await runtime.prepare(canonicalProfileId, parsed.task, ctx, {
					backendId: policy.backend.id,
					timeoutMs: policy.timeout.milliseconds,
				});
				if (!result.ok) {
					await showText(ctx, "pi-forge subagent diagnostics", renderDiagnostics(result.diagnostics));
					return;
				}
				prepared = result.prepared;
				if (parsed.command === "plan") {
					await showText(ctx, `pi-forge subagent plan: ${parsed.profileId}`, renderPlan(prepared));
					await runtime.discard(prepared);
					prepared = undefined;
					return;
				}
				const approval = await requestForgeSubagentApproval(prepared, parsed.task, ctx, ctx.signal);
				if (!approval.approved) {
					await runtime.discard(prepared);
					prepared = undefined;
					ctx.ui.notify("pi-forge: subagent run cancelled before provider transport.", "info");
					return;
				}
				const response = await runtime.execute(prepared, ctx, ctx.signal);
				prepared = undefined;
				runtime.takeReport?.(response.runId);
				await showText(ctx, `pi-forge subagent result: ${parsed.profileId}`, renderResponse(response));
			} catch (error) {
				if (prepared) await runtime.discard(prepared).catch(() => undefined);
				ctx.ui.notify(`pi-forge subagent failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus("pi-forge-subagent", undefined);
			}
		},
	});
}

type ParsedForgeAgentArgs =
	| { command: "help" }
	| { command: "backends" }
	| { command: "plan" | "run"; profileId?: string; task?: string; backend?: string; error?: string };

function parseForgeAgentArgs(args: string): ParsedForgeAgentArgs {
	const trimmed = args.trim();
	if (!trimmed) return { command: "help" };
	const firstSpace = trimmed.search(/\s/);
	const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();
	if (command === "backends") return { command: "backends" };
	if (command !== "plan" && command !== "run") return { command: "help" };
	const positional: string[] = [];
	let backend: string | undefined;
	const tokens = rest ? rest.split(/\s+/) : [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--backend") {
			const value = tokens[index + 1];
			if (!value || value.startsWith("--")) return { command, error: "--backend requires a backend id value." };
			backend = value;
			index++;
			continue;
		}
		if (token.startsWith("--backend=")) {
			const value = token.slice("--backend=".length);
			if (!value) return { command, error: "--backend requires a backend id value." };
			backend = value;
			continue;
		}
		if (token.startsWith("--")) return { command, error: `Unknown option: ${token}` };
		positional.push(token);
	}
	const [profileId, ...taskTokens] = positional;
	return { command, profileId: profileId || undefined, task: taskTokens.join(" ") || undefined, ...(backend ? { backend } : {}) };
}

function completeForgeAgentArguments(prefix: string, profileIds: string[], backendIds: string[]): Array<{ value: string; label: string }> | null {
	const trimmed = prefix.trimStart();
	if (!trimmed.includes(" ")) {
		return ["backends", "plan", "run"].filter((command) => command.startsWith(trimmed)).map((command) => ({ value: command, label: command }));
	}
	const commandMatch = trimmed.match(/^(plan|run)\s+(.*)$/);
	if (!commandMatch) return null;
	const rest = commandMatch[2] ?? "";
	const tokens = rest.split(/\s+/);
	const last = tokens[tokens.length - 1] ?? "";
	const previous = tokens[tokens.length - 2];
	if (previous === "--backend" || previous?.startsWith("--backend=")) {
		const head = trimmed.slice(0, trimmed.length - last.length);
		return backendIds.filter((id) => id.startsWith(last)).map((id) => ({ value: `${head}${id}`, label: id }));
	}
	if (tokens.length === 1) {
		const partial = tokens[0] ?? "";
		return profileIds.filter((id) => id.startsWith(partial)).map((id) => ({ value: `${commandMatch[1]} ${id}`, label: id }));
	}
	if (last.startsWith("-") && "--backend".startsWith(last)) {
		const head = trimmed.slice(0, trimmed.length - last.length);
		return [{ value: `${head}--backend `, label: "--backend" }];
	}
	return null;
}

function backendSourceLabel(backend: ResolvedSubagentBackend): string {
	switch (backend.source) {
		case "explicit": return "per-run override";
		case "project-profile": return "project profile override";
		case "project": return "project config";
		case "global": return "global config";
		default: return "built-in";
	}
}

function renderPlan(prepared: ForgeSubagentPreparedRun): string {
	const plan = prepared.plan;
	return [
		`Backend: ${plan.backendId}`,
		`Model: ${plan.model.provider}/${plan.model.id}`,
		`Thinking: ${plan.thinkingLevel}`,
		`Profile: ${plan.profile.profileId}`,
		`Prompt stack: ${plan.profile.promptStackId ?? "none"}`,
		`Access: ${plan.access.level}; network ${plan.access.network}; process ${plan.access.process ? "allowed" : "denied"}`,
		`Timeout: ${plan.limits.timeoutMs ? `${plan.limits.timeoutMs.value} ms (${plan.limits.timeoutMs.enforcement})` : "none"}`,
		`Effective tools: ${plan.effectiveToolIds.join(", ") || "none"}`,
		`System prompt: ${plan.systemPrompt.length} chars`,
		`Messages: ${plan.messages.map((message) => `${message.role}${message.protectedTask ? " (protected task)" : ""}`).join(" -> ")}`,
		`Runtime fingerprint: ${plan.promptRuntimeFingerprint}`,
		`Conversation fingerprint: ${plan.conversationFingerprint}`,
		`Execution fingerprint: ${plan.executionFingerprint}`,
		"Provider transport: not started; dry plan discarded.",
		"",
		"Diagnostics:",
		renderDiagnostics(prepared.diagnostics),
	].join("\n");
}

function renderResponse(response: AgentResponse): string {
	const lines = [
		`Status: ${response.status}`,
		`Backend: ${response.backendId}`,
		`Model: ${response.model.provider}/${response.model.id}`,
		`Duration: ${response.durationMs} ms`,
		`Effective tools: ${response.effectiveToolIds.join(", ") || "none"}`,
	];
	if (response.status === "failed") lines.push(`Error: ${response.error.code}: ${response.error.message}`);
	if (response.status === "cancelled" || response.status === "timed-out") lines.push(`Reason: ${response.reason}`);
	if (response.status === "limit-reached") lines.push(`Reached limit: ${response.reachedLimit}`);
	if (response.output?.text) lines.push("", "Output:", response.output.text);
	return lines.join("\n");
}

function renderDiagnostics(diagnostics: readonly SubagentDiagnostic[]): string {
	if (diagnostics.length === 0) return "No diagnostics.";
	return diagnostics.map((diagnostic) => `${diagnostic.level.toUpperCase()} ${diagnostic.code}${diagnostic.path ? ` [${diagnostic.path}]` : ""}: ${diagnostic.message}`).join("\n");
}

function helpText(): string {
	return [
		"Foreground read-only subprocess agent commands:",
		"",
		"  /forge-agent backends",
		"  /forge-agent plan <profile> [--backend <id>] <task>",
		"  /forge-agent run <profile> [--backend <id>] <task>",
		"",
		"plan prepares and validates the exact request without provider transport.",
		"run prepares the exact prompt, asks for human approval, then executes one foreground text task.",
		"The default child exposes read, grep, find, and ls only. It shares the invoking user's OS permissions and is not sandboxed.",
		"",
		"Backend selection: --backend overrides one run. Set subagents.backend in .pi/forge/config.json",
		"(trusted project) or ~/.pi/forge/config.json (global default; project wins). There is no fallback:",
		"if the selected backend is unavailable the run fails before provider transport.",
		"Set subagents.timeoutMs in the same config locations to an integer from 1000 to 3600000.",
		"Profiles are not delegatable by default. Enable and optionally override one with",
		"subagents.profiles.<id>.enabled, backend, and timeoutMs.",
	].join("\n");
}
