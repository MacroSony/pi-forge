import { forgeV1, FORGE_V1_MAX_EXTENSION_OUTPUT } from "./forge-v1/index.ts";
import type {
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

const LEGACY_RUNTIME_FIELDS = new Set([
	"cwd", "date", "time", "lastUserMessage", "selectedTools", "tools", "activeModel",
]);

export class ForgeTemplateRenderer {
	private readonly base: PromptEnvironment;
	private readonly extensions = new Map<string, string>();
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
			const before = diagnostics.length;
			const env = this.resolveExtensions(parsed.ast, analyzed.dependencies, diagnostics, itemId);
			if (diagnostics.length > before) return "";

			const result = forgeV1.render(parsed.ast, env);
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
		return this.resolveExtensions([], [], [], undefined);
	}

	private resolveExtensions(
		_nodes: unknown,
		dependencies: TemplateDependency[],
		diagnostics: PromptStackDiagnostic[],
		itemId: string | undefined,
	): PromptEnvironment {
		const direct = new Set<string>();
		for (const dependency of dependencies) {
			if (dependency.kind === "extensions") {
				direct.add(dependency.path?.[1] ?? "");
			} else if (dependency.kind === "legacy") {
				const name = dependency.path?.[0];
				if (!name) continue;
				if (LEGACY_RUNTIME_FIELDS.has(name)) continue;
				if (Object.prototype.hasOwnProperty.call(this.base.parameters, name)) continue;
				// Only attempt extension resolution when a macro is actually registered;
				// otherwise the renderer reports a strict undefined path.
				if (getRegisteredMacro(name)) direct.add(name);
			}
		}

		const names = this.expandExtensionNames(direct, diagnostics, itemId);

		const workingExtensions: Record<string, string> = {};
		const visited = new Set<string>();
		for (const name of names) {
			if (!name) continue;
			const value = this.resolveExtensionValue(name, workingExtensions, visited, diagnostics, itemId);
			if (value !== undefined) workingExtensions[name] = value;
		}

		return freezeEnvironment({
			runtime: this.base.runtime,
			parameters: this.base.parameters,
			extensions: workingExtensions,
		});
	}

	private expandExtensionNames(
		initial: ReadonlySet<string>,
		diagnostics: PromptStackDiagnostic[],
		itemId: string | undefined,
	): string[] {
		const ordered: string[] = [];
		const seen = new Set<string>();
		const path = new Set<string>();
		const visit = (name: string): void => {
			if (seen.has(name)) return;
			if (path.has(name)) {
				diagnostics.push({ level: "error", message: `forge-v1 extension cycle detected at: ${name}`, itemId });
				return;
			}
			if (path.size >= 32) {
				diagnostics.push({ level: "error", message: "forge-v1 extension dependency graph is too deep.", itemId });
				return;
			}
			const definition = getRegisteredMacro(name);
			path.add(name);
			if (definition?.dependencies) {
				for (const dependency of definition.dependencies) {
					const depName = parseExtensionDependency(dependency);
					if (depName) visit(depName);
				}
			}
			path.delete(name);
			seen.add(name);
			ordered.push(name);
		};
		for (const name of initial) visit(name);
		return ordered;
	}

	private resolveExtensionValue(
		name: string,
		working: Record<string, string>,
		visited: Set<string>,
		diagnostics: PromptStackDiagnostic[],
		itemId: string | undefined,
	): string | undefined {
		const cached = this.extensions.get(name);
		if (cached !== undefined) return cached;
		if (visited.has(name)) {
			diagnostics.push({ level: "error", message: `forge-v1 extension cycle detected at: ${name}`, itemId });
			return undefined;
		}
		const definition = getRegisteredMacro(name);
		if (!definition) {
			diagnostics.push({ level: "error", message: `Unknown forge-v1 extension: ${name}`, itemId });
			return undefined;
		}

		visited.add(name);
		const env = freezeEnvironment({
			runtime: this.base.runtime,
			parameters: this.base.parameters,
			extensions: { ...working, ...Object.fromEntries(this.extensions) },
		});
		let value: string;
		try {
			value = definition.render(createMacroRenderContext(env));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				level: "error",
				message: `forge-v1 extension ${name} failed: ${detail}`,
				itemId,
			});
			visited.delete(name);
			return undefined;
		}
		visited.delete(name);

		if (value.length > FORGE_V1_MAX_EXTENSION_OUTPUT) {
			diagnostics.push({
				level: "error",
				message: `forge-v1 extension ${name} exceeds ${FORGE_V1_MAX_EXTENSION_OUTPUT} characters.`,
				itemId,
			});
			return undefined;
		}

		this.extensions.set(name, value);
		working[name] = value;
		return value;
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

	const model = runtime.ctx?.model;
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

function parseExtensionDependency(dependency: string): string | undefined {
	const trimmed = dependency.trim();
	if (trimmed.startsWith("extensions.")) {
		const name = trimmed.slice("extensions.".length).trim();
		return name && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ? name : undefined;
	}
	return undefined;
}
