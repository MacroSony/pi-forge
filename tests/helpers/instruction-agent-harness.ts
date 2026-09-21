import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSession,
	AgentSessionEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ContextEvent,
	ExtensionContext,
	ExtensionFactory,
	PromptOptions,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessage,
	StopReason,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import piForge from "../../src/index.ts";
import { GLOBAL_FORGE_CONFIG_PATH_ENV } from "../../src/forge-config.ts";
import { GLOBAL_FORGE_DIR_ENV } from "../../src/storage.ts";

// Install fetch guard before any SDK operation can execute.
let blockedFetchCount = 0;
const harnessFetchGuard: typeof globalThis.fetch = async (...args: any[]) => {
	blockedFetchCount++;
	const target = args[0] ? String(args[0]) : "unknown target";
	throw new Error(`network blocked by instruction-agent-harness (fetch #${blockedFetchCount}): ${target}`);
};

if (globalThis.fetch !== harnessFetchGuard) {
	globalThis.fetch = harnessFetchGuard;
}

export const BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"powershell",
]);

export const DEFAULT_INITIAL_TOOLS = ["fake_write", "fake_read", "fake_driver"];

export interface FakeToolCallSpec {
	name?: string;
	id?: string;
	args?: Record<string, any>;
	arguments?: Record<string, any>;
}

export interface ScriptedResponseObject {
	text?: string;
	toolCalls?: (string | FakeToolCallSpec)[];
	stopReason?: StopReason;
	errorMessage?: string;
	responseId?: string;
	message?: unknown;
}

export type ScriptedResponseCallback = (ctx: {
	context: TranscriptContext;
	providerOptions: unknown;
	state: unknown;
	model: unknown;
	callIndex: number;
}) => unknown | Promise<unknown>;

export type ScriptedResponse =
	| string
	| ScriptedResponseObject
	| AssistantMessage
	| ScriptedResponseCallback;

export interface FakeToolExecution {
	name: string;
	toolCallId: string;
	params: unknown;
	ctx?: ExtensionContext;
	driverResult?: unknown;
}

export interface InstructionAgentHarnessObserver {
	beforeAgentStart?: (event: BeforeAgentStartEvent) => void;
	beforeAgentStartResult?: (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | void | undefined;
	context?: (event: ContextEvent) => void;
	stream?: (context: TranscriptContext, details: unknown) => void;
	tool?: (execution: FakeToolExecution) => void;
	event?: (event: AgentSessionEvent) => void;
}

export interface InstructionAgentHarnessOptions {
	cwd: string;
	responses?: ScriptedResponse[];
	extensionFactories?: ExtensionFactory[];
	/** Public extensions that must observe/rewrite context before Forge's handlers. */
	beforeForgeExtensionFactories?: ExtensionFactory[];
	sessionManager?: SessionManager;
	initialTools?: string[];
	/** Registered tool names; defaults to the original fake-tool registry. */
	allowedTools?: string[];
	native?: boolean;
	agentDir?: string;
	onDriver?: (ctx: ExtensionContext) => unknown | Promise<unknown>;
	observer?: InstructionAgentHarnessObserver;
}

export interface InstructionAgentHarness {
	readonly session: AgentSession;
	readonly manager: SessionManager;
	readonly sessionManager: SessionManager;
	readonly streamContexts: TranscriptContext[];
	readonly provider: any;
	readonly fetchAttempts: number;
	readonly fetchCount: number;
	readonly toolExecutions: FakeToolExecution[];
	readonly beforeAgentStartEvents: unknown[];
	readonly contextEvents: unknown[];
	readonly observedEvents: AgentSessionEvent[];
	readonly settingsManager: any;
	readonly modelRuntime: any;
	readonly authStorage: any;
	readonly extensionsResult: any;
	setResponses(responses: ScriptedResponse[]): void;
	setOnDriver(fn: (ctx: ExtensionContext) => unknown | Promise<unknown>): void;
	builtinToolsActive(): string[];
	getActiveToolNames(): string[];
	prompt(text: string, promptOptions?: PromptOptions): Promise<void>;
	dispose(): Promise<void>;
}

let sdkPromise: Promise<{
	SDK: typeof import("@earendil-works/pi-coding-agent");
	AI: typeof import("@earendil-works/pi-ai");
}> | null = null;

async function loadSdk() {
	if (!sdkPromise) {
		globalThis.fetch = harnessFetchGuard;
		sdkPromise = Promise.all([
			import("@earendil-works/pi-coding-agent"),
			import("@earendil-works/pi-ai"),
		]).then(([SDK, AI]) => ({ SDK, AI }));
	}
	return sdkPromise;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as any).role === "assistant" &&
		Array.isArray((value as any).content)
	);
}

function messageFromSpec(AI: typeof import("@earendil-works/pi-ai"), spec: unknown): AssistantMessage {
	if (isAssistantMessage(spec)) return spec;
	if (typeof spec === "string") return AI.fauxAssistantMessage(spec);
	if (!spec || typeof spec !== "object") {
		throw new TypeError("A scripted response must be text, an assistant message, or {text, toolCalls}");
	}
	if ((spec as any).message) return messageFromSpec(AI, (spec as any).message);

	const obj = spec as ScriptedResponseObject;
	if (Array.isArray(obj.toolCalls) || "text" in obj) {
		const blocks: any[] = [];
		if (obj.text !== undefined && obj.text !== null) {
			blocks.push(AI.fauxText(String(obj.text)));
		}
		for (const [index, call] of (obj.toolCalls ?? []).entries()) {
			const callName = typeof call === "string" ? call : (call.name ?? "unnamed_tool");
			const callArgs: Record<string, any> = typeof call === "string" ? {} : (call.arguments ?? call.args ?? {});
			const callId = typeof call === "string" ? `harness-call-${index + 1}` : (call.id ?? `harness-call-${index + 1}`);
			blocks.push(AI.fauxToolCall(callName, callArgs, { id: callId }));
		}
		const stopReason = (obj.toolCalls?.length ?? 0) > 0 ? "toolUse" : (obj.stopReason ?? "stop");
		return AI.fauxAssistantMessage(blocks.length ? blocks : "", {
			stopReason,
			errorMessage: obj.errorMessage,
			responseId: obj.responseId,
		});
	}
	throw new TypeError("Unknown scripted response shape");
}

/**
 * Create a real coding-agent AgentSession with Forge and fake tools,
 * hermetic configuration, and faux provider models.
 */
export async function createInstructionAgentHarness(
	options: InstructionAgentHarnessOptions,
): Promise<InstructionAgentHarness> {
	if (!options || typeof options.cwd !== "string" || options.cwd.length === 0) {
		throw new TypeError("options.cwd is required");
	}
	const cwd = options.cwd;

	const initialTools = [...(options.initialTools ?? DEFAULT_INITIAL_TOOLS)];
	if (!Array.isArray(initialTools) || initialTools.some((name) => typeof name !== "string")) {
		throw new TypeError("initialTools must be an array of tool names");
	}
	const builtinFound = initialTools.filter((name) => BUILTIN_TOOLS.has(name));
	if (builtinFound.length > 0) {
		throw new Error(
			`initialTools may contain only custom fake tool names; builtin rejected: ${builtinFound.join(", ")}`,
		);
	}

	let createdGlobalForgeDir: string | undefined;
	const originalGlobalForgeDirEnv = process.env[GLOBAL_FORGE_DIR_ENV];
	const originalGlobalForgeConfigEnv = process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
	{ // Always isolate inherited Forge config; never read the invoking user's library.
		createdGlobalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-harness-global-"));
		process.env[GLOBAL_FORGE_DIR_ENV] = createdGlobalForgeDir;
		process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = join(createdGlobalForgeDir, "config.json");
	}

	let createdAgentDir: string | undefined;
	let agentDir = options.agentDir;
	if (!agentDir) {
		createdAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-harness-agent-"));
		agentDir = createdAgentDir;
	}

	const fetchCountAtCreate = blockedFetchCount;
	const { SDK, AI } = await loadSdk();

	const isNative = options.native === true;
	const modelCompat = { supportsMidConvoSystemMessages: isNative };

	const provider = AI.fauxProvider({
		provider: "pi-086-harness-fake",
		api: "pi-086-harness-faux",
		models: [
			{
				id: "fake-model",
				name: "Harness Fake Model",
				reasoning: false,
			},
		],
	});

	const model = provider.getModel();
	(model as any).compat = modelCompat;
	for (const m of provider.provider.getModels()) {
		(m as any).compat = modelCompat;
	}

	const streamContexts: TranscriptContext[] = [];
	const beforeAgentStartEvents: unknown[] = [];
	const contextEvents: unknown[] = [];
	const toolExecutions: FakeToolExecution[] = [];
	const observedEvents: AgentSessionEvent[] = [];
	const responseScripts: ScriptedResponse[] = [];
	let currentOnDriver = options.onDriver;

	const setResponses = (responses: ScriptedResponse[]) => {
		responseScripts.length = 0;
		responseScripts.push(...responses);
		provider.setResponses(
			responseScripts.map((script) => async (context: any, providerOptions: any, state: any, m: any) => {
				const callIndex = streamContexts.length;
				streamContexts.push(structuredClone(context));
				options.observer?.stream?.(context, { callIndex, providerOptions, state, model: m });
				const result =
					typeof script === "function"
						? await (script as any)({ context, providerOptions, state, model: m, callIndex })
						: script;
				return messageFromSpec(AI, result);
			}),
		);
	};

	const observerFactory: ExtensionFactory = (pi) => {
		pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
			beforeAgentStartEvents.push(event);
			options.observer?.beforeAgentStart?.(event);
			return options.observer?.beforeAgentStartResult?.(event) ?? undefined;
		});
		pi.on("context", async (event: ContextEvent) => {
			contextEvents.push(event);
			options.observer?.context?.(event);
		});
	};

	const fakeToolsFactory: ExtensionFactory = (pi) => {
		pi.registerTool({
			name: "fake_write",
			label: "Fake Write Tool",
			description: "A side-effect-free fake write tool for harness testing.",
			promptSnippet: "Use only for isolated harness tests",
			parameters: AI.Type.Object(
				{
					path: AI.Type.Optional(AI.Type.String()),
					content: AI.Type.Optional(AI.Type.String()),
				},
				{ additionalProperties: true },
			),
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				const execution: FakeToolExecution = {
					name: "fake_write",
					toolCallId,
					params,
					ctx,
				};
				toolExecutions.push(execution);
				options.observer?.tool?.(execution);
				return {
					content: [{ type: "text", text: "fake_write completed" }],
					details: { harness: true, toolName: "fake_write", params },
				};
			},
		});

		pi.registerTool({
			name: "fake_read",
			label: "Fake Read Tool",
			description: "A side-effect-free fake read tool for harness testing.",
			promptSnippet: "Use only for isolated harness tests",
			parameters: AI.Type.Object(
				{
					path: AI.Type.Optional(AI.Type.String()),
				},
				{ additionalProperties: true },
			),
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				const execution: FakeToolExecution = {
					name: "fake_read",
					toolCallId,
					params,
					ctx,
				};
				toolExecutions.push(execution);
				options.observer?.tool?.(execution);
				return {
					content: [{ type: "text", text: "fake_read completed" }],
					details: { harness: true, toolName: "fake_read", params },
				};
			},
		});

		pi.registerTool({
			name: "fake_driver",
			label: "Fake Driver Tool",
			description: "A driver tool to trigger commands midrun in harness tests.",
			promptSnippet: "Use only for isolated harness tests",
			parameters: AI.Type.Object({}, { additionalProperties: true }),
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				let driverResult: unknown;
				if (currentOnDriver) {
					driverResult = await currentOnDriver(ctx);
				}
				const execution: FakeToolExecution = {
					name: "fake_driver",
					toolCallId,
					params,
					ctx,
					driverResult,
				};
				toolExecutions.push(execution);
				options.observer?.tool?.(execution);
				return {
					content: [
						{
							type: "text",
							text: `fake_driver completed${driverResult !== undefined ? `: ${JSON.stringify(driverResult)}` : ""}`,
						},
					],
					details: { harness: true, toolName: "fake_driver", params, driverResult },
				};
			},
		});
	};

	const providerFactory: ExtensionFactory = (pi) => pi.registerProvider(provider.provider);
	const forgeFactory: ExtensionFactory = (pi) => piForge(pi);

	const settingsManager = SDK.SettingsManager.inMemory(
		{
			defaultProvider: provider.provider.id,
			defaultModel: "fake-model",
			defaultTools: [],
			retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
			compaction: { enabled: false },
			cacheWarming: "off",
		},
		{ projectTrusted: true },
	);

	const authStorage = new AI.InMemoryCredentialStore();
	const modelRuntime = await SDK.ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});

	const resourceLoader = new SDK.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			providerFactory,
			...(options.beforeForgeExtensionFactories ?? []),
			forgeFactory,
			fakeToolsFactory,
			observerFactory,
			...(options.extensionFactories ?? []),
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});

	await resourceLoader.reload();
	const sessionManager = options.sessionManager ?? SDK.SessionManager.inMemory(cwd);

	const { session, extensionsResult } = await SDK.createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: provider.getModel(),
		thinkingLevel: "off",
		noTools: "builtin",
		// Allowed registry != initial active selection. Restore must be able to
		// reactivate registered fake tools that a mode previously hid.
		tools: options.allowedTools ?? DEFAULT_INITIAL_TOOLS,
		resourceLoader,
		settingsManager,
		sessionManager,
	});

	session.setActiveToolsByName(initialTools);
	await session.bindExtensions({ mode: "print" });

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		observedEvents.push(event);
		options.observer?.event?.(event);
	});

	setResponses(options.responses ?? []);

	return {
		session,
		manager: sessionManager,
		sessionManager,
		streamContexts,
		provider,
		toolExecutions,
		beforeAgentStartEvents,
		contextEvents,
		observedEvents,
		settingsManager,
		modelRuntime,
		authStorage,
		extensionsResult,
		get fetchAttempts() {
			return blockedFetchCount - fetchCountAtCreate;
		},
		get fetchCount() {
			return blockedFetchCount - fetchCountAtCreate;
		},
		setResponses,
		setOnDriver(fn: (ctx: ExtensionContext) => unknown | Promise<unknown>) {
			currentOnDriver = fn;
		},
		builtinToolsActive: () => session.getActiveToolNames().filter((name) => BUILTIN_TOOLS.has(name)),
		getActiveToolNames: () => session.getActiveToolNames(),
		prompt: async (text: string, promptOptions?: PromptOptions) => {
			return session.prompt(text, promptOptions);
		},
		dispose: async () => {
			unsubscribe();
			session.dispose();
			if (createdAgentDir) {
				try {
					rmSync(createdAgentDir, { recursive: true, force: true });
				} catch {}
			}
			if (createdGlobalForgeDir) {
				try {
					rmSync(createdGlobalForgeDir, { recursive: true, force: true });
				} catch {}
				if (originalGlobalForgeDirEnv === undefined) {
					delete process.env[GLOBAL_FORGE_DIR_ENV];
				} else {
					process.env[GLOBAL_FORGE_DIR_ENV] = originalGlobalForgeDirEnv;
				}
				if (originalGlobalForgeConfigEnv === undefined) {
					delete process.env[GLOBAL_FORGE_CONFIG_PATH_ENV];
				} else {
					process.env[GLOBAL_FORGE_CONFIG_PATH_ENV] = originalGlobalForgeConfigEnv;
				}
			}
		},
	};
}

export const getBlockedFetchCount = () => blockedFetchCount;
