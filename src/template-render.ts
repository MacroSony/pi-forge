import { forgeV1, FORGE_V1_MAX_EXTENSION_OUTPUT } from "./forge-v1/index.ts";
import type {
	ForgeV1Error,
	PromptEnvironment,
	PromptEnvironmentValue,
	TemplateDependency,
} from "./forge-v1/types.ts";
import { createMacroRenderContext, getRegisteredMacro } from "./macro-engine.ts";
import { selectedToolNames } from "./render-helpers.ts";
import type {
	PromptRuntime,
	PromptStack,
	PromptStackDiagnostic,
} from "./types.ts";

export class ForgeTemplateRenderer {
	private readonly base: PromptEnvironment;
	private readonly extensions = new Map<string, string>();
	private readonly workingExtensions: Record<string, string> = {};
	private readonly resolving = new Set<string>();
	private readonly stack: PromptStack;

	constructor(stack: PromptStack, runtime: PromptRuntime) {
		this.stack = stack;
		this.base = buildPromptEnvironment(stack, runtime);
	}

	render(text: string, diagnostics: PromptStackDiagnostic[], itemId?: string): string {
		const parsed = forgeV1.parse(text);
		if (!parsed.ok) {
			diagnostics.push({
				level: "error",
				message: `forge-v1 parse error: ${parsed.error.message}`,
				itemId,
			});
			return "";
		}
		const analyzed = forgeV1.analyze(parsed.ast);
		if (analyzed.errors.length > 0) {
			for (const error of analyzed.errors) {
				diagnostics.push({ level: "error", message: error.message, itemId });
			}
			return "";
		}

		try {
			const env = freezeEnvironment({
				runtime: this.base.runtime,
				parameters: this.base.parameters,
				extensions: { ...this.workingExtensions },
			});
			const result = forgeV1.render(parsed.ast, env, {
				resolveExtension: (name) => this.resolveExtensionForRender(name, diagnostics, itemId),
			});
			if (!result.ok) {
				diagnostics.push({
					level: "error",
					message: `forge-v1 render error: ${result.error.message}`,
					itemId,
				});
				return "";
			}
			return result.text;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			diagnostics.push({ level: "error", message: `forge-v1 compile error: ${detail}`, itemId });
			return "";
		}
	}

	environment(): PromptEnvironment {
		return freezeEnvironment({
			runtime: this.base.runtime,
			parameters: this.base.parameters,
			extensions: { ...this.workingExtensions },
		});
	}

	environmentForDependencies(
		dependencies: readonly string[],
		diagnostics: PromptStackDiagnostic[],
		itemId?: string,
	): PromptEnvironment {
		for (const dependency of dependencies) {
			const name = parseExtensionDependency(dependency);
			if (!name) continue;
			try {
				this.resolveExtensionForRender(name, diagnostics, itemId);
			} catch (error) {
				const message = error && typeof error === "object" && "message" in error
					? String((error as { message: unknown }).message)
					: String(error);
				diagnostics.push({ level: "error", message, itemId });
			}
		}
		return this.environment();
	}

	setLatestUserMessage(message: string): void {
		if (this.base.runtime.lastUserMessage === message) return;
		this.base.runtime.lastUserMessage = message;
		// The extension cache is keyed by name and serves values resolved against a
		// frozen environment snapshot. latestUserMessage is the one captured field
		// that can legitimately change between the system and message phases of a
		// single compilation, so invalidate the cache so macros that read it observe
		// the current value instead of the pre-phase snapshot.
		this.extensions.clear();
		for (const key of Object.keys(this.workingExtensions)) delete this.workingExtensions[key];
	}

	private resolveExtensionForRender(
		name: string,
		diagnostics: PromptStackDiagnostic[],
		itemId: string | undefined,
	): string | undefined {
		const cached = this.extensions.get(name);
		if (cached !== undefined) return cached;

		if (this.resolving.has(name)) {
			const forgeError: ForgeV1Error = {
				kind: "evaluate",
				message: `forge-v1 extension cycle detected at: ${name}`,
			};
			throw forgeError;
		}
		if (this.resolving.size >= 32) {
			const forgeError: ForgeV1Error = {
				kind: "evaluate",
				message: "forge-v1 extension dependency graph is too deep.",
			};
			throw forgeError;
		}

		const definition = getRegisteredMacro(name);
		if (!definition) return undefined;

		this.resolving.add(name);
		try {
			// Resolve declared extension dependencies first so the macro's frozen env
			// contains the dependency snapshot it declared.
			if (definition.dependencies) {
				for (const dependency of definition.dependencies) {
					const depName = parseExtensionDependency(dependency);
					if (depName) this.resolveExtensionForRender(depName, diagnostics, itemId);
				}
			}

			const env = freezeEnvironment({
				runtime: this.base.runtime,
				parameters: this.base.parameters,
				extensions: { ...this.workingExtensions },
			});
			let value: string;
			try {
				value = definition.render(createMacroRenderContext(env));
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				throw {
					kind: "evaluate",
					message: `forge-v1 extension ${name} failed: ${detail}`,
				} as ForgeV1Error;
			}

			if (value.length > FORGE_V1_MAX_EXTENSION_OUTPUT) {
				const forgeError: ForgeV1Error = {
					kind: "extension-limit",
					message: `forge-v1 extension ${name} exceeds ${FORGE_V1_MAX_EXTENSION_OUTPUT} characters.`,
				};
				throw forgeError;
			}

			this.extensions.set(name, value);
			this.workingExtensions[name] = value;
			return value;
		} finally {
			this.resolving.delete(name);
		}
	}
}

export function buildPromptEnvironment(stack: PromptStack, runtime: PromptRuntime): PromptEnvironment {
	const tools = selectedToolNames(stack, runtime);
	const toolBooleans: Record<string, boolean> = {};
	for (const name of tools) toolBooleans[name] = true;
	const slotBooleans: Record<string, boolean> = {};
	for (const item of stack.items) {
		if (item.kind === "slot" && item.enabled !== false && item.slot) slotBooleans[item.slot] = true;
	}

	const params: Record<string, PromptEnvironmentValue> = {};
	if (stack.schemaVersion === 2) {
		Object.assign(params, stack.parameters ?? {});
	} else {
		for (const [key, value] of Object.entries(stack.variables ?? {})) params[key] = value;
	}

	const model = runtime.model;
	const env: PromptEnvironment = {
		runtime: {
			cwd: runtime.options.cwd,
			date: formatDate(runtime.now),
			time: formatTime(runtime.now),
			lastUserMessage: runtime.latestUserMessage ?? "",
			selectedTools: tools,
			selectedToolsText: tools.join(", "),
			activeModel: model ? `${model.provider}/${model.id}` : "",
			populatedAt: runtime.now.toISOString(),
			timezone: "local",
			tool: toolBooleans,
			slot: slotBooleans,
		},
		parameters: params,
		extensions: {},
	};
	return env;
}

export function freezeEnvironment(environment: PromptEnvironment): PromptEnvironment {
	const clone = structuredClone(environment);
	const freeze = (value: unknown): unknown => {
		if (value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) {
			value.forEach((item) => freeze(item));
			return Object.freeze(value);
		}
		const record = value as Record<string, unknown>;
		for (const key of Object.keys(record)) record[key] = freeze(record[key]);
		return Object.freeze(record);
	};
	freeze(clone);
	return clone;
}

function parseExtensionDependency(dependency: string): string | undefined {
	const trimmed = dependency.trim();
	if (trimmed.startsWith("extensions.")) {
		const name = trimmed.slice("extensions.".length).trim();
		return name && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : undefined;
	}
	return undefined;
}

function formatDate(now: Date): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function formatTime(now: Date): string {
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${hours}:${minutes}:${seconds}`;
}
