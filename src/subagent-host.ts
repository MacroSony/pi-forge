import {
	getRegisteredMacros,
	type PromptMacroDefinition,
} from "./macro-engine.ts";
import {
	getRegisteredSlots,
	type PromptSlotDefinition,
} from "./slot-renderers.ts";
import type { LoadedAgentProfile } from "./agent-profile.ts";
import type { AgentProfile } from "./codecs/agent-profile.ts";
import { PromptCompilationContext } from "./compiler.ts";
import { applyResourcePolicy, resourcePatternMatches } from "./policy.ts";
import {
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	type SubagentFingerprint,
} from "./subagent/fingerprints.ts";
import type { ForgeBackendFacts, ForgeBackendTool, ForgePromptAccessFacts } from "./subagent/host-port.ts";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.ts";
import { analyzePromptStack } from "./prompt-analysis.ts";
import type { LoadedPromptStack, PromptResourcePolicy, PromptRuntimeSnapshot, PromptStack, PromptStackDiagnostic } from "./types.ts";

/**
 * Host-owned diagnostic shape for delegation resolution and preparation.
 * Structurally compatible with the optional package's contract diagnostics.
 */
export interface ForgeDelegationDiagnostic {
	level: "error" | "warning" | "info";
	code: string;
	path?: string;
	message: string;
}

export type ForgePromptDependencyKind = "macro" | "slot";

export interface ForgePromptDependency {
	kind: ForgePromptDependencyKind;
	name: string;
	identity: string;
	source?: string;
}

/**
 * Host-owned immutable profile snapshot artifact returned by `resolveProfile`
 * and embedded in `prepare` responses. The optional package validates and
 * binds it into execution plans; the wire schema version is shared with the
 * execution contract by design.
 */
export const FORGE_PROFILE_SNAPSHOT_VERSION = 1 as const;

export interface ForgeProfileSnapshot {
	schemaVersion: typeof FORGE_PROFILE_SNAPSHOT_VERSION;
	/** Canonical scoped selector of the resolved profile (`project:<id>` or `global:<id>`). */
	profileId: string;
	profile: AgentProfile;
	/** Canonical scoped selector of the resolved prompt stack, or null. */
	promptStackId: string | null;
	promptStack: PromptStack | null;
	dependencies: ForgePromptDependency[];
	profileFingerprint: SubagentFingerprint;
	promptStackFingerprint: SubagentFingerprint | null;
}

/**
 * Host-compiled delegation message. Text-only on the host side; the optional
 * package projects these onto the runtime's portable prepared messages.
 */
export interface ForgeDelegationMessage {
	role: "user" | "assistant" | "custom";
	content: Array<{ type: "text"; text: string }>;
	protectedTask?: boolean;
	source?: "prompt-stack" | "delegated-task";
}

export interface SubagentPromptRegistration {
	name: string;
	source?: string;
	dependencies?: string[];
}

export interface SubagentPromptRegistrationCatalog {
	macros: SubagentPromptRegistration[];
	slots: SubagentPromptRegistration[];
}

export interface SubagentHostResolution {
	profileId: string;
	snapshot?: ForgeProfileSnapshot;
	dependencies: ForgePromptDependency[];
	missingDependencies: Array<{ kind: ForgePromptDependencyKind; name: string }>;
	diagnostics: ForgeDelegationDiagnostic[];
}

export interface ForgeDelegationPreparationInput {
	snapshot: ForgeProfileSnapshot;
	task: { text: string };
	access: ForgePromptAccessFacts;
	backend: ForgeBackendFacts;
	cwd: string;
}

export interface ForgeDelegationPreparation {
	systemPrompt: string;
	messages: ForgeDelegationMessage[];
	effectiveToolIds: string[];
	effectiveToolNames: string[];
	diagnostics: ForgeDelegationDiagnostic[];
	preparedAt: string;
}

const BUILT_IN_SLOTS = new Set([
	"chat-history", "tools", "tool-guidelines", "skills", "project-context", "append-system-prompt",
	"date", "cwd", "date-cwd", "active-model", "pi-docs",
]);

export function currentSubagentPromptRegistrationCatalog(): SubagentPromptRegistrationCatalog {
	return {
		macros: getRegisteredMacros().map(registrationEntry),
		slots: getRegisteredSlots().map(registrationEntry),
	};
}

export function resolveSubagentHostProfile(
	loaded: LoadedAgentProfile,
	resources: {
		promptStacks: readonly LoadedPromptStack[];
		registrations?: SubagentPromptRegistrationCatalog;
	},
): SubagentHostResolution {
	const diagnostics: ForgeDelegationDiagnostic[] = loaded.diagnostics.map((diagnostic) => ({
		level: diagnostic.level,
		code: "profile.validation",
		path: diagnostic.field ? `profile.${diagnostic.field}` : "profile",
		message: diagnostic.message,
	} satisfies ForgeDelegationDiagnostic));
	const registrations = resources.registrations ?? currentSubagentPromptRegistrationCatalog();
	let promptStack: LoadedPromptStack | undefined;
	let promptStackId: string | null = null;
	if (loaded.profile.promptStack !== null) {
		const reference = loaded.profile.promptStack;
		const parsed = parseResourceSelector(reference);
		if (!parsed.ok) {
			diagnostics.push({
				level: "error",
				code: "profile.stack-reference",
				path: "profile.promptStack",
				message: parsed.error,
			});
		} else if (loaded.scope === "global" && parsed.selector.scope === "project") {
			diagnostics.push({
				level: "error",
				code: "profile.stack-reference",
				path: "profile.promptStack",
				message: `Global profile ${loaded.profile.id} cannot reference project preset ${parsed.selector.id}.`,
			});
		} else {
			const scope = parsed.selector.scope ?? loaded.scope;
			const matches = resources.promptStacks.filter((candidate) => candidate.scope === scope && candidate.stack.id === parsed.selector.id);
			if (matches.length !== 1) {
				diagnostics.push({
					level: "error",
					code: matches.length === 0 ? "profile.stack-missing" : "profile.stack-ambiguous",
					path: "profile.promptStack",
					message: matches.length === 0
						? `Unknown preset: ${reference}`
						: `Preset id is ambiguous: ${reference}`,
				});
			} else {
				promptStack = matches[0];
				promptStackId = formatResourceKey({ scope, id: parsed.selector.id });
				for (const diagnostic of promptStack.diagnostics) {
					diagnostics.push({
						level: diagnostic.level,
						code: "profile.stack-validation",
						path: diagnostic.itemId ? `promptStack.items.${diagnostic.itemId}` : "promptStack",
						message: diagnostic.message,
					});
				}
				if (!promptStack.stack.mode || !["replace", "append", "prepend"].includes(promptStack.stack.mode)) {
					if (promptStack.stack.mode !== undefined) diagnostics.push({ level: "error", code: "profile.stack-mode", path: "promptStack.mode", message: `Unsupported preset mode: ${String(promptStack.stack.mode)}` });
				}
			}
		}
	}

	const dependencyResult = promptStack
		? collectSubagentPromptDependencies(promptStack.stack, registrations)
		: { dependencies: [], missingDependencies: [], diagnostics: [] };
	diagnostics.push(...dependencyResult.diagnostics);
	const resolution: SubagentHostResolution = {
		profileId: formatResourceKey(loaded.key),
		dependencies: dependencyResult.dependencies,
		missingDependencies: dependencyResult.missingDependencies,
		diagnostics,
	};
	if (!diagnostics.some((diagnostic) => diagnostic.level === "error")) {
		resolution.snapshot = {
			schemaVersion: FORGE_PROFILE_SNAPSHOT_VERSION,
			profileId: formatResourceKey(loaded.key),
			profile: structuredClone(loaded.profile),
			promptStackId,
			promptStack: promptStack ? structuredClone(promptStack.stack) : null,
			dependencies: structuredClone(dependencyResult.dependencies),
			profileFingerprint: subagentSourceProfileFingerprint(loaded.profile),
			promptStackFingerprint: promptStack ? subagentPromptStackFingerprint(promptStack.stack) : null,
		};
	}
	return resolution;
}

/**
 * Forge-native host-owned preparation: negotiate the client tool catalog
 * against stack policy and access facts, compile the resolved stack through
 * one compilation context, and append the protected delegated task. No
 * execution/runtime material (AgentRequest, preflight, limits, or plan
 * fingerprints) is involved; the optional package owns those.
 */
export function prepareForgeDelegation(input: ForgeDelegationPreparationInput): ForgeDelegationPreparation {
	const negotiation = negotiateForgeDelegationTools(input.backend.toolCatalog, input.snapshot.promptStack?.tools, input.access);
	const preparedAt = new Date().toISOString();
	const runtime: PromptRuntimeSnapshot = {
		options: {
			cwd: input.cwd,
			selectedTools: negotiation.effectiveToolNames,
			toolSnippets: {},
			promptGuidelines: [],
			contextFiles: [],
			skills: [],
		},
		model: {
			provider: input.backend.model.provider,
			id: input.backend.model.id,
			api: "unknown",
		},
		latestUserMessage: input.task.text,
		now: new Date(preparedAt),
	};
	const diagnostics: ForgeDelegationDiagnostic[] = [...negotiation.diagnostics];
	let systemPrompt = "";
	let stackMessages: ForgeDelegationMessage[] = [];
	const stack = input.snapshot.promptStack;
	if (stack) {
		const compilation = new PromptCompilationContext(stack, runtime);
		const system = compilation.compileSystemPrompt("");
		systemPrompt = system.systemPrompt;
		diagnostics.push(...system.diagnostics.map((item) => promptDiagnostic("system", item)));
		const messages = compilation.compileMessages([]);
		stackMessages = messages.messages.map(preparedPromptStackMessage);
		diagnostics.push(...messages.diagnostics.map((item) => promptDiagnostic("messages", item)));
	}
	return {
		systemPrompt,
		messages: appendProtectedDelegationTask(stackMessages, input.task),
		effectiveToolIds: negotiation.effectiveToolIds,
		effectiveToolNames: negotiation.effectiveToolNames,
		diagnostics,
		preparedAt,
	};
}

interface ForgeDelegationTool {
	id: string;
	name: string;
	effects: string[];
}

interface ForgeToolNegotiation {
	effectiveToolIds: string[];
	effectiveToolNames: string[];
	diagnostics: ForgeDelegationDiagnostic[];
}

/**
 * Intersect the client-supplied tool catalog with stack tool policy and the
 * prompt-compilation access facts. Semantics mirror the execution contract's
 * tool negotiation in the optional package, which recomputes them as the
 * plan-creation integrity check.
 */
export function negotiateForgeDelegationTools(
	catalog: readonly ForgeBackendTool[],
	policy: PromptResourcePolicy | undefined,
	access: ForgePromptAccessFacts,
): ForgeToolNegotiation {
	const diagnostics: ForgeDelegationDiagnostic[] = [];
	const tools: ForgeDelegationTool[] = catalog.map((tool) => ({
		id: tool.id,
		name: tool.name ?? tool.id,
		effects: [...(tool.effects ?? [])],
	}));
	const names = tools.map((tool) => tool.name);
	const stackSelectedToolNames = applyResourcePolicy(names, policy);
	const selected = new Set(stackSelectedToolNames);
	const effective = tools.filter((tool) => selected.has(tool.name) && toolAllowedByAccess(tool, access));
	const unmatchedAllowPatterns = policy && "allow" in policy
		? (policy.allow ?? []).filter((pattern) => pattern !== "*" && !names.some((name) => resourcePatternMatches(name, pattern)))
		: [];
	for (const pattern of unmatchedAllowPatterns) {
		diagnostics.push({ level: "warning", code: "tools.unmatched-allow", path: "tools.allow", message: `Tool allow pattern matches no backend tools: ${pattern}` });
	}
	for (const tool of tools) {
		if (selected.has(tool.name) && !effective.includes(tool)) {
			diagnostics.push({ level: "info", code: "tools.access-filtered", path: `tools.${tool.name}`, message: `Tool ${tool.name} was removed by request access policy.` });
		}
	}
	return {
		effectiveToolIds: effective.map((tool) => tool.id),
		effectiveToolNames: effective.map((tool) => tool.name),
		diagnostics,
	};
}

function toolAllowedByAccess(tool: ForgeDelegationTool, access: ForgePromptAccessFacts): boolean {
	for (const effect of tool.effects) {
		if (effect === "network" && access.network !== "allow") return false;
		if (effect === "process" && access.allowProcess !== true) return false;
		if (effect === "filesystem-read" && access.level === "none") return false;
		if (effect === "filesystem-write" && access.level !== "workspace-write") return false;
	}
	return true;
}

export function collectSubagentPromptDependencies(
	stack: PromptStack,
	registrations: SubagentPromptRegistrationCatalog = currentSubagentPromptRegistrationCatalog(),
): {
	dependencies: ForgePromptDependency[];
	missingDependencies: Array<{ kind: ForgePromptDependencyKind; name: string }>;
	diagnostics: ForgeDelegationDiagnostic[];
} {
	const diagnostics: ForgeDelegationDiagnostic[] = [];
	const dependencies = new Map<string, ForgePromptDependency>();
	const missing = new Map<string, { kind: ForgePromptDependencyKind; name: string }>();
	const macroCatalog = new Map(registrations.macros.map((entry) => [entry.name, entry]));
	const slotCatalog = new Map(registrations.slots.map((entry) => [entry.name, entry]));
	const parameters = new Set([
		...Object.keys(stack.parameters ?? {}),
		...Object.keys(stack.variables ?? {}),
	]);

	const analysis = analyzePromptStack(stack, registrations);
	for (const error of analysis.diagnostics) {
		diagnostics.push({
			level: "error",
			code: "prompt-stack.template-analyze",
			path: "promptStack",
			message: error.message,
		});
	}

	for (const item of stack.items) {
		if (item.kind === "slot") {
			if (BUILT_IN_SLOTS.has(item.slot)) continue;
			addDependency("slot", item.slot, slotCatalog, dependencies, missing, diagnostics, `promptStack.items.${item.id}`);
		}
	}
	for (const block of analysis.blocks) {
		for (const dependency of block.dependencies) {
			let name: string | undefined;
			if (dependency.kind === "extensions") name = dependency.path?.[1];
			if (dependency.kind === "legacy") {
				const candidate = dependency.path?.[0];
				if (!candidate || parameters.has(candidate) || LEGACY_BUILTIN_RUNTIME.has(candidate)) continue;
				name = candidate;
			}
			if (!name) continue;
			addDependency("macro", name, macroCatalog, dependencies, missing, diagnostics, `promptStack.items.${block.itemId}`);
		}
	}
	for (const name of analysis.transitiveExtensions) {
		if (!name || macroCatalog.has(name)) continue;
		addDependency("macro", name, macroCatalog, dependencies, missing, diagnostics, "promptStack");
	}

	return {
		dependencies: [...dependencies.values()].sort(compareDependencies),
		missingDependencies: [...missing.values()].sort(compareDependencies),
		diagnostics,
	};
}

const LEGACY_BUILTIN_RUNTIME = new Set([
	"cwd", "date", "time", "lastUserMessage", "selectedTools", "tools", "activeModel",
]);

function appendProtectedDelegationTask(
	messages: readonly ForgeDelegationMessage[],
	task: { text: string },
): ForgeDelegationMessage[] {
	return [
		...structuredClone(messages),
		{
			role: "user",
			content: [{ type: "text" as const, text: task.text }],
			protectedTask: true,
			source: "delegated-task" as const,
		},
	];
}

function registrationEntry(definition: PromptMacroDefinition | PromptSlotDefinition): SubagentPromptRegistration {
	return { name: definition.name, source: definition.source, dependencies: definition.dependencies };
}

function addDependency(
	kind: ForgePromptDependencyKind,
	name: string,
	catalog: Map<string, SubagentPromptRegistration>,
	dependencies: Map<string, ForgePromptDependency>,
	missing: Map<string, { kind: ForgePromptDependencyKind; name: string }>,
	diagnostics: ForgeDelegationDiagnostic[],
	path: string,
): void {
	const key = `${kind}:${name}`;
	const registration = catalog.get(name);
	if (!registration) {
		missing.set(key, { kind, name });
		diagnostics.push({ level: "error", code: "profile.dependency-missing", path, message: `Missing required custom ${kind}: ${name}` });
		return;
	}
	const identity = `${kind}:${registration.source ?? "anonymous"}:${name}`;
	dependencies.set(key, { kind, name, identity, source: registration.source });
	if (!registration.source) diagnostics.push({ level: "warning", code: "profile.dependency-anonymous", path, message: `Custom ${kind} ${name} has no stable source identity.` });
}

function preparedPromptStackMessage(message: { role: string; content?: unknown }): ForgeDelegationMessage {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom") {
		throw new Error(`Unsupported prompt-stack message role for subagent preparation: ${message.role}`);
	}
	const rawContent = message.content;
	const parts = typeof rawContent === "string"
		? [{ type: "text" as const, text: rawContent }]
		: Array.isArray(rawContent)
			? rawContent.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
			: [];
	return {
		role: message.role,
		content: parts.length > 0 ? parts : [{ type: "text", text: "" }],
		source: "prompt-stack",
	};
}

function promptDiagnostic(stage: "system" | "messages", diagnostic: PromptStackDiagnostic): ForgeDelegationDiagnostic {
	return {
		level: diagnostic.level,
		code: `preparation.${stage}`,
		path: diagnostic.itemId ? `promptStack.items.${diagnostic.itemId}` : "promptStack",
		message: diagnostic.message,
	};
}

function compareDependencies(
	left: { kind: ForgePromptDependencyKind; name: string },
	right: { kind: ForgePromptDependencyKind; name: string },
): number {
	return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);
}
