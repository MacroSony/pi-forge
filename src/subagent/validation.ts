import {
	FINGERPRINT_PATTERN,
	LIMIT_NAMES,
	OPAQUE_ID_PATTERN,
	error,
	hasErrors,
	isFingerprint,
	isRecord,
	isSafeRelativePath,
	validateAccessEnforcement,
	validateAccessRequest as validatePortableAccessRequest,
	validateBackendDescriptor as validatePortableBackendDescriptor,
	validateLimitReceipt as validatePortableLimitReceipt,
	validateLimitRequest as validatePortableLimitRequest,
	validatePromptRuntime as validatePortablePromptRuntime,
	type Diagnostic,
} from "@zihanw/pi-subagent-runtime";
import type { SubagentDiagnostic, SubagentPreparationRuntime } from "./types.ts";

// ---------------------------------------------------------------------------
// Portable leaves owned by @zihanw/pi-subagent-runtime core.
//
// The runtime package is the single source of truth for validators over the
// portable execution contract. This module re-exports the identical helpers
// and adapts the runtime's returning-style validators to the collecting-style
// signatures the 0.4 host contract always used. Only host-specific artifacts
// (selected context, context budgets, media references, usage, artifacts,
// traces, and the richer host access-receipt checks) keep local
// implementations below.
// ---------------------------------------------------------------------------

export {
	FINGERPRINT_PATTERN,
	LIMIT_NAMES as SUBAGENT_LIMIT_NAMES,
	OPAQUE_ID_PATTERN,
	error,
	hasErrors,
	hasErrors as hasSubagentErrors,
	isFingerprint,
	isRecord,
	isSafeRelativePath,
	validateAccessEnforcement,
};

export const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateAccessRequest(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	diagnostics.push(...validatePortableAccessRequest(value, path));
}

export function validateLimitRequest(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	diagnostics.push(...validatePortableLimitRequest(value, path));
}

export function validateLimitReceipt(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	diagnostics.push(...validatePortableLimitReceipt(value, path));
}

export function validateBackendDescriptor(value: Record<string, unknown>, path: string, diagnostics: SubagentDiagnostic[]): void {
	diagnostics.push(...repath(validatePortableBackendDescriptor(value), path));
	// Host-only capability booleans the portable descriptor does not carry.
	if (isRecord(value.capabilities)) {
		for (const field of ["traceInspection", "artifactRetention"] as const) {
			if (typeof value.capabilities[field] !== "boolean") diagnostics.push(error("backend.boolean-capability", `${field} must be boolean.`, `${path}.capabilities.${field}`));
		}
	}
}

export function validatePreparationRuntime(
	value: unknown,
	path: string,
	diagnostics: SubagentDiagnostic[],
	expectedFidelity?: SubagentPreparationRuntime["fidelity"],
): void {
	diagnostics.push(...repath(validatePortablePromptRuntime(value, expectedFidelity), path));
}

// ---------------------------------------------------------------------------
// Host-specific validators with no portable counterpart.
// ---------------------------------------------------------------------------

export function validateMediaReference(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (!isRecord(value)) {
		diagnostics.push(error("request.media-item", "Media reference must be an object.", path));
		return;
	}
	validateOpaqueId(value.id, `${path}.id`, diagnostics);
	if (value.kind !== "image") diagnostics.push(error("request.media-kind", "Only image media is supported in v1.", `${path}.kind`));
	if (typeof value.mimeType !== "string" || !/^image\/[A-Za-z0-9.+-]+$/.test(value.mimeType)) diagnostics.push(error("request.media-mime", "mimeType must be an image MIME type.", `${path}.mimeType`));
	validateFingerprint(value.digest, `${path}.digest`, diagnostics);
	validateOpaqueId(value.resourceHandle, `${path}.resourceHandle`, diagnostics);
}

export function validateSelectedContext(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): SubagentDiagnostic[] {
	if (!isRecord(value)) {
		diagnostics.push(error("context.type", "selectedContext must be an object.", path));
		return diagnostics;
	}
	if (!isPositiveInteger(value.maxBytes)) diagnostics.push(error("context.max-bytes", "maxBytes must be a positive integer.", `${path}.maxBytes`));
	if (!Array.isArray(value.items)) {
		diagnostics.push(error("context.items", "items must be an array.", `${path}.items`));
		return diagnostics;
	}
	const ids = new Set<string>();
	value.items.forEach((item, index) => {
		const itemPath = `${path}.items[${index}]`;
		if (!isRecord(item)) {
			diagnostics.push(error("context.item", "Context item must be an object.", itemPath));
			return;
		}
		validateOpaqueId(item.id, `${itemPath}.id`, diagnostics);
		if (typeof item.id === "string" && ids.has(item.id)) diagnostics.push(error("context.duplicate-id", `Duplicate context item id: ${item.id}`, `${itemPath}.id`));
		if (typeof item.id === "string") ids.add(item.id);
		if (!["summary", "user-excerpt", "assistant-excerpt", "tool-result-excerpt", "resource-excerpt"].includes(String(item.kind))) diagnostics.push(error("context.kind", "Unsupported context item kind.", `${itemPath}.kind`));
		if (typeof item.text !== "string" || !item.text.trim()) diagnostics.push(error("context.text", "Context item text must not be empty.", `${itemPath}.text`));
		if (item.required !== undefined && typeof item.required !== "boolean") diagnostics.push(error("context.required", "required must be boolean.", `${itemPath}.required`));
		if (!isRecord(item.provenance) || typeof item.provenance.source !== "string" || !item.provenance.source.trim()) diagnostics.push(error("context.provenance", "Context item provenance.source is required.", `${itemPath}.provenance`));
	});
	return diagnostics;
}

export function validateToolCatalog(value: readonly unknown[], diagnostics: SubagentDiagnostic[]): void {
	const ids = new Set<string>();
	const names = new Set<string>();
	value.forEach((tool, index) => {
		if (!isRecord(tool)) return diagnostics.push(error("tools.catalog-entry", "Tool catalog entry must be an object.", `toolCatalog[${index}]`));
		validateOpaqueId(tool.id, `toolCatalog[${index}].id`, diagnostics);
		validateOpaqueId(tool.name, `toolCatalog[${index}].name`, diagnostics);
		if (typeof tool.id === "string" && ids.has(tool.id)) diagnostics.push(error("tools.duplicate-id", `Duplicate tool id: ${tool.id}`, `toolCatalog[${index}].id`));
		if (typeof tool.name === "string" && names.has(tool.name)) diagnostics.push(error("tools.duplicate-name", `Duplicate tool name: ${tool.name}`, `toolCatalog[${index}].name`));
		if (typeof tool.id === "string") ids.add(tool.id);
		if (typeof tool.name === "string") names.add(tool.name);
		if (!Array.isArray(tool.effects) || tool.effects.some((effect) => !["filesystem-read", "filesystem-write", "process", "network"].includes(String(effect)))) diagnostics.push(error("tools.effects", "Tool effects must be a valid effect array.", `toolCatalog[${index}].effects`));
	});
}

/**
 * Host access-receipt validation. The portable runtime validator intentionally
 * checks less: the host additionally enforces mount uniqueness, access-level
 * consistency, and the isolation claims a receipt may make for its execution
 * boundary, because these cross-checks are the honesty terms of the host
 * contract (a shared-user boundary must never claim OS isolation).
 */
export function validateAccessReceipt(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (!isRecord(value)) {
		diagnostics.push(error("access-receipt.type", "Access receipt must be an object.", path));
		return;
	}
	if (!["none", "read-only", "workspace-write"].includes(String(value.level))) diagnostics.push(error("access-receipt.level", "Invalid access receipt level.", `${path}.level`));
	if (!Array.isArray(value.mounts)) diagnostics.push(error("access-receipt.mounts", "Access receipt mounts must be an array.", `${path}.mounts`));
	else {
		const handles = new Set<string>();
		const mountIds = new Set<string>();
		value.mounts.forEach((mount, index) => {
			if (!isRecord(mount)) return diagnostics.push(error("access-receipt.mount", "Mount mapping must be an object.", `${path}.mounts[${index}]`));
			validateOpaqueId(mount.workspaceHandle, `${path}.mounts[${index}].workspaceHandle`, diagnostics);
			validateOpaqueId(mount.mountId, `${path}.mounts[${index}].mountId`, diagnostics);
			if (mount.mode !== "read-only" && mount.mode !== "read-write") diagnostics.push(error("access-receipt.mount-mode", "Mount mode must be read-only or read-write.", `${path}.mounts[${index}].mode`));
			if (typeof mount.workspaceHandle === "string" && handles.has(mount.workspaceHandle)) diagnostics.push(error("access-receipt.duplicate-workspace", `Duplicate workspace mapping: ${mount.workspaceHandle}`, `${path}.mounts[${index}].workspaceHandle`));
			if (typeof mount.mountId === "string" && mountIds.has(mount.mountId)) diagnostics.push(error("access-receipt.duplicate-mount", `Duplicate mount id: ${mount.mountId}`, `${path}.mounts[${index}].mountId`));
			if (typeof mount.workspaceHandle === "string") handles.add(mount.workspaceHandle);
			if (typeof mount.mountId === "string") mountIds.add(mount.mountId);
		});
		if (value.level === "none" && value.mounts.length > 0) diagnostics.push(error("access-receipt.none-mounts", "Access none cannot produce mount mappings.", `${path}.mounts`));
		if (value.level === "read-only" && value.mounts.some((mount) => isRecord(mount) && mount.mode === "read-write")) diagnostics.push(error("access-receipt.read-only-write", "Read-only access cannot produce a read-write mount.", `${path}.mounts`));
		if (value.level === "workspace-write" && !value.mounts.some((mount) => isRecord(mount) && mount.mode === "read-write")) diagnostics.push(error("access-receipt.write-missing", "workspace-write receipt requires a read-write mount.", `${path}.mounts`));
		if (value.workingDirectory !== undefined) {
			if (!isRecord(value.workingDirectory)) diagnostics.push(error("access-receipt.cwd", "workingDirectory must be an object.", `${path}.workingDirectory`));
			else {
				if (!mountIds.has(String(value.workingDirectory.mountId))) diagnostics.push(error("access-receipt.cwd-mount", "workingDirectory must reference a receipt mount.", `${path}.workingDirectory.mountId`));
				if (!isSafeRelativePath(value.workingDirectory.path, true)) diagnostics.push(error("access-receipt.cwd-path", "workingDirectory path must be normalized and relative.", `${path}.workingDirectory.path`));
			}
		}
	}
	if (value.network !== "deny" && value.network !== "allow") diagnostics.push(error("access-receipt.network", "Invalid access receipt network policy.", `${path}.network`));
	if (typeof value.process !== "boolean") diagnostics.push(error("access-receipt.process", "Access receipt process must be boolean.", `${path}.process`));
	if (value.process === true && value.level !== "workspace-write") diagnostics.push(error("access-receipt.process-level", "Process access requires workspace-write.", `${path}.process`));
	if (value.executionBoundary !== undefined && value.executionBoundary !== "isolated" && value.executionBoundary !== "shared-user") {
		diagnostics.push(error("access-receipt.boundary", "executionBoundary must be isolated or shared-user.", `${path}.executionBoundary`));
	}
	const executionBoundary = value.executionBoundary ?? "isolated";
	if (!isRecord(value.enforcement)) diagnostics.push(error("access-receipt.enforcement", "Access enforcement receipt is required.", `${path}.enforcement`));
	else {
		validateAccessCapabilities(value.enforcement, `${path}.enforcement`, diagnostics);
		if (executionBoundary === "shared-user") {
			for (const field of ["readOnlyMountIsolation", "readWriteMountIsolation", "symlinkSafeContainment", "processIsolation", "agentNetworkIsolation"] as const) {
				if (value.enforcement[field] === true) diagnostics.push(error("access-receipt.shared-user-claim", `A shared-user boundary cannot claim ${field}.`, `${path}.enforcement.${field}`));
			}
		}
		if (executionBoundary === "isolated" && value.level === "read-only" && (!value.enforcement.readOnlyMountIsolation || !value.enforcement.symlinkSafeContainment)) diagnostics.push(error("access-receipt.read-isolation", "Isolated read-only access requires mount isolation and symlink-safe containment.", `${path}.enforcement`));
		if (value.level === "workspace-write" && (!value.enforcement.readWriteMountIsolation || !value.enforcement.symlinkSafeContainment)) diagnostics.push(error("access-receipt.write-isolation", "Workspace-write receipt requires write isolation and symlink-safe containment.", `${path}.enforcement`));
		if (value.process === true && !value.enforcement.processIsolation) diagnostics.push(error("access-receipt.process-isolation", "Process receipt requires process isolation.", `${path}.enforcement.processIsolation`));
		if (value.network === "deny" && !value.enforcement.agentNetworkIsolation) diagnostics.push(error("access-receipt.network-isolation", "Denied network receipt requires agent network isolation.", `${path}.enforcement.agentNetworkIsolation`));
	}
	if (value.level === "none" && value.workingDirectory !== undefined) diagnostics.push(error("access-receipt.none-cwd", "Access none cannot produce a workingDirectory.", `${path}.workingDirectory`));
}

export function validateAccessCapabilities(value: Record<string, unknown>, path: string, diagnostics: SubagentDiagnostic[]): void {
	for (const field of [
		"readOnlyMountIsolation", "readWriteMountIsolation", "symlinkSafeContainment", "processIsolation", "agentNetworkIsolation",
	] as const) {
		if (typeof value[field] !== "boolean") diagnostics.push(error("access-capability.boolean", `${field} must be boolean.`, `${path}.${field}`));
	}
}

export function validatePreparedMessage(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (!isRecord(value)) {
		diagnostics.push(error("plan.message", "Prepared message must be an object.", path));
		return;
	}
	if (!["user", "assistant", "custom"].includes(String(value.role))) diagnostics.push(error("plan.message-role", "Unsupported prepared message role.", `${path}.role`));
	if (!Array.isArray(value.content) || value.content.length === 0) {
		diagnostics.push(error("plan.message-content", "Prepared message content must be a non-empty array.", `${path}.content`));
		return;
	}
	value.content.forEach((part, index) => {
		if (!isRecord(part)) return diagnostics.push(error("plan.content-part", "Content part must be an object.", `${path}.content[${index}]`));
		if (part.type === "text") {
			if (typeof part.text !== "string") diagnostics.push(error("plan.text-part", "Text content requires text.", `${path}.content[${index}].text`));
		} else if (part.type === "media") {
			validateOpaqueId(part.mediaId, `${path}.content[${index}].mediaId`, diagnostics);
			if (typeof part.mimeType !== "string" || !part.mimeType.includes("/")) diagnostics.push(error("plan.media-mime", "Media content requires mimeType.", `${path}.content[${index}].mimeType`));
			validateFingerprint(part.digest, `${path}.content[${index}].digest`, diagnostics);
			if (part.backendResourceId !== undefined) validateOpaqueId(part.backendResourceId, `${path}.content[${index}].backendResourceId`, diagnostics);
		} else diagnostics.push(error("plan.content-type", "Unsupported prepared content part type.", `${path}.content[${index}].type`));
	});
	if (value.protectedTask !== undefined && typeof value.protectedTask !== "boolean") diagnostics.push(error("plan.protected-flag", "protectedTask must be boolean.", `${path}.protectedTask`));
}

export function validateContextBudgetReceipt(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (!isRecord(value)) {
		diagnostics.push(error("context-receipt.type", "Context budget receipt must be an object.", path));
		return;
	}
	if (!isPositiveInteger(value.maxBytes)) diagnostics.push(error("context-receipt.max", "maxBytes must be a positive integer.", `${path}.maxBytes`));
	if (!isNonNegativeInteger(value.includedBytes) || (isPositiveInteger(value.maxBytes) && (value.includedBytes as number) > value.maxBytes)) diagnostics.push(error("context-receipt.bytes", "includedBytes must be non-negative and no greater than maxBytes.", `${path}.includedBytes`));
	for (const field of ["includedItemIds", "omittedItemIds"] as const) {
		if (!Array.isArray(value[field])) diagnostics.push(error("context-receipt.ids", `${field} must be an array.`, `${path}.${field}`));
		else validateUniqueStringArray(value[field], `${path}.${field}`, diagnostics);
	}
}

export function validateUniqueStringArray(value: readonly unknown[], path: string, diagnostics: SubagentDiagnostic[]): void {
	const seen = new Set<string>();
	value.forEach((item, index) => {
		if (typeof item !== "string") diagnostics.push(error("array.string", "Expected a string.", `${path}[${index}]`));
		else if (seen.has(item)) diagnostics.push(error("array.duplicate", `Duplicate value: ${item}`, `${path}[${index}]`));
		else seen.add(item);
	});
}

export function validateDiagnosticArray(value: readonly unknown[], path: string, diagnostics: SubagentDiagnostic[]): void {
	value.forEach((item, index) => {
		if (!isRecord(item) || !["error", "warning", "info"].includes(String(item.level)) || typeof item.code !== "string" || typeof item.message !== "string") diagnostics.push(error("diagnostic.invalid", "Diagnostic requires level, code, and message.", `${path}[${index}]`));
	});
}

export function validateUsage(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (!isRecord(value)) {
		diagnostics.push(error("usage.type", "usage must be an object.", path));
		return;
	}
	if (value.tokens !== undefined) {
		if (!isRecord(value.tokens) || !isNonNegativeInteger(value.tokens.input) || !isNonNegativeInteger(value.tokens.output) || !isNonNegativeInteger(value.tokens.total)) diagnostics.push(error("usage.tokens", "Token usage values must be non-negative integers.", `${path}.tokens`));
		else if (value.tokens.total < value.tokens.input + value.tokens.output) diagnostics.push(error("usage.token-total", "Token total cannot be less than input + output.", `${path}.tokens.total`));
	}
	if (value.cost !== undefined && (!isRecord(value.cost) || !isNonNegativeFinite(value.cost.amount) || typeof value.cost.currency !== "string" || !/^[A-Z]{3}$/.test(value.cost.currency))) diagnostics.push(error("usage.cost", "Cost requires a non-negative amount and ISO 4217 currency code.", `${path}.cost`));
}

export function validateModelReference(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (!isRecord(value) || typeof value.provider !== "string" || !value.provider.trim() || typeof value.id !== "string" || !value.id.trim()) diagnostics.push(error("model.reference", "Model reference requires provider and id.", path));
}

export function validateOpaqueId(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) diagnostics.push(error("id.invalid", "Expected an opaque id using letters, numbers, dot, underscore, colon, or hyphen (max 128).", path));
}

export function validateNamespace(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (typeof value !== "string" || !NAMESPACE_PATTERN.test(value)) diagnostics.push(error("namespace.invalid", "Expected a namespace using letters, numbers, dot, underscore, or hyphen (max 128).", path));
}

export function validateFingerprint(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void {
	if (!isFingerprint(value)) diagnostics.push(error("fingerprint.invalid", "Expected sha256:v1 followed by 64 lowercase hex characters.", path));
}

export function isIsoDate(value: unknown): boolean {
	return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Remap a runtime-core diagnostic rooted at "$" onto the caller's path. */
function repath(diagnostics: readonly Diagnostic[], path: string): SubagentDiagnostic[] {
	return diagnostics.map((diagnostic) => {
		if (!diagnostic.path || !diagnostic.path.startsWith("$")) return diagnostic;
		return { ...diagnostic, path: `${path}${diagnostic.path.slice(1)}` };
	});
}
