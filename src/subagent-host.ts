import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BuildSystemPromptOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getRegisteredMacros,
	type PromptMacroDefinition,
} from "./macro-engine.ts";
import {
	getRegisteredSlots,
	type PromptSlotDefinition,
} from "./slot-renderers.ts";
import type { LoadedAgentProfile } from "./agent-profile.ts";
import { compileMessages, compileSystemPrompt } from "./compiler.ts";
import {
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	negotiateSubagentTools,
	prepareSubagentInitialMessages,
	type AgentProfileSnapshot,
	type SubagentDependencyKind,
	type SubagentDiagnostic,
	type SubagentPromptDependency,
	type SubagentPreparationInput,
	type SubagentPreparationOutput,
	type SubagentPreparedMessage,
} from "./subagent/contract.ts";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.ts";
import { forgeV1 } from "./forge-v1/index.ts";
import type { LoadedPromptStack, PromptRuntime, PromptStack } from "./types.ts";

export interface SubagentPromptRegistration {
	name: string;
	source?: string;
}

export interface SubagentPromptRegistrationCatalog {
	macros: SubagentPromptRegistration[];
	slots: SubagentPromptRegistration[];
}

export interface SubagentHostResolution {
	profileId: string;
	snapshot?: AgentProfileSnapshot;
	dependencies: SubagentPromptDependency[];
	missingDependencies: Array<{ kind: SubagentDependencyKind; name: string }>;
	diagnostics: SubagentDiagnostic[];
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
	const diagnostics: SubagentDiagnostic[] = loaded.diagnostics.map((diagnostic) => ({
		level: diagnostic.level,
		code: "profile.validation",
		path: diagnostic.field ? `profile.${diagnostic.field}` : "profile",
		message: diagnostic.message,
	} satisfies SubagentDiagnostic));
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
				message: `Global profile ${loaded.profile.id} cannot reference project prompt stack ${parsed.selector.id}.`,
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
						? `Unknown prompt stack: ${reference}`
						: `Prompt stack id is ambiguous: ${reference}`,
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
				if (promptStack.stack.mode !== undefined) diagnostics.push({ level: "error", code: "profile.stack-mode", path: "promptStack.mode", message: `Unsupported prompt stack mode: ${String(promptStack.stack.mode)}` });
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
			schemaVersion: 1,
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

export function prepareSubagentHostPlan(input: SubagentPreparationInput): SubagentPreparationOutput {
	const toolNegotiation = negotiateSubagentTools(input.preflight.toolCatalog, input.snapshot.promptStack?.tools, input.request.access);
	const options: BuildSystemPromptOptions = {
		...structuredClone(input.runtime.options),
		selectedTools: [...toolNegotiation.effectiveToolNames],
		toolSnippets: Object.fromEntries(Object.entries(input.runtime.options.toolSnippets)
			.filter(([name]) => toolNegotiation.effectiveToolNames.includes(name))),
		promptGuidelines: toolNegotiation.effectiveToolNames.length > 0
			? [...input.runtime.options.promptGuidelines]
			: [],
		skills: structuredClone(input.runtime.options.skills) as BuildSystemPromptOptions["skills"],
		contextFiles: [...input.runtime.options.contextFiles],
	};
	const model = {
		provider: input.runtime.model.provider,
		id: input.runtime.model.id,
		api: "unknown",
	};
	const runtime: PromptRuntime = {
		options,
		ctx: { model } as unknown as ExtensionContext,
		latestUserMessage: input.request.input.text,
		now: new Date(input.runtime.preparedAt),
	};
	let systemPrompt = input.runtime.baseSystemPrompt;
	let stackMessages: SubagentPreparedMessage[] = [];
	const diagnostics: SubagentDiagnostic[] = [];
	if (input.snapshot.promptStack) {
		const system = compileSystemPrompt(input.snapshot.promptStack, runtime, input.runtime.baseSystemPrompt);
		systemPrompt = system.systemPrompt;
		diagnostics.push(...system.diagnostics.map((item) => promptDiagnostic("system", item)));
		const messages = compileMessages(input.snapshot.promptStack, runtime, []);
		stackMessages = messages.messages.map(preparedPromptStackMessage);
		diagnostics.push(...messages.diagnostics.map((item) => promptDiagnostic("messages", item)));
	}
	const initial = prepareSubagentInitialMessages(input.request, stackMessages);
	return {
		systemPrompt,
		messages: initial.messages,
		contextBudget: initial.contextBudget,
		toolNegotiation,
		diagnostics: [...diagnostics, ...initial.diagnostics],
	};
}

export function collectSubagentPromptDependencies(
	stack: PromptStack,
	registrations: SubagentPromptRegistrationCatalog = currentSubagentPromptRegistrationCatalog(),
): {
	dependencies: SubagentPromptDependency[];
	missingDependencies: Array<{ kind: SubagentDependencyKind; name: string }>;
	diagnostics: SubagentDiagnostic[];
} {
	const diagnostics: SubagentDiagnostic[] = [];
	const dependencies = new Map<string, SubagentPromptDependency>();
	const missing = new Map<string, { kind: SubagentDependencyKind; name: string }>();
	const macroCatalog = new Map(registrations.macros.map((entry) => [entry.name, entry]));
	const slotCatalog = new Map(registrations.slots.map((entry) => [entry.name, entry]));
	const parameters = new Set([
		...Object.keys(stack.parameters ?? {}),
		...Object.keys(stack.variables ?? {}),
	]);

	for (const item of stack.items) {
		if (item.kind === "slot") {
			if (BUILT_IN_SLOTS.has(item.slot)) continue;
			addDependency("slot", item.slot, slotCatalog, dependencies, missing, diagnostics, `promptStack.items.${item.id}`);
			continue;
		}
		const parsed = forgeV1.parse(item.content);
		if (!parsed.ok) {
			diagnostics.push({
				level: "error",
				code: "prompt-stack.template-parse",
				path: `promptStack.items.${item.id}`,
				message: parsed.error.message,
			});
			continue;
		}
		const analyzed = forgeV1.analyze(parsed.ast);
		for (const error of analyzed.errors) {
			diagnostics.push({
				level: "error",
				code: "prompt-stack.template-analyze",
				path: `promptStack.items.${item.id}`,
				message: error.message,
			});
		}
		for (const dependency of analyzed.dependencies) {
			let name: string | undefined;
			if (dependency.kind === "extensions") name = dependency.path?.[1];
			if (dependency.kind === "legacy") {
				const candidate = dependency.path?.[0];
				if (!candidate || parameters.has(candidate) || LEGACY_BUILTIN_RUNTIME.has(candidate)) continue;
				name = candidate;
			}
			if (!name) continue;
			addDependency("macro", name, macroCatalog, dependencies, missing, diagnostics, `promptStack.items.${item.id}`);
		}
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

export function collectMacroCommandNames(text: string): string[] {
	const parsed = forgeV1.parse(text);
	if (!parsed.ok) return [];
	const analyzed = forgeV1.analyze(parsed.ast);
	const names = new Set<string>();
	for (const dependency of analyzed.dependencies) {
		if (dependency.kind === "extensions") names.add(dependency.path?.[1] ?? "");
		if (dependency.kind === "legacy") {
			const candidate = dependency.path?.[0];
			if (candidate && !LEGACY_BUILTIN_RUNTIME.has(candidate)) names.add(candidate);
		}
	}
	return [...names].sort();
}
export function appendProtectedAgentTask(
	compiledMessages: readonly AgentMessage[],
	protectedTask: AgentMessage,
): AgentMessage[] {
	if (protectedTask.role !== "user") throw new Error("Protected delegated task must be a user message.");
	return [...structuredClone(compiledMessages), structuredClone(protectedTask)];
}

export function compileProtectedAgentTaskMessages(
	stack: LoadedPromptStack,
	runtime: PromptRuntime,
	originalMessages: readonly AgentMessage[],
): { messages: AgentMessage[]; diagnostics: import("./types.ts").PromptStackDiagnostic[] } {
	const taskIndex = findLastUserMessageIndex(originalMessages);
	if (taskIndex === -1) throw new Error("Delegated context contains no final user task.");
	const protectedTask = structuredClone(originalMessages[taskIndex]!);
	const history = originalMessages.filter((_message, index) => index !== taskIndex);
	const compiled = compileMessages(stack.stack, runtime, history);
	return { messages: appendProtectedAgentTask(compiled.messages, protectedTask), diagnostics: compiled.diagnostics };
}

export function isProtectedAgentTaskPreserved(messages: readonly AgentMessage[], task: AgentMessage): boolean {
	if (!messages.length || task.role !== "user") return false;
	const finalMessage = messages.at(-1);
	if (finalMessage?.role !== "user") return false;
	return normalizeUserContent((finalMessage as { content?: unknown }).content)
		=== normalizeUserContent((task as { content?: unknown }).content);
}

function registrationEntry(definition: PromptMacroDefinition | PromptSlotDefinition): SubagentPromptRegistration {
	return { name: definition.name, source: definition.source };
}

function addDependency(
	kind: SubagentDependencyKind,
	name: string,
	catalog: Map<string, SubagentPromptRegistration>,
	dependencies: Map<string, SubagentPromptDependency>,
	missing: Map<string, { kind: SubagentDependencyKind; name: string }>,
	diagnostics: SubagentDiagnostic[],
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


function findLastUserMessageIndex(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

function normalizeUserContent(content: unknown): string {
	const normalized = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [content];
	return JSON.stringify(normalized);
}

function preparedPromptStackMessage(message: AgentMessage): SubagentPreparedMessage {
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom") {
		throw new Error(`Unsupported prompt-stack message role for subagent preparation: ${message.role}`);
	}
	const rawContent = (message as { content?: unknown }).content;
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

function promptDiagnostic(stage: "system" | "messages", diagnostic: import("./types.ts").PromptStackDiagnostic): SubagentDiagnostic {
	return {
		level: diagnostic.level,
		code: `preparation.${stage}`,
		path: diagnostic.itemId ? `promptStack.items.${diagnostic.itemId}` : "promptStack",
		message: diagnostic.message,
	};
}

function compareDependencies(
	left: { kind: SubagentDependencyKind; name: string },
	right: { kind: SubagentDependencyKind; name: string },
): number {
	return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);
}
