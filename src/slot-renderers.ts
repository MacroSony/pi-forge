import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyResourcePolicy } from "./policy.ts";
import type {
	PromptRuntime,
	PromptStack,
	PromptStackDiagnostic,
	PromptStackSlot,
	PromptStackSlotFormat,
	PromptStackSlotItem,
	PromptVariableValue,
} from "./types.ts";

type PromptVariableScope = "static" | "session" | "turn";

interface SlotRenderContext {
	item: PromptStackSlotItem;
	stack: PromptStack;
	runtime: PromptRuntime;
	diagnostics: PromptStackDiagnostic[];
}

type SlotRenderer = (context: SlotRenderContext) => string;

const SLOT_RENDERERS = new Map<PromptStackSlot, SlotRenderer>();

registerSlot("chat-history", () => "");
registerSlot("tools", ({ item, stack, runtime }) => renderTools(item, stack, runtime));
registerSlot("tool-guidelines", ({ item, stack, runtime }) => renderToolGuidelines(item, stack, runtime));
registerSlot("skills", ({ item, stack, runtime }) => renderSkills(item, stack, runtime));
registerSlot("project-context", ({ item, runtime }) => renderProjectContext(item, runtime));
registerSlot("append-system-prompt", ({ runtime }) => runtime.options.appendSystemPrompt ?? "");
registerSlot("date", ({ item, runtime }) => renderDate(item, runtime));
registerSlot("cwd", ({ runtime }) => renderCwd(runtime));
registerSlot("date-cwd", ({ item, runtime }) => [renderDate(item, runtime), renderCwd(runtime)].join("\n"));
registerSlot("active-model", ({ runtime }) => renderActiveModel(runtime));
registerSlot("pi-docs", () => renderPiDocsGuidance());
registerSlot("variables", ({ item, stack, runtime }) => renderVariables(item, stack, runtime));

export const SUPPORTED_SLOTS = new Set<PromptStackSlot>(SLOT_RENDERERS.keys());

export function renderSlotText(
	item: PromptStackSlotItem,
	stack: PromptStack,
	runtime: PromptRuntime,
	diagnostics: PromptStackDiagnostic[],
): string {
	const renderer = SLOT_RENDERERS.get(item.slot as PromptStackSlot);
	if (!renderer) {
		diagnostics.push({ level: "warning", message: `Unsupported slot: ${item.slot}`, itemId: item.id });
		return "";
	}

	return renderer({ item, stack, runtime, diagnostics });
}

function registerSlot(name: PromptStackSlot, renderer: SlotRenderer): void {
	SLOT_RENDERERS.set(name, renderer);
}

function renderTools(item: PromptStackSlotItem, stack: PromptStack, runtime: PromptRuntime): string {
	const snippets = runtime.options.toolSnippets ?? {};
	const tools = item.options?.onlyWithSnippets === true
		? scopedToolNames(stack, runtime).filter((name) => !!snippets[name])
		: scopedToolNames(stack, runtime);

	if (slotTextFormat(item) === "plain") {
		const lines = ["Available tools:"];
		if (tools.length === 0) {
			lines.push(item.options?.onlyWithSnippets === true ? "(none)" : "- (none)");
		} else {
			for (const name of tools) {
				lines.push(plainBullet(name, snippets[name] ?? "No prompt snippet provided."));
			}
		}
		return lines.join("\n");
	}

	const lines = ["<available_tools>"];

	if (tools.length === 0) {
		lines.push("  (none)");
	} else {
		for (const name of tools) {
			const snippet = snippets[name] ?? "No prompt snippet provided.";
			lines.push(`  <tool name=\"${escapeXml(name)}\">${escapeXml(snippet)}</tool>`);
		}
	}

	lines.push("</available_tools>");
	return lines.join("\n");
}

function renderToolGuidelines(item: PromptStackSlotItem, stack: PromptStack, runtime: PromptRuntime): string {
	const tools = scopedToolNames(stack, runtime);
	const guidelines: string[] = [];
	const seen = new Set<string>();
	const add = (line: string) => {
		const normalized = line.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		guidelines.push(normalized);
	};

	if (tools.includes("bash") && !tools.includes("grep") && !tools.includes("find") && !tools.includes("ls")) {
		add(item.options?.piStyle === true ? "Use bash for file operations like ls, rg, find" : "Use bash for file operations like ls, rg, find.");
	}

	for (const guideline of runtime.options.promptGuidelines ?? []) add(guideline);
	if (item.options?.includePiDefaultGuidelines === true) {
		add("Be concise in your responses");
		add("Show file paths clearly when working with files");
	}

	if (guidelines.length === 0) return "";
	if (slotTextFormat(item) === "plain") {
		const heading = typeof item.options?.heading === "string" ? item.options.heading.trim() : "Tool guidelines:";
		return [
			...(heading ? [heading] : []),
			...guidelines.map((line) => `- ${plainContinuation(line, "  ")}`),
		].join("\n");
	}
	return ["<tool_guidelines>", ...guidelines.map((line) => `- ${line}`), "</tool_guidelines>"].join("\n");
}

function renderSkills(item: PromptStackSlotItem, stack: PromptStack, runtime: PromptRuntime): string {
	if (item.options?.requireReadTool === true && !scopedToolNames(stack, runtime).includes("read")) return "";
	const skills = (runtime.options.skills ?? [])
		.filter((skill) => !skill.disableModelInvocation)
		.filter((skill) => applyResourcePolicy([skill.name], stack.skills).length > 0);
	if (skills.length === 0) return "";

	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
	];

	if (slotTextFormat(item) === "plain") {
		lines.push("Available skills:");
		for (const skill of skills) {
			lines.push(plainBullet(skill.name, skill.description));
			lines.push(`  Location: ${plainContinuation(skill.filePath, "  ")}`);
		}
		return lines.join("\n");
	}

	lines.push("<available_skills>");
	for (const skill of skills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return lines.join("\n");
}

function scopedToolNames(stack: PromptStack, runtime: PromptRuntime): string[] {
	return applyResourcePolicy(runtime.options.selectedTools ?? [], stack.tools);
}

function renderProjectContext(item: PromptStackSlotItem, runtime: PromptRuntime): string {
	const contextFiles = runtime.options.contextFiles ?? [];
	if (contextFiles.length === 0) return "";

	if (slotTextFormat(item) === "plain") {
		const lines = ["Project context:", "", "Project-specific instructions and guidelines:", ""];
		for (const file of contextFiles) {
			lines.push(`Path: ${file.path}`);
			lines.push(indentPlainBlock(file.content, "  "), "");
		}
		return lines.join("\n").trimEnd();
	}

	const lines = ["<project_context>", "", "Project-specific instructions and guidelines:", ""];
	for (const file of contextFiles) {
		lines.push(`<project_instructions path=\"${escapeXml(file.path)}\">`);
		lines.push(file.content);
		lines.push("</project_instructions>", "");
	}
	lines.push("</project_context>");
	return lines.join("\n");
}

function renderDate(item: PromptStackSlotItem, runtime: PromptRuntime): string {
	const lines = [`Current date: ${formatDate(runtime.now)}`];
	if (item.options?.includeTime === true) {
		lines.push(`Current time: ${formatTime(runtime.now)}`);
	}
	return lines.join("\n");
}

function renderCwd(runtime: PromptRuntime): string {
	return `Current working directory: ${runtime.options.cwd.replace(/\\/g, "/")}`;
}

function renderActiveModel(runtime: PromptRuntime): string {
	const model = runtime.ctx?.model;
	return model ? `Current model: ${model.provider}/${model.id}` : "Current model: (none)";
}

function slotTextFormat(item: PromptStackSlotItem, options: { allowJson?: boolean } = {}): PromptStackSlotFormat {
	const format = item.options?.format;
	if (format === "plain") return "plain";
	if (format === "json" && options.allowJson) return "json";
	return "xml";
}

function renderPiDocsGuidance(): string {
	const paths = piDocsPaths();
	return [
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
		`- Main documentation: ${paths.readme}`,
		`- Additional docs: ${paths.docs}`,
		`- Examples: ${paths.examples} (extensions, custom tools, SDK)`,
		"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
		"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
		"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
		"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
	].join("\n");
}

function piDocsPaths(): { readme: string; docs: string; examples: string } {
	const fallbackRoot = "@earendil-works/pi-coding-agent";
	try {
		const resolve = (import.meta as unknown as { resolve?: (specifier: string) => string }).resolve;
		if (!resolve) throw new Error("import.meta.resolve unavailable");
		const resolved = resolve("@earendil-works/pi-coding-agent");
		if (!resolved.startsWith("file:")) throw new Error("non-file package resolution");
		const packageRoot = dirname(dirname(fileURLToPath(resolved)));
		return {
			readme: join(packageRoot, "README.md"),
			docs: join(packageRoot, "docs"),
			examples: join(packageRoot, "examples"),
		};
	} catch {
		return {
			readme: `${fallbackRoot}/README.md`,
			docs: `${fallbackRoot}/docs`,
			examples: `${fallbackRoot}/examples`,
		};
	}
}

function renderVariables(
	item: PromptStackSlotItem,
	stack: PromptStack,
	runtime: PromptRuntime,
): string {
	const options = item.options ?? {};
	const scopes = selectedVariableScopes(options);
	const format = slotTextFormat(item);
	const store = runtime.variables;
	const grouped: Record<PromptVariableScope, Record<string, PromptVariableValue>> = {
		static: {},
		session: {},
		turn: {},
	};

	if (scopes.includes("static")) grouped.static = collectStaticVariables(stack);
	if (scopes.includes("session")) grouped.session = { ...(store?.session ?? {}) };
	if (scopes.includes("turn")) grouped.turn = { ...(store?.turn ?? {}) };

	const hasVariables = Object.values(grouped).some((values) => Object.keys(values).length > 0);
	if (!hasVariables) return "";

	if (format === "plain") {
		return renderPlainVariables(grouped);
	}

	const parts: string[] = ["<variables>"];

	for (const scope of scopes) {
		const entries = Object.entries(grouped[scope]).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) continue;
		parts.push(`  <${scope}>`);
		for (const [name, value] of entries) {
			parts.push(`    <var name=\"${escapeXml(name)}\">${escapeXml(variableValueToPromptText(value))}</var>`);
		}
		parts.push(`  </${scope}>`);
	}

	parts.push("</variables>");
	return parts.join("\n");
}

function renderPlainVariables(
	grouped: Record<PromptVariableScope, Record<string, PromptVariableValue>>,
): string {
	const parts: string[] = ["Variables:"];

	for (const scope of ["static", "session", "turn"] as const) {
		const entries = Object.entries(grouped[scope]).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) continue;
		parts.push(`${scope}:`);
		for (const [name, value] of entries) {
			parts.push(plainBullet(name, variableValueToPromptText(value)));
		}
	}

	return parts.join("\n");
}

function plainBullet(label: string, value: string): string {
	return `- ${label}: ${plainContinuation(value, "  ")}`;
}

function plainContinuation(value: string, indent: string): string {
	return value.split("\n").map((line, index) => index === 0 ? line : `${indent}${line}`).join("\n");
}

function indentPlainBlock(value: string, indent: string): string {
	return value.split("\n").map((line) => `${indent}${line}`).join("\n");
}

function selectedVariableScopes(options: Record<string, unknown>): PromptVariableScope[] {
	const scopes: PromptVariableScope[] = [];
	if (options.includeStatic !== false) scopes.push("static");
	if (options.includeSession !== false) scopes.push("session");
	if (options.includeTurn !== false) scopes.push("turn");
	return scopes;
}

function collectStaticVariables(stack: PromptStack): Record<string, PromptVariableValue> {
	return { ...(stack.variables ?? {}) };
}

function variableValueToPromptText(value: PromptVariableValue): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
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

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
