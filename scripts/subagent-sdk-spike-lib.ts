import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	createAgentSession,
	getAgentDir,
	type AgentSession,
	type AgentSessionEvent,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	compileSystemPrompt,
	createPromptVariableStore,
} from "../src/compiler.ts";
import {
	hasAgentProfileErrors,
	loadAgentProfiles,
	resolveAgentProfile,
	type AgentProfileDiagnostic,
} from "../src/agent-profile.ts";
import {
	createForgeExtensionState,
	reloadForgeExtensions,
	unloadForgeExtensions,
} from "../src/forge-extensions.ts";
import { loadPromptStacks } from "../src/loader.ts";
import { applyResourcePolicy } from "../src/policy.ts";
import {
	compileProtectedAgentTaskMessages,
	isProtectedAgentTaskPreserved,
	resolveSubagentHostProfile,
} from "../src/subagent-host.ts";
import type { AgentProfileSnapshot } from "../src/subagent-contract.ts";
import type { LoadedPromptStack, PromptRuntime, PromptStackDiagnostic } from "../src/types.ts";

export const SPIKE_ACCESS_LEVELS = ["none", "read-only", "workspace-write"] as const;
export type SpikeAccessLevel = typeof SPIKE_ACCESS_LEVELS[number];

export interface SpikeCliOptions {
	cwd: string;
	profileId: string;
	task: string;
	access: SpikeAccessLevel;
	timeoutMs: number;
	execute: boolean;
	imagePaths: string[];
	loadForgeExtensions: boolean;
}

export interface SpikeToolPolicyResult {
	catalog: string[];
	stackSelected: string[];
	effective: string[];
	unmatchedAllowPatterns: string[];
	accessEnforceable: boolean;
	accessDiagnostic?: string;
}

export interface SpikeCompilationObservation {
	baseSystemPrompt?: string;
	compiledSystemPrompt?: string;
	preparedMessages?: AgentMessage[];
	systemDiagnostics: PromptStackDiagnostic[];
	messageDiagnostics: PromptStackDiagnostic[];
	exactRuntimeObserved: boolean;
}

export interface SpikeTraceEvent {
	type: string;
	at: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

export type SpikeTerminalStatus = "not-run" | "completed" | "failed" | "cancelled" | "timed-out";

export interface SubagentSdkSpikeReport {
	schemaVersion: 1;
	requestId: string;
	runId: string;
	mode: "dry-run" | "execute";
	request: {
		cwd: string;
		profileId: string;
		access: SpikeAccessLevel;
		remoteEgressConsent: boolean;
		timeoutMs: number;
		taskChars: number;
		images: Array<{ path: string; mimeType: string; bytes: number }>;
	};
	profile: {
		filePath: string;
		profileFingerprint: string;
		promptStackFingerprint: string | null;
		dependencies: AgentProfileSnapshot["dependencies"];
		model: { provider: string; id: string; supportsImages: boolean };
		thinkingLevel: string;
		promptStack: { id: string; filePath: string } | null;
		diagnostics: AgentProfileDiagnostic[];
	};
	backend: {
		id: "pi-sdk-0.80-spike";
		sdkSessionId: string;
		persisted: boolean;
		authConfigured: boolean;
		promptRuntimeFidelity: "partial-dry-run" | "exact-execute-hook";
		capabilities: {
			cancellation: true;
			timeoutViaHostAbort: true;
			mediaTransport: boolean;
			rootIsolation: false;
			writeIsolation: false;
			hardTurnLimit: false;
			hardTokenLimit: false;
		};
	};
	toolPolicy: SpikeToolPolicyResult;
	forgeExtensions: { trustedCodeLoaded: boolean; loadedPaths: string[]; diagnostics: PromptStackDiagnostic[] };
	compilation: {
		exactRuntimeObserved: boolean;
		baseSystemPromptChars: number;
		compiledSystemPromptChars: number;
		preparedMessageRoles: string[];
		protectedTaskPreserved: boolean;
		diagnostics: PromptStackDiagnostic[];
	};
	execution: {
		status: SpikeTerminalStatus;
		output?: string;
		error?: string;
		durationMs?: number;
		trace: SpikeTraceEvent[];
		stats?: ReturnType<AgentSession["getSessionStats"]>;
	};
}

const READ_ONLY_TOOLS = new Set(["read"]);

export function parseSpikeArgs(args: string[], defaults: { cwd?: string } = {}): SpikeCliOptions {
	const options: SpikeCliOptions = {
		cwd: resolve(defaults.cwd ?? process.cwd()),
		profileId: "default",
		task: "Reply with exactly: SPIKE_OK",
		access: "none",
		timeoutMs: 60_000,
		execute: false,
		imagePaths: [],
		loadForgeExtensions: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--execute") {
			options.execute = true;
			continue;
		}
		if (arg === "--load-forge-extensions") {
			options.loadForgeExtensions = true;
			continue;
		}
		if (arg === "--cwd") options.cwd = resolve(requiredValue(args, ++i, arg));
		else if (arg === "--profile") options.profileId = requiredValue(args, ++i, arg);
		else if (arg === "--task") options.task = requiredValue(args, ++i, arg);
		else if (arg === "--access") options.access = parseAccess(requiredValue(args, ++i, arg));
		else if (arg === "--timeout") options.timeoutMs = parsePositiveInteger(requiredValue(args, ++i, arg), arg);
		else if (arg === "--image") options.imagePaths.push(resolve(options.cwd, requiredValue(args, ++i, arg)));
		else throw new Error(`Unknown argument: ${arg}`);
	}

	if (!options.profileId.trim()) throw new Error("--profile must not be empty.");
	if (!options.task.trim()) throw new Error("--task must not be empty.");
	return options;
}

export function computeSpikeToolPolicy(
	catalogNames: readonly string[],
	stack: LoadedPromptStack | undefined,
	access: SpikeAccessLevel,
): SpikeToolPolicyResult {
	const catalog = [...new Set(catalogNames)].sort();
	const stackSelected = applyResourcePolicy(catalog, stack?.stack.tools).sort();
	const allowPatterns = stack?.stack.tools?.allow?.filter((pattern) => pattern !== "*") ?? [];
	const selectedSet = new Set(stackSelected);
	const effective = access === "none"
		? []
		: access === "read-only"
			? catalog.filter((name) => READ_ONLY_TOOLS.has(name) && selectedSet.has(name))
			: stackSelected;
	const accessEnforceable = access === "none";
	return {
		catalog,
		stackSelected,
		effective,
		unmatchedAllowPatterns: allowPatterns.filter((pattern) => !applyResourcePolicy(catalog, { allow: [pattern] }).length),
		accessEnforceable,
		accessDiagnostic: accessEnforceable
			? undefined
			: access === "read-only"
				? "Pi SDK can expose only read, but this spike cannot enforce allowed-root or symlink-safe read isolation."
				: "Pi SDK built-ins do not provide workspace-write root, process, or network isolation.",
	};
}

export async function runSubagentSdkSpike(options: SpikeCliOptions): Promise<SubagentSdkSpikeReport> {
	const startedAt = Date.now();
	const requestId = randomUUID();
	const runId = randomUUID();
	const profiles = loadAgentProfiles(options.cwd);
	const matches = profiles.filter((candidate) => candidate.profile.id === options.profileId);
	if (matches.length !== 1) {
		throw new Error(matches.length === 0
			? `Unknown profile: ${options.profileId}`
			: `Profile id ${options.profileId} is ambiguous (${matches.length} matches).`);
	}

	let stacks = loadPromptStacks(options.cwd);
	const agentDir = getAgentDir();
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	let prelim = resolveAgentProfile(matches[0]!, {
		models: modelRegistry.getAll(),
		availableModels: modelRegistry.getAvailable(),
		promptStacks: stacks,
	});
	if (!prelim.model || hasAgentProfileErrors(prelim.diagnostics)) {
		throw new Error(`Profile preflight failed:\n${formatProfileDiagnostics(prelim.diagnostics)}`);
	}

	const images = options.imagePaths.map(loadSpikeImage);
	if (images.length > 0 && !prelim.model.input.includes("image")) {
		throw new Error(`Model ${prelim.model.provider}/${prelim.model.id} does not support image input.`);
	}
	if (options.execute && options.access !== "none") {
		throw new Error(`Cannot execute access=${options.access}: the SDK spike cannot produce the required filesystem isolation receipt.`);
	}

	const forgeState = createForgeExtensionState();
	const forgeResult = options.loadForgeExtensions
		? await reloadForgeExtensions(options.cwd, forgeState)
		: { diagnostics: [] as PromptStackDiagnostic[], loadedPaths: [] as string[] };
	if (options.loadForgeExtensions) {
		// Stack validation depends on the trusted macro/slot registry. Resolve again
		// after registration so stale "unsupported slot" warnings do not survive.
		stacks = loadPromptStacks(options.cwd);
		prelim = resolveAgentProfile(matches[0]!, {
			models: modelRegistry.getAll(),
			availableModels: modelRegistry.getAvailable(),
			promptStacks: stacks,
		});
		if (!prelim.model || hasAgentProfileErrors(prelim.diagnostics)) {
			unloadForgeExtensions(forgeState);
			throw new Error(`Profile preflight failed after loading forge extensions:\n${formatProfileDiagnostics(prelim.diagnostics)}`);
		}
	}
	const hostResolution = resolveSubagentHostProfile(prelim.loaded, { promptStacks: stacks });
	if (!hostResolution.snapshot) {
		unloadForgeExtensions(forgeState);
		throw new Error(`Host profile resolution failed:\n${hostResolution.diagnostics.map((diagnostic) => `${diagnostic.level.toUpperCase()}: ${diagnostic.message}`).join("\n")}`);
	}
	const profileSnapshot = hostResolution.snapshot;
	const observation: SpikeCompilationObservation = {
		systemDiagnostics: [],
		messageDiagnostics: [],
		exactRuntimeObserved: false,
	};
	const trace: SpikeTraceEvent[] = [];
	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let terminalStatus: SpikeTerminalStatus = "not-run";
	let executionError: string | undefined;
	let output: string | undefined;
	let stats: ReturnType<AgentSession["getSessionStats"]> | undefined;
	const isolatedResources = mkdtempSync(join(tmpdir(), "pi-forge-sdk-spike-"));

	try {
		const settingsManager = SettingsManager.create(isolatedResources, isolatedResources);
		const resourceLoader = new DefaultResourceLoader({
			cwd: isolatedResources,
			agentDir: isolatedResources,
			settingsManager,
			extensionFactories: [{
				name: "pi-forge-subagent-spike",
				factory: createSpikeCompilerExtension(prelim.promptStack, observation),
			}],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd: options.access === "none" ? isolatedResources : options.cwd,
			agentDir,
			authStorage,
			modelRegistry,
			model: prelim.model,
			thinkingLevel: prelim.effectiveThinkingLevel,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(options.access === "none" ? isolatedResources : options.cwd),
		});
		session = created.session;
		const catalog = session.getAllTools().map((tool) => tool.name);
		const toolPolicy = computeSpikeToolPolicy(catalog, prelim.promptStack, options.access);
		session.setActiveToolsByName(toolPolicy.effective);

		if (!options.execute) {
			const dryRuntime = dryPromptRuntime(session, toolPolicy.effective, options.task);
			observation.baseSystemPrompt = session.systemPrompt;
			if (prelim.promptStack) {
				const system = compileSystemPrompt(prelim.promptStack.stack, dryRuntime, session.systemPrompt);
				observation.compiledSystemPrompt = system.systemPrompt;
				observation.systemDiagnostics = system.diagnostics;
				const task = createTaskMessage(options.task, images.map((image) => image.content));
				const prepared = compileProtectedAgentTaskMessages(prelim.promptStack, dryRuntime, [task]);
				observation.preparedMessages = prepared.messages;
				observation.messageDiagnostics = prepared.diagnostics;
			} else {
				observation.compiledSystemPrompt = session.systemPrompt;
				observation.preparedMessages = [createTaskMessage(options.task, images.map((image) => image.content))];
			}
			return createReport({
				options, requestId, runId, prelim, profileSnapshot, session, images, forgeResult, toolPolicy, observation,
				terminalStatus, trace, startedAt,
			});
		}

		unsubscribe = session.subscribe((event) => {
			const normalized = normalizeTraceEvent(event);
			if (normalized) trace.push(normalized);
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			void session?.abort();
		}, options.timeoutMs);
		try {
			await session.prompt(options.task, {
				images: images.map((image) => image.content),
				source: "extension",
			});
			await session.waitForIdle();
			terminalStatus = timedOut ? "timed-out" : assistantTerminalStatus(session.messages);
		} catch (error) {
			terminalStatus = timedOut ? "timed-out" : "failed";
			executionError = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timer);
		}
		output = session.getLastAssistantText();
		stats = session.getSessionStats();
		return createReport({
			options, requestId, runId, prelim, profileSnapshot, session, images, forgeResult, toolPolicy, observation,
			terminalStatus, executionError, output, stats, trace, startedAt,
		});
	} finally {
		unsubscribe?.();
		session?.dispose();
		unloadForgeExtensions(forgeState);
		rmSync(isolatedResources, { recursive: true, force: true });
	}
}

function createSpikeCompilerExtension(
	stack: LoadedPromptStack | undefined,
	observation: SpikeCompilationObservation,
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let rewritePending = false;
		let runtime: PromptRuntime | undefined;
		pi.on("before_agent_start", (event, ctx) => {
			observation.exactRuntimeObserved = true;
			observation.baseSystemPrompt = event.systemPrompt;
			runtime = {
				options: event.systemPromptOptions,
				ctx,
				latestUserMessage: event.prompt,
				now: new Date(),
				variables: createPromptVariableStore(),
			};
			rewritePending = true;
			if (!stack) {
				observation.compiledSystemPrompt = event.systemPrompt;
				return;
			}
			const result = compileSystemPrompt(stack.stack, runtime, event.systemPrompt);
			observation.compiledSystemPrompt = result.systemPrompt;
			observation.systemDiagnostics = result.diagnostics;
			return { systemPrompt: result.systemPrompt };
		});

		pi.on("context", (event) => {
			if (!rewritePending || !runtime) return;
			rewritePending = false;
			if (!stack) {
				observation.preparedMessages = structuredClone(event.messages);
				return;
			}
			const result = compileProtectedAgentTaskMessages(stack, runtime, event.messages);
			observation.preparedMessages = structuredClone(result.messages);
			observation.messageDiagnostics = result.diagnostics;
			return { messages: result.messages };
		});
	};
}

function createReport(input: {
	options: SpikeCliOptions;
	requestId: string;
	runId: string;
	prelim: ReturnType<typeof resolveAgentProfile>;
	profileSnapshot: AgentProfileSnapshot;
	session: AgentSession;
	images: LoadedSpikeImage[];
	forgeResult: { diagnostics: PromptStackDiagnostic[]; loadedPaths: string[] };
	toolPolicy: SpikeToolPolicyResult;
	observation: SpikeCompilationObservation;
	terminalStatus: SpikeTerminalStatus;
	executionError?: string;
	output?: string;
	stats?: ReturnType<AgentSession["getSessionStats"]>;
	trace: SpikeTraceEvent[];
	startedAt: number;
}): SubagentSdkSpikeReport {
	const task = createTaskMessage(input.options.task, input.images.map((image) => image.content));
	return {
		schemaVersion: 1,
		requestId: input.requestId,
		runId: input.runId,
		mode: input.options.execute ? "execute" : "dry-run",
		request: {
			cwd: input.options.cwd,
			profileId: input.options.profileId,
			access: input.options.access,
			remoteEgressConsent: input.options.execute,
			timeoutMs: input.options.timeoutMs,
			taskChars: input.options.task.length,
			images: input.images.map((image) => ({ path: image.path, mimeType: image.content.mimeType, bytes: image.bytes })),
		},
		profile: {
			filePath: input.prelim.loaded.filePath,
			profileFingerprint: input.profileSnapshot.profileFingerprint,
			promptStackFingerprint: input.profileSnapshot.promptStackFingerprint,
			dependencies: input.profileSnapshot.dependencies,
			model: {
				provider: input.prelim.model!.provider,
				id: input.prelim.model!.id,
				supportsImages: input.prelim.model!.input.includes("image"),
			},
			thinkingLevel: input.prelim.effectiveThinkingLevel,
			promptStack: input.prelim.promptStack
				? { id: input.prelim.promptStack.stack.id, filePath: input.prelim.promptStack.filePath }
				: null,
			diagnostics: input.prelim.diagnostics,
		},
		backend: {
			id: "pi-sdk-0.80-spike",
			sdkSessionId: input.session.sessionId,
			persisted: input.session.sessionFile !== undefined,
			authConfigured: true,
			promptRuntimeFidelity: input.observation.exactRuntimeObserved ? "exact-execute-hook" : "partial-dry-run",
			capabilities: {
				cancellation: true,
				timeoutViaHostAbort: true,
				mediaTransport: input.prelim.model!.input.includes("image"),
				rootIsolation: false,
				writeIsolation: false,
				hardTurnLimit: false,
				hardTokenLimit: false,
			},
		},
		toolPolicy: input.toolPolicy,
		forgeExtensions: {
			trustedCodeLoaded: input.options.loadForgeExtensions,
			loadedPaths: input.forgeResult.loadedPaths,
			diagnostics: input.forgeResult.diagnostics,
		},
		compilation: {
			exactRuntimeObserved: input.observation.exactRuntimeObserved,
			baseSystemPromptChars: input.observation.baseSystemPrompt?.length ?? 0,
			compiledSystemPromptChars: input.observation.compiledSystemPrompt?.length ?? 0,
			preparedMessageRoles: input.observation.preparedMessages?.map((message) => message.role) ?? [],
			protectedTaskPreserved: isProtectedAgentTaskPreserved(input.observation.preparedMessages ?? [], task),
			diagnostics: [...input.observation.systemDiagnostics, ...input.observation.messageDiagnostics],
		},
		execution: {
			status: input.terminalStatus,
			output: input.output,
			error: input.executionError,
			durationMs: input.options.execute ? Date.now() - input.startedAt : undefined,
			trace: input.trace,
			stats: input.stats,
		},
	};
}

function dryPromptRuntime(
	session: AgentSession,
	selectedTools: string[],
	latestUserMessage: string,
): PromptRuntime {
	const promptGuidelines = session.getAllTools()
		.filter((tool) => selectedTools.includes(tool.name))
		.flatMap((tool) => tool.promptGuidelines ?? []);
	const options: BuildSystemPromptOptions = {
		cwd: session.sessionManager.getCwd(),
		selectedTools,
		promptGuidelines,
		contextFiles: [],
		skills: [],
	};
	return {
		options,
		latestUserMessage,
		now: new Date(),
		variables: createPromptVariableStore(),
		ctx: undefined,
	};
}

interface LoadedSpikeImage {
	path: string;
	bytes: number;
	content: ImageContent;
}

function loadSpikeImage(path: string): LoadedSpikeImage {
	if (!existsSync(path)) throw new Error(`Image does not exist: ${path}`);
	const data = readFileSync(path);
	return {
		path,
		bytes: data.byteLength,
		content: { type: "image", data: data.toString("base64"), mimeType: imageMimeType(path) },
	};
}

function imageMimeType(path: string): string {
	const extension = extname(path).toLowerCase();
	if (extension === ".png") return "image/png";
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".webp") return "image/webp";
	if (extension === ".gif") return "image/gif";
	throw new Error(`Unsupported image type for ${path}; expected png, jpg, jpeg, webp, or gif.`);
}

function createTaskMessage(text: string, images: ImageContent[]): AgentMessage {
	return {
		role: "user",
		content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
		timestamp: 0,
	};
}

function normalizeTraceEvent(event: AgentSessionEvent): SpikeTraceEvent | undefined {
	if (![
		"agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
		"tool_execution_start", "tool_execution_end",
	].includes(event.type)) return undefined;
	const trace: SpikeTraceEvent = { type: event.type, at: new Date().toISOString() };
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		trace.toolCallId = event.toolCallId;
		trace.toolName = event.toolName;
	}
	if (event.type === "tool_execution_end") trace.isError = event.isError;
	return trace;
}

function assistantTerminalStatus(messages: readonly AgentMessage[]): SpikeTerminalStatus {
	const assistant = [...messages].reverse().find((message) => message.role === "assistant") as
		| { stopReason?: string; errorMessage?: string }
		| undefined;
	if (assistant?.stopReason === "aborted") return "cancelled";
	if (assistant?.stopReason === "error" || assistant?.errorMessage) return "failed";
	return "completed";
}

function requiredValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
	return value;
}

function parseAccess(value: string): SpikeAccessLevel {
	if ((SPIKE_ACCESS_LEVELS as readonly string[]).includes(value)) return value as SpikeAccessLevel;
	throw new Error(`--access must be one of: ${SPIKE_ACCESS_LEVELS.join(", ")}.`);
}

function parsePositiveInteger(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer in milliseconds.`);
	return parsed;
}

function formatProfileDiagnostics(diagnostics: readonly AgentProfileDiagnostic[]): string {
	return diagnostics.map((diagnostic) => `${diagnostic.level.toUpperCase()}: ${diagnostic.message}`).join("\n");
}
