import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyResourcePolicy } from "./policy.js";
import { createVariableAccess, promptRenderHelpers, selectedToolNames, } from "./render-helpers.js";
import { assertRegistryName } from "./extension-registry.js";
function slotRegistryState() {
    const globalScope = globalThis;
    globalScope.__piForgeSlotRegistry ??= { slots: new Map(), supportedSlots: new Set() };
    return globalScope.__piForgeSlotRegistry;
}
const SLOT_REGISTRY = slotRegistryState();
const SLOT_RENDERERS = SLOT_REGISTRY.slots;
export const SUPPORTED_SLOTS = SLOT_REGISTRY.supportedSlots;
let registeringBuiltInSlots = true;
const FORMAT_OPTION = {
    type: "enum",
    values: ["xml", "plain"],
    default: "xml",
    description: "Render as XML-style wrappers or compact plain text.",
};
const INCLUDE_TIME_OPTION = {
    type: "boolean",
    default: false,
    description: "Include Current time: HH:MM:SS after the current date.",
};
registerSlot({ name: "chat-history", description: "Conversation history insertion point.", render: () => "" });
registerSlot({
    name: "tools",
    description: "Available tools and prompt snippets.",
    options: {
        format: FORMAT_OPTION,
        onlyWithSnippets: { type: "boolean", default: false, description: "Only render tools that provide prompt snippets." },
    },
    render: renderTools,
});
registerSlot({
    name: "tool-guidelines",
    description: "Tool usage guidelines.",
    options: {
        format: FORMAT_OPTION,
        heading: { type: "string", default: "Tool guidelines:", description: "Plain-format heading." },
        includePiDefaultGuidelines: { type: "boolean", default: false, description: "Include Pi's default concise/file-path guideline bullets." },
        piStyle: { type: "boolean", default: false, description: "Use Pi-style wording for default bash guidance." },
    },
    render: renderToolGuidelines,
});
registerSlot({
    name: "skills",
    description: "Available Pi skills.",
    options: {
        format: FORMAT_OPTION,
        requireReadTool: { type: "boolean", default: false, description: "Omit the section unless the read tool is active." },
    },
    render: renderSkills,
});
registerSlot({ name: "project-context", description: "Project context files.", options: { format: FORMAT_OPTION }, render: renderProjectContext });
registerSlot({ name: "append-system-prompt", description: "User appended system prompt text.", render: ({ runtime }) => runtime.options.appendSystemPrompt ?? "" });
registerSlot({ name: "date", description: "Current date.", options: { includeTime: INCLUDE_TIME_OPTION }, render: renderDate });
registerSlot({ name: "cwd", description: "Current working directory.", render: ({ runtime }) => renderCwd(runtime) });
registerSlot({ name: "date-cwd", description: "Current date and working directory.", options: { includeTime: INCLUDE_TIME_OPTION }, render: (context) => [renderDate(context), renderCwd(context.runtime)].join("\n") });
registerSlot({ name: "active-model", description: "Current model provider/id.", render: ({ runtime }) => renderActiveModel(runtime) });
registerSlot({ name: "pi-docs", description: "Pi documentation guidance.", render: () => renderPiDocsGuidance() });
registeringBuiltInSlots = false;
export function renderSlotText(item, stack, runtime, diagnostics) {
    const definition = SLOT_RENDERERS.get(item.slot);
    if (!definition) {
        diagnostics.push({ level: "warning", message: `Unsupported slot: ${item.slot}`, itemId: item.id });
        return "";
    }
    try {
        return definition.render(createSlotRenderContext(item, stack, runtime, diagnostics)) ?? "";
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        diagnostics.push({ level: "error", message: `Slot "${item.slot}" failed: ${detail}`, itemId: item.id });
        return "";
    }
}
export function registerSlot(definition) {
    assertRegistryName("Slot", definition.name);
    if (SLOT_RENDERERS.has(definition.name)) {
        if (registeringBuiltInSlots)
            return () => { };
        throw new Error(`Slot is already registered: ${definition.name}`);
    }
    SLOT_RENDERERS.set(definition.name, definition);
    SUPPORTED_SLOTS.add(definition.name);
    return () => {
        if (SLOT_RENDERERS.get(definition.name) === definition) {
            SLOT_RENDERERS.delete(definition.name);
            SUPPORTED_SLOTS.delete(definition.name);
        }
    };
}
export function getRegisteredSlots() {
    return [...SLOT_RENDERERS.values()];
}
function createSlotRenderContext(item, stack, runtime, diagnostics) {
    return {
        item,
        stack,
        runtime,
        diagnostics,
        options: item.options ?? {},
        helpers: promptRenderHelpers,
        variables: createVariableAccess(runtime, stack),
        format: (options) => promptRenderHelpers.slotTextFormat(item, options),
    };
}
function renderTools({ item, stack, runtime, format, helpers }) {
    const snippets = runtime.options.toolSnippets ?? {};
    const tools = item.options?.onlyWithSnippets === true
        ? selectedToolNames(stack, runtime).filter((name) => !!snippets[name])
        : selectedToolNames(stack, runtime);
    if (format() === "plain") {
        const lines = ["Available tools:"];
        if (tools.length === 0) {
            lines.push(item.options?.onlyWithSnippets === true ? "(none)" : "- (none)");
        }
        else {
            for (const name of tools) {
                lines.push(helpers.plainBullet(name, snippets[name] ?? "No prompt snippet provided."));
            }
        }
        return lines.join("\n");
    }
    const lines = ["<available_tools>"];
    if (tools.length === 0) {
        lines.push("  (none)");
    }
    else {
        for (const name of tools) {
            const snippet = snippets[name] ?? "No prompt snippet provided.";
            lines.push(`  <tool name=\"${helpers.escapeXml(name)}\">${helpers.escapeXml(snippet)}</tool>`);
        }
    }
    lines.push("</available_tools>");
    return lines.join("\n");
}
function renderToolGuidelines({ item, stack, runtime, format, helpers }) {
    const tools = selectedToolNames(stack, runtime);
    const guidelines = [];
    const seen = new Set();
    const add = (line) => {
        const normalized = line.trim();
        if (!normalized || seen.has(normalized))
            return;
        seen.add(normalized);
        guidelines.push(normalized);
    };
    if (tools.includes("bash") && !tools.includes("grep") && !tools.includes("find") && !tools.includes("ls")) {
        add(item.options?.piStyle === true ? "Use bash for file operations like ls, rg, find" : "Use bash for file operations like ls, rg, find.");
    }
    for (const guideline of runtime.options.promptGuidelines ?? [])
        add(guideline);
    if (item.options?.includePiDefaultGuidelines === true) {
        add("Be concise in your responses");
        add("Show file paths clearly when working with files");
    }
    if (guidelines.length === 0)
        return "";
    if (format() === "plain") {
        const heading = typeof item.options?.heading === "string" ? item.options.heading.trim() : "Tool guidelines:";
        return [
            ...(heading ? [heading] : []),
            ...guidelines.map((line) => `- ${helpers.plainContinuation(line, "  ")}`),
        ].join("\n");
    }
    return ["<tool_guidelines>", ...guidelines.map((line) => `- ${line}`), "</tool_guidelines>"].join("\n");
}
function renderSkills({ item, stack, runtime, format, helpers }) {
    if (item.options?.requireReadTool === true && !selectedToolNames(stack, runtime).includes("read"))
        return "";
    const skills = (runtime.options.skills ?? [])
        .filter((skill) => !skill.disableModelInvocation)
        .filter((skill) => applyResourcePolicy([skill.name], stack.skills).length > 0);
    if (skills.length === 0)
        return "";
    const lines = [
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
    ];
    if (format() === "plain") {
        lines.push("Available skills:");
        for (const skill of skills) {
            lines.push(helpers.plainBullet(skill.name, skill.description));
            lines.push(`  Location: ${helpers.plainContinuation(skill.filePath, "  ")}`);
        }
        return lines.join("\n");
    }
    lines.push("<available_skills>");
    for (const skill of skills) {
        lines.push("  <skill>");
        lines.push(`    <name>${helpers.escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${helpers.escapeXml(skill.description)}</description>`);
        lines.push(`    <location>${helpers.escapeXml(skill.filePath)}</location>`);
        lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}
function renderProjectContext({ item, runtime, format, helpers }) {
    const contextFiles = runtime.options.contextFiles ?? [];
    if (contextFiles.length === 0)
        return "";
    if (format() === "plain") {
        const lines = ["Project context:", "", "Project-specific instructions and guidelines:", ""];
        for (const file of contextFiles) {
            lines.push(`Path: ${file.path}`);
            lines.push(helpers.indentPlainBlock(file.content, "  "), "");
        }
        return lines.join("\n").trimEnd();
    }
    const lines = ["<project_context>", "", "Project-specific instructions and guidelines:", ""];
    for (const file of contextFiles) {
        lines.push(`<project_instructions path=\"${helpers.escapeXml(file.path)}\">`);
        lines.push(file.content);
        lines.push("</project_instructions>", "");
    }
    lines.push("</project_context>");
    return lines.join("\n");
}
function renderDate({ item, runtime, helpers }) {
    const lines = [`Current date: ${helpers.formatDate(runtime.now)}`];
    if (item.options?.includeTime === true) {
        lines.push(`Current time: ${helpers.formatTime(runtime.now)}`);
    }
    return lines.join("\n");
}
function renderCwd(runtime) {
    return `Current working directory: ${promptRenderHelpers.normalizePath(runtime.options.cwd)}`;
}
function renderActiveModel(runtime) {
    const model = runtime.ctx?.model;
    return model ? `Current model: ${model.provider}/${model.id}` : "Current model: (none)";
}
function renderPiDocsGuidance() {
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
function piDocsPaths() {
    const fallbackRoot = "@earendil-works/pi-coding-agent";
    try {
        const resolve = import.meta.resolve;
        if (!resolve)
            throw new Error("import.meta.resolve unavailable");
        const resolved = resolve("@earendil-works/pi-coding-agent");
        if (!resolved.startsWith("file:"))
            throw new Error("non-file package resolution");
        const packageRoot = dirname(dirname(fileURLToPath(resolved)));
        return {
            readme: join(packageRoot, "README.md"),
            docs: join(packageRoot, "docs"),
            examples: join(packageRoot, "examples"),
        };
    }
    catch {
        return {
            readme: `${fallbackRoot}/README.md`,
            docs: `${fallbackRoot}/docs`,
            examples: `${fallbackRoot}/examples`,
        };
    }
}
//# sourceMappingURL=slot-renderers.js.map