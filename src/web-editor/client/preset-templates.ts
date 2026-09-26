import type { PromptStack } from "../../types.ts";
import type { MessageKey } from "./i18n.ts";

export type NewPresetTemplateId = "default" | "empty" | "minimal";

export interface PresetTemplateDefinition {
	readonly id: NewPresetTemplateId;
	readonly labelKey: MessageKey;
	readonly descKey: MessageKey;
	readonly nameKey: MessageKey;
}

export const PRESET_TEMPLATES: readonly PresetTemplateDefinition[] = [
	{
		id: "default",
		labelKey: "polish.workspace.templateDefault",
		descKey: "polish.workspace.templateDefaultDesc",
		nameKey: "polish.workspace.templateDefaultName",
	},
	{
		id: "empty",
		labelKey: "polish.workspace.templateEmpty",
		descKey: "polish.workspace.templateEmptyDesc",
		nameKey: "polish.workspace.templateEmptyName",
	},
	{
		id: "minimal",
		labelKey: "polish.workspace.templateMinimal",
		descKey: "polish.workspace.templateMinimalDesc",
		nameKey: "polish.workspace.templateMinimalName",
	},
] as const;

export interface CreatePresetOptions {
	autoActivate?: boolean;
}

export function createPresetFromTemplate(
	template: NewPresetTemplateId,
	id: string,
	name: string,
	options: CreatePresetOptions = {},
): PromptStack {
	const autoActivate = options.autoActivate ?? false;

	if (template === "empty") {
		return {
			schemaVersion: 2,
			type: "pi-forge.prompt-stack",
			id,
			name,
			description: "Empty preset with no preset items or tool policies.",
			autoActivate,
			mode: "replace",
			defaults: {
				syntheticMessagesVisible: false,
				unresolvedMacroPolicy: "warn",
			},
			items: [],
			parameters: {},
		};
	}

	if (template === "minimal") {
		return {
			schemaVersion: 2,
			type: "pi-forge.prompt-stack",
			id,
			name,
			description:
				"Minimal Pi approximation of the DeepSeek Harness Minimal shape: the exact one-line persona, chat history, and only Pi's stock bash plus edit. It does not replicate DSH's persistent shell, editor tool, PTY, sandbox, or deployment semantics.",
			autoActivate,
			mode: "replace",
			defaults: {
				syntheticMessagesVisible: false,
				unresolvedMacroPolicy: "warn",
			},
			tools: {
				allow: ["bash", "edit"],
			},
			items: [
				{
					kind: "block",
					id: "worker-role",
					name: "Worker Role",
					enabled: true,
					role: "system",
					content: "You are a helpful software engineer assistant.",
				},
				{
					kind: "slot",
					id: "chat-history",
					name: "Chat History",
					enabled: true,
					slot: "chat-history",
					options: {
						includeSummaries: false,
					},
				},
			],
			parameters: {},
		};
	}

	// "default" template
	return {
		schemaVersion: 2,
		type: "pi-forge.prompt-stack",
		id,
		name,
		description:
			"Recreates Pi's built-in prompt layout with pi-forge slots, exposing tools, guidelines, docs, append-system-prompt, project context, skills, date/cwd, and chat history as movable pieces.",
		autoActivate,
		mode: "replace",
		defaults: {
			syntheticMessagesVisible: false,
			unresolvedMacroPolicy: "warn",
		},
		context: {
			allowDuplicateChatHistory: false,
		},
		tools: {
			allow: ["*"],
		},
		skills: {
			allow: ["*"],
		},
		items: [
			{
				kind: "block",
				id: "main-role",
				name: "Pi Default Role",
				enabled: true,
				role: "system",
				source: {
					package: "@earendil-works/pi-coding-agent",
					file: "dist/core/system-prompt.js",
				},
				content:
					"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
			},
			{
				kind: "slot",
				id: "tools",
				name: "Available Tools",
				enabled: true,
				role: "system",
				slot: "tools",
				options: {
					format: "plain",
					onlyWithSnippets: true,
				},
			},
			{
				kind: "block",
				id: "custom-tools-note",
				name: "Custom Tools Note",
				enabled: true,
				role: "system",
				content: "In addition to the tools above, you may have access to other custom tools depending on the project.",
			},
			{
				kind: "slot",
				id: "tool-guidelines",
				name: "Guidelines",
				enabled: true,
				role: "system",
				slot: "tool-guidelines",
				options: {
					format: "plain",
					heading: "Guidelines:",
					includePiDefaultGuidelines: true,
					piStyle: true,
				},
			},
			{
				kind: "slot",
				id: "pi-docs",
				name: "Pi Documentation Guidance",
				enabled: true,
				role: "system",
				slot: "pi-docs",
			},
			{
				kind: "slot",
				id: "append-system-prompt",
				name: "User Append System Prompt",
				enabled: true,
				role: "system",
				slot: "append-system-prompt",
			},
			{
				kind: "slot",
				id: "project-context",
				name: "Project Context",
				enabled: true,
				role: "system",
				slot: "project-context",
			},
			{
				kind: "slot",
				id: "skills",
				name: "Available Skills",
				enabled: true,
				role: "system",
				slot: "skills",
				options: {
					requireReadTool: true,
				},
			},
			{
				kind: "slot",
				id: "date-cwd",
				name: "Date and Working Directory",
				enabled: true,
				role: "system",
				slot: "date-cwd",
			},
			{
				kind: "slot",
				id: "chat-history",
				name: "Chat History",
				enabled: true,
				slot: "chat-history",
			},
		],
	};
}
