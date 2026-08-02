import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	agentProfilePath,
	agentProfilesDir,
	isResolvedAgentProfileUsable,
	validateAgentProfile,
	type AgentProfile,
	type AgentProfileProvenance,
	type LoadedAgentProfile,
	type ResolvedAgentProfile,
} from "./agent-profile.ts";
import {
	DEFAULT_SUBAGENT_BACKEND_ID,
	loadForgeSubagentSettings,
	resolveSubagentProfilePolicy,
	updateForgeSubagentProfileConfig,
	type ForgeSubagentProfileSettings,
} from "./forge-config.ts";
import {
	isInsidePromptStackStorage,
	promptStackPath,
	validatePromptStack,
} from "./loader.ts";
import {
	createAgentProfilePreview,
	deleteAgentProfile,
	getAgentProfileRuntimeStatus,
	writeAgentProfile,
	type AgentProfileApplicationResult,
	type AgentProfileCurrentRuntime,
} from "./profile-service.ts";
import type { LoadedPromptStack, PromptStack, PromptStackDiagnostic } from "./types.ts";
import type {
	WebEditorCreateStackOptions,
	WebEditorHost,
	WebEditorOperationResult,
	WebEditorPayloadSnapshot,
	WebEditorPolicyResources,
	WebEditorPreview,
	WebEditorProfileCollection,
	WebEditorProfileMutation,
	WebEditorProfileValidation,
	WebEditorStackSummary,
	WebEditorSubagentBackendOption,
	WebEditorSubagentPolicyUpdate,
	WebEditorSubagentProfilePolicy,
} from "./web-editor/index.ts";

export interface WebHostRuntime {
	getStacks(): LoadedPromptStack[];
	getActive(): LoadedPromptStack | undefined;
	getActiveId(): string | undefined;
	getSelectedActiveId(): string | undefined;
	setActive(id: string | undefined): boolean;
	reloadStacks(preferredId?: string): Promise<void>;
	buildPreview(target: LoadedPromptStack): {
		text: string;
		preview: WebEditorPreview;
		diagnostics: PromptStackDiagnostic[];
	};
	getPolicyResources(): WebEditorPolicyResources;
	getProfiles(): LoadedAgentProfile[];
	getLastAppliedProfile(): AgentProfileProvenance | undefined;
	getCurrentProfileRuntime(): AgentProfileCurrentRuntime;
	getSubagentBackends(): WebEditorSubagentBackendOption[];
	resolveProfile(target: LoadedAgentProfile): ResolvedAgentProfile;
	previewToolNames(stack: PromptStack | undefined): string[];
	reloadProfiles(): void | Promise<void>;
	isIdle(): boolean;
	applyProfile(target: ResolvedAgentProfile): Promise<AgentProfileApplicationResult>;
	getPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
	armPayload(savePath?: string): WebEditorOperationResult<WebEditorPayloadSnapshot>;
	clearPayload(): WebEditorOperationResult<WebEditorPayloadSnapshot>;
}

export function createWebEditorHost(ctx: ExtensionContext, runtime: WebHostRuntime): WebEditorHost {
	return {
		cwd: ctx.cwd,
		listStacks: () => stackSummaries(runtime.getStacks(), runtime.getActive()),
		listProfiles: () => profileCollection(ctx, runtime),
		reloadProfiles: async () => {
			if (!ctx.isProjectTrusted()) {
				return { ok: false, status: 403, error: "Project is not trusted; refusing to reload agent profiles." };
			}
			await runtime.reloadProfiles();
			return { ok: true, ...profileCollection(ctx, runtime) };
		},
		validateProfile: (profile, existingId) => profileValidation(ctx, runtime, profile, existingId),
		createProfile: (profile) => createProfileFile(ctx, runtime, profile),
		saveProfile: (id, profile) => saveProfileFile(ctx, runtime, id, profile),
		applyProfile: (id) => applyProfileRuntime(ctx, runtime, id),
		deleteProfile: (id) => deleteProfileFile(ctx, runtime, id),
		updateSubagentPolicy: (id, update) => updateSubagentPolicy(ctx, runtime, id, update),
		listResources: () => runtime.getPolicyResources(),
		getStack: (id) => {
			const loaded = runtime.getStacks().find((candidate) => candidate.stack.id === id);
			return loaded ? { stack: loaded.stack, filePath: loaded.filePath, diagnostics: loaded.diagnostics } : undefined;
		},
		createStack: (stack, options) => createStackFile(ctx, runtime, stack, options),
		saveStack: (id, stack) => saveStackFile(ctx, runtime, id, stack),
		deleteStack: (id) => deleteStackFile(ctx, runtime, id),
		validateStack: (stack) => validatePromptStack(stack),
		previewStack: (id, stack) => {
			const target = runtime.getStacks().find((candidate) => candidate.stack.id === id);
			if (!target) return { ok: false, status: 404, error: `Unknown prompt stack: ${id}` };
			const diagnostics = validatePromptStack(stack);
			const preview = runtime.buildPreview({ stack, filePath: target.filePath, diagnostics });
			return { ok: true, text: preview.text, preview: preview.preview, diagnostics: preview.diagnostics };
		},
		getPayload: () => runtime.getPayload(),
		armPayload: (savePath) => runtime.armPayload(savePath),
		clearPayload: () => runtime.clearPayload(),
		activateStack: (id) => {
			if (!runtime.setActive(id)) return { ok: false, status: 404, error: `Unknown prompt stack: ${id}` };
			return { ok: true, activeId: runtime.getActiveId(), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
		},
		disableStacks: () => {
			runtime.setActive("none");
			return { ok: true, activeId: runtime.getActiveId(), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
		},
		reloadStacks: async () => {
			await runtime.reloadStacks(runtime.getSelectedActiveId());
			return { ok: true, activeId: runtime.getActiveId(), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
		},
	};
}

function profileCollection(ctx: ExtensionContext, runtime: WebHostRuntime): WebEditorProfileCollection {
	const profiles = runtime.getProfiles();
	const current = runtime.getCurrentProfileRuntime();
	const lastApplied = runtime.getLastAppliedProfile();
	const availableModels = new Set(ctx.modelRegistry.getAvailable().map((model) => modelKey(model.provider, model.id)));
	const subagentSettings = loadForgeSubagentSettings(ctx);
	const subagentBackends = runtime.getSubagentBackends();
	const registeredBackends = new Set(subagentBackends.map((backend) => backend.id));
	return {
		trusted: ctx.isProjectTrusted(),
		profileDirectory: agentProfilesDir(ctx.cwd),
		profiles: profiles.map((loaded) => {
			const resolved = runtime.resolveProfile(loaded);
			const targetEffectiveTools = resolved.promptStack || resolved.loaded.profile.promptStack === null
				? runtime.previewToolNames(resolved.promptStack?.stack)
				: [];
			const preview = createAgentProfilePreview(resolved, current, targetEffectiveTools);
			return {
				profile: structuredClone(loaded.profile),
				filePath: loaded.filePath,
				preview,
				errors: preview.diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
				warnings: preview.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length,
				lastApplied: lastApplied?.sourcePath === loaded.filePath,
				subagent: subagentPolicySummary(subagentSettings, loaded.profile.id, registeredBackends),
			};
		}),
		status: getAgentProfileRuntimeStatus(profiles, lastApplied, current),
		models: ctx.modelRegistry.getAll().map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
			available: availableModels.has(modelKey(model.provider, model.id)),
		})),
		promptStacks: runtime.getStacks().map((loaded) => ({
			id: loaded.stack.id,
			name: loaded.stack.name,
		})),
		subagents: {
			defaultBackend: subagentSettings.backend ?? DEFAULT_SUBAGENT_BACKEND_ID,
			defaultBackendSource: subagentSettings.backendSource ?? "built-in",
			timeoutMs: subagentSettings.timeoutMs,
			timeoutSource: subagentSettings.timeoutSource,
			allowAgentInvocationWithoutApproval: subagentSettings.allowAgentInvocationWithoutApproval,
			backends: subagentBackends,
			warnings: [...subagentSettings.warnings],
		},
	};
}

function subagentPolicySummary(
	settings: ReturnType<typeof loadForgeSubagentSettings>,
	profileId: string,
	registeredBackends: ReadonlySet<string>,
): WebEditorSubagentProfilePolicy {
	const policy = resolveSubagentProfilePolicy(settings, profileId);
	const configured = settings.profiles[profileId];
	return {
		enabled: policy.enabled,
		enabledSource: policy.enabledSource,
		backend: policy.backend.id,
		backendSource: policy.backend.source,
		backendRegistered: registeredBackends.has(policy.backend.id),
		timeoutMs: policy.timeout.milliseconds,
		timeoutSource: policy.timeout.source,
		configured: configuredSubagentProfile(configured),
	};
}

function configuredSubagentProfile(
	configured: ForgeSubagentProfileSettings | undefined,
): WebEditorSubagentProfilePolicy["configured"] {
	if (!configured) return {};
	return {
		enabled: configured.enabled,
		backend: configured.backend,
		timeoutMs: configured.timeoutMs,
	};
}

function profileValidation(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	profile: AgentProfile,
	existingId?: string,
): WebEditorProfileValidation {
	const profiles = runtime.getProfiles();
	const existingMatches = existingId
		? profiles.filter((loaded) => loaded.profile.id === existingId)
		: [];
	const existing = existingMatches.length === 1 ? existingMatches[0] : undefined;
	const filePath = existing?.filePath ?? agentProfilePath(ctx.cwd, profile.id);
	const diagnostics = validateAgentProfile(profile);
	const otherProfiles = existing
		? profiles.filter((loaded) => loaded.filePath !== filePath)
		: profiles;

	if (otherProfiles.some((loaded) => loaded.profile.id === profile.id)) {
		diagnostics.push({
			level: "error",
			field: "id",
			message: `Duplicate profile id: ${profile.id} already exists in another file.`,
		});
	}
	if (!existing && existsSync(filePath)) {
		diagnostics.push({
			level: "error",
			field: "id",
			message: `Profile file already exists: ${filePath}`,
		});
	}
	if (profile.autoActivate && otherProfiles.some((loaded) => loaded.profile.autoActivate === true)) {
		diagnostics.push({
			level: "error",
			field: "autoActivate",
			message: "Multiple profiles request auto-activation; exactly one is allowed.",
		});
	}

	const resolved = runtime.resolveProfile({ profile, filePath, diagnostics });
	const targetEffectiveTools = resolved.promptStack || profile.promptStack === null
		? runtime.previewToolNames(resolved.promptStack?.stack)
		: [];
	const preview = createAgentProfilePreview(resolved, runtime.getCurrentProfileRuntime(), targetEffectiveTools);
	return {
		preview,
		diagnostics: preview.diagnostics,
		errors: preview.diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
		warnings: preview.diagnostics.filter((diagnostic) => diagnostic.level === "warning").length,
	};
}

async function createProfileFile(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	profile: AgentProfile,
): Promise<WebEditorOperationResult<WebEditorProfileMutation>> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to create agent profiles." };
	}
	if (runtime.getProfiles().some((loaded) => loaded.profile.id === profile.id)) {
		return { ok: false, status: 409, error: `Agent profile already exists: ${profile.id}` };
	}
	const conflict = autoActivateConflictError(runtime.getProfiles(), profile);
	if (conflict) return { ok: false, status: 409, error: conflict };

	const result = writeAgentProfile(ctx.cwd, profile);
	if (!result.ok) return profileWriteError(profile.id, result);
	await runtime.reloadProfiles();
	return {
		ok: true,
		collection: profileCollection(ctx, runtime),
		selectedPath: result.filePath,
	};
}

async function saveProfileFile(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	id: string,
	profile: AgentProfile,
): Promise<WebEditorOperationResult<WebEditorProfileMutation>> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to save agent profiles." };
	}
	const matches = runtime.getProfiles().filter((loaded) => loaded.profile.id === id);
	if (matches.length === 0) return { ok: false, status: 404, error: `Unknown agent profile: ${id}` };
	if (matches.length > 1) {
		return { ok: false, status: 409, error: `Cannot save agent profile ${id} while duplicate profile ids exist.` };
	}
	if (profile.id !== id) {
		return { ok: false, status: 400, error: "Profile id is immutable during save; create a new profile to use a different id." };
	}
	const conflict = autoActivateConflictError(runtime.getProfiles(), profile, id);
	if (conflict) return { ok: false, status: 409, error: conflict };

	const result = writeAgentProfile(ctx.cwd, profile, {
		filePath: matches[0]!.filePath,
		overwrite: true,
	});
	if (!result.ok) return profileWriteError(id, result);
	await runtime.reloadProfiles();
	return {
		ok: true,
		collection: profileCollection(ctx, runtime),
		selectedPath: result.filePath,
	};
}

async function updateSubagentPolicy(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	id: string,
	update: WebEditorSubagentPolicyUpdate,
): Promise<WebEditorOperationResult<WebEditorProfileMutation>> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to change subagent delegation." };
	}
	const matches = runtime.getProfiles().filter((loaded) => loaded.profile.id === id);
	if (matches.length === 0) return { ok: false, status: 404, error: `Unknown agent profile: ${id}` };
	if (matches.length > 1) {
		return { ok: false, status: 409, error: `Cannot configure subagent delegation for ${id} while duplicate profile ids exist.` };
	}

	const result = updateForgeSubagentProfileConfig(ctx.cwd, id, update);
	if (!result.ok) return { ok: false, status: 400, error: result.error };
	return {
		ok: true,
		collection: profileCollection(ctx, runtime),
		selectedPath: matches[0]!.filePath,
	};
}

function autoActivateConflictError(
	profiles: readonly LoadedAgentProfile[],
	profile: AgentProfile,
	excludeId?: string,
): string | undefined {
	if (profile.autoActivate !== true) return undefined;
	const conflict = profiles.find((loaded) => loaded.profile.autoActivate === true && loaded.profile.id !== excludeId);
	return conflict
		? `Multiple profiles request auto-activation; exactly one is allowed (already requested by ${conflict.profile.id}).`
		: undefined;
}

async function applyProfileRuntime(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	id: string,
): Promise<WebEditorOperationResult<WebEditorProfileMutation>> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to apply agent profiles." };
	}
	if (!runtime.isIdle()) {
		return { ok: false, status: 409, error: "Wait for the current agent operation to finish before applying a profile." };
	}
	const matches = runtime.getProfiles().filter((loaded) => loaded.profile.id === id);
	if (matches.length === 0) return { ok: false, status: 404, error: `Unknown agent profile: ${id}` };
	if (matches.length > 1) {
		return { ok: false, status: 409, error: `Cannot apply agent profile ${id} while duplicate profile ids exist.` };
	}

	const resolved = runtime.resolveProfile(matches[0]!);
	if (!isResolvedAgentProfileUsable(resolved) || !resolved.model) {
		return { ok: false, status: 400, error: `Agent profile ${id} failed preflight; runtime state was not changed.` };
	}
	const result = await runtime.applyProfile(resolved);
	if (!result.ok) {
		const rollback = result.rollbackErrors.length
			? ` Rollback problems: ${result.rollbackErrors.join("; ")}.`
			: " Previous runtime state was restored.";
		return { ok: false, status: 500, error: `${result.detail}${result.detail.endsWith(".") ? "" : "."}${rollback}` };
	}
	return {
		ok: true,
		collection: profileCollection(ctx, runtime),
		selectedPath: matches[0]!.filePath,
	};
}

async function deleteProfileFile(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	id: string,
): Promise<WebEditorOperationResult<WebEditorProfileMutation>> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to delete agent profiles." };
	}
	const matches = runtime.getProfiles().filter((loaded) => loaded.profile.id === id);
	if (matches.length === 0) return { ok: false, status: 404, error: `Unknown agent profile: ${id}` };
	if (matches.length > 1) {
		return { ok: false, status: 409, error: `Cannot delete agent profile ${id} while duplicate profile ids exist.` };
	}

	const subagentSettings = loadForgeSubagentSettings(ctx);
	const result = deleteAgentProfile(ctx.cwd, matches[0]!);
	if (!result.ok) {
		if (result.reason === "invalid-path") return { ok: false, status: 403, error: "Refusing to delete outside agent-profile storage." };
		if (result.reason === "missing") return { ok: false, status: 404, error: `Agent profile file is missing: ${result.filePath}` };
		if (result.reason === "changed") {
			return { ok: false, status: 409, error: `Agent profile ${id} changed on disk; refresh before deleting it.` };
		}
		return { ok: false, status: 500, error: result.error ?? `Failed to delete agent profile ${id}.` };
	}
	if (Object.hasOwn(subagentSettings.profiles, id)) {
		const cleared = updateForgeSubagentProfileConfig(ctx.cwd, id, {
			enabled: false,
			backend: null,
			timeoutMs: null,
		});
		if (!cleared.ok) {
			await runtime.reloadProfiles();
			return {
				ok: false,
				status: 500,
				error: `Deleted agent profile ${id}, but failed to remove its delegation settings: ${cleared.error}`,
			};
		}
	}
	await runtime.reloadProfiles();
	const collection = profileCollection(ctx, runtime);
	return {
		ok: true,
		collection,
		selectedPath: collection.profiles[0]?.filePath ?? "",
	};
}

function profileWriteError(
	id: string,
	result: Exclude<ReturnType<typeof writeAgentProfile>, { ok: true }>,
): WebEditorOperationResult<never> {
	if (result.reason === "exists") return { ok: false, status: 409, error: `Agent profile already exists: ${id}` };
	if (result.reason === "invalid-path") return { ok: false, status: 403, error: result.error ?? "Refusing to write outside agent-profile storage." };
	if (result.reason === "validation") {
		return {
			ok: false,
			status: 400,
			error: result.diagnostics.map((diagnostic) => diagnostic.message).join(" "),
		};
	}
	return { ok: false, status: 500, error: result.error ?? `Failed to write agent profile ${id}.` };
}

function modelKey(provider: string, id: string): string {
	return `${provider}\0${id}`;
}

export function stackSummary(loaded: LoadedPromptStack, active: LoadedPromptStack | undefined): WebEditorStackSummary {
	const errors = loaded.diagnostics.filter((d) => d.level === "error").length;
	const warnings = loaded.diagnostics.filter((d) => d.level === "warning").length;
	return {
		id: loaded.stack.id,
		name: loaded.stack.name,
		filePath: loaded.filePath,
		active: loaded === active,
		autoActivate: loaded.stack.autoActivate,
		mode: loaded.stack.mode ?? "replace",
		itemCount: loaded.stack.items.length,
		errors,
		warnings,
		diagnostics: loaded.diagnostics,
	};
}

export function stackSummaries(stacks: LoadedPromptStack[], active: LoadedPromptStack | undefined): WebEditorStackSummary[] {
	return stacks.map((loaded) => stackSummary(loaded, active));
}

export function loadWebEditorSettings(ctx: ExtensionContext): { preferredPort?: number; configPath: string; warnings: string[] } {
	const configPath = join(ctx.cwd, ".pi", "forge", "config.json");
	if (!ctx.isProjectTrusted() || !existsSync(configPath)) {
		return { configPath, warnings: [] };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		return {
			configPath,
			warnings: [`pi-forge: failed to read ${configPath}; using an available editor port. ${error instanceof Error ? error.message : String(error)}`],
		};
	}

	if (!isPlainObject(raw)) {
		return {
			configPath,
			warnings: [`pi-forge: ${configPath} must be a JSON object; using an available editor port.`],
		};
	}

	const webEditorConfig = isPlainObject(raw.webEditor) ? raw.webEditor : undefined;
	const rawPort = webEditorConfig?.port ?? raw.webEditorPort;
	if (rawPort === undefined) return { configPath, warnings: [] };

	if (typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535) {
		return { preferredPort: rawPort, configPath, warnings: [] };
	}

	return {
		configPath,
		warnings: [`pi-forge: ${configPath} webEditor.port must be an integer from 1 to 65535; using an available editor port.`],
	};
}

async function saveStackFile(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	id: string,
	stack: PromptStack,
): Promise<WebEditorOperationResult<{ stack: WebEditorStackSummary; stacks: WebEditorStackSummary[] }>> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to save prompt stacks." };
	}

	const target = runtime.getStacks().find((candidate) => candidate.stack.id === id);
	if (!target) return { ok: false, status: 404, error: `Unknown prompt stack: ${id}` };
	const idError = validateWebStackId(stack.id);
	if (idError) return { ok: false, status: 400, error: idError };
	if (stack.id !== id) {
		return { ok: false, status: 400, error: "Stack id is immutable during save; fork the stack to create a new id." };
	}
	if (!isInsidePromptStackStorage(ctx.cwd, target.filePath)) {
		return { ok: false, status: 403, error: "Refusing to save outside prompt-stack storage." };
	}

	writeFileSync(target.filePath, `${JSON.stringify(stack, null, 2)}\n`, "utf8");
	const preferredId = runtime.getActive()?.stack.id === id ? stack.id : runtime.getSelectedActiveId();
	await runtime.reloadStacks(preferredId);
	const saved = runtime.getStacks().find((candidate) => candidate.stack.id === stack.id) ?? runtime.getStacks().find((candidate) => candidate.filePath === target.filePath);
	if (!saved) return { ok: false, status: 500, error: "Saved stack could not be reloaded." };
	return { ok: true, stack: stackSummary(saved, runtime.getActive()), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
}

async function createStackFile(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	stack: PromptStack,
	options: WebEditorCreateStackOptions,
): Promise<WebEditorOperationResult<{ stack: WebEditorStackSummary; stacks: WebEditorStackSummary[] }>> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to create prompt stacks." };
	}

	const idError = validateWebStackId(stack.id);
	if (idError) return { ok: false, status: 400, error: idError };

	const existingById = runtime.getStacks().find((candidate) => candidate.stack.id === stack.id);
	if (existingById && !options.overwrite) {
		return { ok: false, status: 409, error: `Prompt stack already exists: ${stack.id}` };
	}

	const targetPath = existingById && options.overwrite ? existingById.filePath : promptStackPath(ctx.cwd, stack.id);
	if (!isInsidePromptStackStorage(ctx.cwd, targetPath)) {
		return { ok: false, status: 403, error: "Refusing to create outside prompt-stack storage." };
	}

	if (!existingById && existsSync(targetPath) && !options.overwrite) {
		return { ok: false, status: 409, error: `Prompt stack already exists: ${stack.id}` };
	}

	const previousSelection = runtime.getSelectedActiveId();
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, `${JSON.stringify(stack, null, 2)}\n`, "utf8");
	await runtime.reloadStacks(options.activate ? stack.id : (previousSelection ?? "none"));
	if (options.activate) runtime.setActive(stack.id);

	const created = runtime.getStacks().find((candidate) => candidate.stack.id === stack.id);
	if (!created) return { ok: false, status: 500, error: "Created stack could not be reloaded." };
	return { ok: true, stack: stackSummary(created, runtime.getActive()), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
}

async function deleteStackFile(
	ctx: ExtensionContext,
	runtime: WebHostRuntime,
	id: string,
): Promise<WebEditorOperationResult<{ activeId?: string; stacks: WebEditorStackSummary[] }>> {
	if (!ctx.isProjectTrusted()) {
		return { ok: false, status: 403, error: "Project is not trusted; refusing to delete prompt stacks." };
	}

	const target = runtime.getStacks().find((candidate) => candidate.stack.id === id);
	if (!target) return { ok: false, status: 404, error: `Unknown prompt stack: ${id}` };
	if (!isInsidePromptStackStorage(ctx.cwd, target.filePath)) {
		return { ok: false, status: 403, error: "Refusing to delete outside prompt-stack storage." };
	}

	const wasActive = runtime.getActive()?.stack.id === id;
	unlinkSync(target.filePath);
	if (wasActive) {
		runtime.setActive("none");
		await runtime.reloadStacks("none");
	} else {
		await runtime.reloadStacks(runtime.getSelectedActiveId());
	}
	return { ok: true, activeId: runtime.getActiveId(), stacks: stackSummaries(runtime.getStacks(), runtime.getActive()) };
}

function validateWebStackId(id: string): string | undefined {
	if (!id.trim()) return "Stack id must not be empty.";
	if (!/^[A-Za-z0-9_-]+$/.test(id)) {
		return "Stack id may only contain letters, numbers, underscore, and dash.";
	}
	return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
