import { posix } from "node:path";
import { subagentPromptRuntimeFingerprint } from "./canonical.js";
export const SUBAGENT_LIMIT_NAMES = ["timeoutMs", "maxTurns", "tokenBudget", "maxOutputBytes"];
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const FINGERPRINT_PATTERN = /^sha256:v1:[a-f0-9]{64}$/;
export function validateMediaReference(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("request.media-item", "Media reference must be an object.", path));
        return;
    }
    validateOpaqueId(value.id, `${path}.id`, diagnostics);
    if (value.kind !== "image")
        diagnostics.push(error("request.media-kind", "Only image media is supported in v1.", `${path}.kind`));
    if (typeof value.mimeType !== "string" || !/^image\/[A-Za-z0-9.+-]+$/.test(value.mimeType))
        diagnostics.push(error("request.media-mime", "mimeType must be an image MIME type.", `${path}.mimeType`));
    validateFingerprint(value.digest, `${path}.digest`, diagnostics);
    validateOpaqueId(value.resourceHandle, `${path}.resourceHandle`, diagnostics);
}
export function validateSelectedContext(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("context.type", "selectedContext must be an object.", path));
        return diagnostics;
    }
    if (!isPositiveInteger(value.maxBytes))
        diagnostics.push(error("context.max-bytes", "maxBytes must be a positive integer.", `${path}.maxBytes`));
    if (!Array.isArray(value.items)) {
        diagnostics.push(error("context.items", "items must be an array.", `${path}.items`));
        return diagnostics;
    }
    const ids = new Set();
    value.items.forEach((item, index) => {
        const itemPath = `${path}.items[${index}]`;
        if (!isRecord(item)) {
            diagnostics.push(error("context.item", "Context item must be an object.", itemPath));
            return;
        }
        validateOpaqueId(item.id, `${itemPath}.id`, diagnostics);
        if (typeof item.id === "string" && ids.has(item.id))
            diagnostics.push(error("context.duplicate-id", `Duplicate context item id: ${item.id}`, `${itemPath}.id`));
        if (typeof item.id === "string")
            ids.add(item.id);
        if (!["summary", "user-excerpt", "assistant-excerpt", "tool-result-excerpt", "resource-excerpt"].includes(String(item.kind)))
            diagnostics.push(error("context.kind", "Unsupported context item kind.", `${itemPath}.kind`));
        if (typeof item.text !== "string" || !item.text.trim())
            diagnostics.push(error("context.text", "Context item text must not be empty.", `${itemPath}.text`));
        if (item.required !== undefined && typeof item.required !== "boolean")
            diagnostics.push(error("context.required", "required must be boolean.", `${itemPath}.required`));
        if (!isRecord(item.provenance) || typeof item.provenance.source !== "string" || !item.provenance.source.trim())
            diagnostics.push(error("context.provenance", "Context item provenance.source is required.", `${itemPath}.provenance`));
    });
    return diagnostics;
}
export function validateAccessRequest(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("access.type", "access must be an object.", path));
        return;
    }
    if (!["none", "read-only", "workspace-write"].includes(String(value.level)))
        diagnostics.push(error("access.level", "Unsupported access level.", `${path}.level`));
    if (!Array.isArray(value.workspaces)) {
        diagnostics.push(error("access.workspaces", "workspaces must be an array.", `${path}.workspaces`));
        return;
    }
    const handles = new Set();
    let hasWritable = false;
    value.workspaces.forEach((workspace, index) => {
        if (!isRecord(workspace))
            return diagnostics.push(error("access.workspace", "Workspace must be an object.", `${path}.workspaces[${index}]`));
        validateOpaqueId(workspace.handle, `${path}.workspaces[${index}].handle`, diagnostics);
        if (typeof workspace.handle === "string" && handles.has(workspace.handle))
            diagnostics.push(error("access.duplicate-workspace", `Duplicate workspace handle: ${workspace.handle}`, `${path}.workspaces[${index}].handle`));
        if (typeof workspace.handle === "string")
            handles.add(workspace.handle);
        if (workspace.mode !== "read-only" && workspace.mode !== "read-write")
            diagnostics.push(error("access.workspace-mode", "Workspace mode must be read-only or read-write.", `${path}.workspaces[${index}].mode`));
        if (workspace.mode === "read-write")
            hasWritable = true;
    });
    if (value.level === "none" && value.workspaces.length > 0)
        diagnostics.push(error("access.none-workspaces", "Access none cannot include workspaces.", `${path}.workspaces`));
    if (value.level === "read-only" && hasWritable)
        diagnostics.push(error("access.read-only-write", "Read-only access cannot request a read-write workspace.", `${path}.workspaces`));
    if (value.level === "workspace-write" && !hasWritable)
        diagnostics.push(error("access.write-missing", "workspace-write requires at least one read-write workspace.", `${path}.workspaces`));
    if (value.network !== "deny" && value.network !== "allow")
        diagnostics.push(error("access.network", "network must be deny or allow.", `${path}.network`));
    if (value.allowProcess !== undefined && typeof value.allowProcess !== "boolean")
        diagnostics.push(error("access.process", "allowProcess must be boolean.", `${path}.allowProcess`));
    if (value.allowProcess === true && value.level !== "workspace-write")
        diagnostics.push(error("access.process-level", "Process access requires workspace-write.", `${path}.allowProcess`));
    if (value.workingDirectory !== undefined) {
        if (!isRecord(value.workingDirectory))
            diagnostics.push(error("access.cwd", "workingDirectory must be an object.", `${path}.workingDirectory`));
        else {
            if (!handles.has(String(value.workingDirectory.workspaceHandle)))
                diagnostics.push(error("access.cwd-workspace", "workingDirectory must reference a requested workspace.", `${path}.workingDirectory.workspaceHandle`));
            if (!isSafeRelativePath(value.workingDirectory.path, true))
                diagnostics.push(error("access.cwd-path", "workingDirectory.path must be a normalized relative POSIX path.", `${path}.workingDirectory.path`));
        }
    }
    if (value.level === "none" && value.workingDirectory !== undefined)
        diagnostics.push(error("access.none-cwd", "Access none cannot include a workingDirectory.", `${path}.workingDirectory`));
}
export function validateLimitRequest(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("limits.type", "limits must be an object.", path));
        return;
    }
    for (const [name, requirement] of Object.entries(value)) {
        if (!SUBAGENT_LIMIT_NAMES.includes(name)) {
            diagnostics.push(error("limits.unknown", `Unknown limit: ${name}`, `${path}.${name}`));
            continue;
        }
        if (!isRecord(requirement) || !isPositiveInteger(requirement.value) || !["required", "best-effort"].includes(String(requirement.enforcement))) {
            diagnostics.push(error("limits.requirement", `${name} must contain a positive integer value and required/best-effort enforcement.`, `${path}.${name}`));
        }
    }
}
export function validateBackendDescriptor(value, path, diagnostics) {
    validateOpaqueId(value.id, `${path}.id`, diagnostics);
    if (typeof value.version !== "string" || !value.version.trim())
        diagnostics.push(error("backend.version", "Backend version is required.", `${path}.version`));
    if (!isRecord(value.capabilities)) {
        diagnostics.push(error("backend.capabilities", "Backend capabilities are required.", `${path}.capabilities`));
        return;
    }
    const capabilities = value.capabilities;
    if (!isRecord(capabilities.access))
        diagnostics.push(error("backend.access-capabilities", "Access capabilities are required.", `${path}.capabilities.access`));
    else
        validateAccessCapabilities(capabilities.access, `${path}.capabilities.access`, diagnostics);
    if (!isRecord(capabilities.limits))
        diagnostics.push(error("backend.limit-capabilities", "Limit capabilities are required.", `${path}.capabilities.limits`));
    else {
        for (const name of SUBAGENT_LIMIT_NAMES) {
            const supported = capabilities.limits[name];
            if (!Array.isArray(supported) || supported.some((entry) => !["backend-hard", "host-abort", "best-effort", "unsupported"].includes(String(entry))))
                diagnostics.push(error("backend.limit-capability", `Invalid limit capability list for ${name}.`, `${path}.capabilities.limits.${name}`));
        }
    }
    for (const field of ["cancellation", "traceInspection", "artifactRetention", "remoteTransport"]) {
        if (typeof capabilities[field] !== "boolean")
            diagnostics.push(error("backend.boolean-capability", `${field} must be boolean.`, `${path}.capabilities.${field}`));
    }
    if (!Array.isArray(capabilities.mediaMimeTypes) || capabilities.mediaMimeTypes.some((mime) => typeof mime !== "string" || !mime.includes("/")))
        diagnostics.push(error("backend.media-capabilities", "mediaMimeTypes must be a MIME type array.", `${path}.capabilities.mediaMimeTypes`));
    if (!["exact-preflight", "backend-assisted", "partial"].includes(String(capabilities.promptRuntimeFidelity)))
        diagnostics.push(error("backend.prompt-fidelity", "Invalid promptRuntimeFidelity.", `${path}.capabilities.promptRuntimeFidelity`));
}
export function validateToolCatalog(value, diagnostics) {
    const ids = new Set();
    const names = new Set();
    value.forEach((tool, index) => {
        if (!isRecord(tool))
            return diagnostics.push(error("tools.catalog-entry", "Tool catalog entry must be an object.", `toolCatalog[${index}]`));
        validateOpaqueId(tool.id, `toolCatalog[${index}].id`, diagnostics);
        validateOpaqueId(tool.name, `toolCatalog[${index}].name`, diagnostics);
        if (typeof tool.id === "string" && ids.has(tool.id))
            diagnostics.push(error("tools.duplicate-id", `Duplicate tool id: ${tool.id}`, `toolCatalog[${index}].id`));
        if (typeof tool.name === "string" && names.has(tool.name))
            diagnostics.push(error("tools.duplicate-name", `Duplicate tool name: ${tool.name}`, `toolCatalog[${index}].name`));
        if (typeof tool.id === "string")
            ids.add(tool.id);
        if (typeof tool.name === "string")
            names.add(tool.name);
        if (!Array.isArray(tool.effects) || tool.effects.some((effect) => !["filesystem-read", "filesystem-write", "process", "network"].includes(String(effect))))
            diagnostics.push(error("tools.effects", "Tool effects must be a valid effect array.", `toolCatalog[${index}].effects`));
    });
}
export function validatePreparationRuntime(value, path, diagnostics, expectedFidelity) {
    if (!isRecord(value)) {
        diagnostics.push(error("runtime.type", "Prompt runtime must be an object.", path));
        return;
    }
    if (typeof value.baseSystemPrompt !== "string")
        diagnostics.push(error("runtime.base-prompt", "baseSystemPrompt must be a string.", `${path}.baseSystemPrompt`));
    validateModelReference(value.model, `${path}.model`, diagnostics);
    if (!isIsoDate(value.preparedAt))
        diagnostics.push(error("runtime.prepared-at", "preparedAt must be a canonical ISO timestamp.", `${path}.preparedAt`));
    if (value.fidelity !== "exact-preflight" && value.fidelity !== "backend-assisted")
        diagnostics.push(error("runtime.fidelity", "Runtime fidelity must be exact-preflight or backend-assisted.", `${path}.fidelity`));
    else if (expectedFidelity && value.fidelity !== expectedFidelity)
        diagnostics.push(error("runtime.fidelity-mismatch", `Runtime fidelity must be ${expectedFidelity}.`, `${path}.fidelity`));
    validateFingerprint(value.promptRuntimeFingerprint, `${path}.promptRuntimeFingerprint`, diagnostics);
    validatePromptRuntimeOptions(value.options, `${path}.options`, diagnostics);
    if (isFingerprint(value.promptRuntimeFingerprint)) {
        try {
            if (subagentPromptRuntimeFingerprint(value) !== value.promptRuntimeFingerprint) {
                diagnostics.push(error("runtime.fingerprint", "promptRuntimeFingerprint does not match the runtime snapshot.", `${path}.promptRuntimeFingerprint`));
            }
        }
        catch (fingerprintError) {
            diagnostics.push(error("runtime.fingerprint-input", fingerprintError instanceof Error ? fingerprintError.message : String(fingerprintError), `${path}.promptRuntimeFingerprint`));
        }
    }
}
function validatePromptRuntimeOptions(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("runtime.options", "Prompt runtime options must be an object.", path));
        return;
    }
    if (value.customPrompt !== undefined && typeof value.customPrompt !== "string")
        diagnostics.push(error("runtime.custom-prompt", "customPrompt must be a string.", `${path}.customPrompt`));
    if (value.appendSystemPrompt !== undefined && typeof value.appendSystemPrompt !== "string")
        diagnostics.push(error("runtime.append-prompt", "appendSystemPrompt must be a string.", `${path}.appendSystemPrompt`));
    if (typeof value.cwd !== "string" || !value.cwd.trim())
        diagnostics.push(error("runtime.cwd", "cwd must be a non-empty display path.", `${path}.cwd`));
    for (const field of ["selectedTools", "promptGuidelines"]) {
        if (!Array.isArray(value[field]))
            diagnostics.push(error("runtime.string-array", `${field} must be a string array.`, `${path}.${field}`));
        else
            validateUniqueStringArray(value[field], `${path}.${field}`, diagnostics);
    }
    if (!isRecord(value.toolSnippets) || Object.values(value.toolSnippets).some((entry) => typeof entry !== "string"))
        diagnostics.push(error("runtime.tool-snippets", "toolSnippets must map tool names to strings.", `${path}.toolSnippets`));
    if (!Array.isArray(value.contextFiles))
        diagnostics.push(error("runtime.context-files", "contextFiles must be an array.", `${path}.contextFiles`));
    else
        value.contextFiles.forEach((file, index) => {
            if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string")
                diagnostics.push(error("runtime.context-file", "Context files require path and content strings.", `${path}.contextFiles[${index}]`));
        });
    if (!Array.isArray(value.skills))
        diagnostics.push(error("runtime.skills", "skills must be an array.", `${path}.skills`));
    else
        value.skills.forEach((skill, index) => {
            if (!isRecord(skill)
                || typeof skill.name !== "string" || !skill.name.trim()
                || typeof skill.description !== "string"
                || typeof skill.filePath !== "string" || !skill.filePath.trim()
                || typeof skill.disableModelInvocation !== "boolean") {
                diagnostics.push(error("runtime.skill", "Skills require name, description, filePath, and disableModelInvocation.", `${path}.skills[${index}]`));
            }
        });
}
export function validateAccessReceipt(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("access-receipt.type", "Access receipt must be an object.", path));
        return;
    }
    if (!["none", "read-only", "workspace-write"].includes(String(value.level)))
        diagnostics.push(error("access-receipt.level", "Invalid access receipt level.", `${path}.level`));
    if (!Array.isArray(value.mounts))
        diagnostics.push(error("access-receipt.mounts", "Access receipt mounts must be an array.", `${path}.mounts`));
    else {
        const handles = new Set();
        const mountIds = new Set();
        value.mounts.forEach((mount, index) => {
            if (!isRecord(mount))
                return diagnostics.push(error("access-receipt.mount", "Mount mapping must be an object.", `${path}.mounts[${index}]`));
            validateOpaqueId(mount.workspaceHandle, `${path}.mounts[${index}].workspaceHandle`, diagnostics);
            validateOpaqueId(mount.mountId, `${path}.mounts[${index}].mountId`, diagnostics);
            if (mount.mode !== "read-only" && mount.mode !== "read-write")
                diagnostics.push(error("access-receipt.mount-mode", "Mount mode must be read-only or read-write.", `${path}.mounts[${index}].mode`));
            if (typeof mount.workspaceHandle === "string" && handles.has(mount.workspaceHandle))
                diagnostics.push(error("access-receipt.duplicate-workspace", `Duplicate workspace mapping: ${mount.workspaceHandle}`, `${path}.mounts[${index}].workspaceHandle`));
            if (typeof mount.mountId === "string" && mountIds.has(mount.mountId))
                diagnostics.push(error("access-receipt.duplicate-mount", `Duplicate mount id: ${mount.mountId}`, `${path}.mounts[${index}].mountId`));
            if (typeof mount.workspaceHandle === "string")
                handles.add(mount.workspaceHandle);
            if (typeof mount.mountId === "string")
                mountIds.add(mount.mountId);
        });
        if (value.level === "none" && value.mounts.length > 0)
            diagnostics.push(error("access-receipt.none-mounts", "Access none cannot produce mount mappings.", `${path}.mounts`));
        if (value.level === "read-only" && value.mounts.some((mount) => isRecord(mount) && mount.mode === "read-write"))
            diagnostics.push(error("access-receipt.read-only-write", "Read-only access cannot produce a read-write mount.", `${path}.mounts`));
        if (value.level === "workspace-write" && !value.mounts.some((mount) => isRecord(mount) && mount.mode === "read-write"))
            diagnostics.push(error("access-receipt.write-missing", "workspace-write receipt requires a read-write mount.", `${path}.mounts`));
        if (value.workingDirectory !== undefined) {
            if (!isRecord(value.workingDirectory))
                diagnostics.push(error("access-receipt.cwd", "workingDirectory must be an object.", `${path}.workingDirectory`));
            else {
                if (!mountIds.has(String(value.workingDirectory.mountId)))
                    diagnostics.push(error("access-receipt.cwd-mount", "workingDirectory must reference a receipt mount.", `${path}.workingDirectory.mountId`));
                if (!isSafeRelativePath(value.workingDirectory.path, true))
                    diagnostics.push(error("access-receipt.cwd-path", "workingDirectory path must be normalized and relative.", `${path}.workingDirectory.path`));
            }
        }
    }
    if (value.network !== "deny" && value.network !== "allow")
        diagnostics.push(error("access-receipt.network", "Invalid access receipt network policy.", `${path}.network`));
    if (typeof value.process !== "boolean")
        diagnostics.push(error("access-receipt.process", "Access receipt process must be boolean.", `${path}.process`));
    if (value.process === true && value.level !== "workspace-write")
        diagnostics.push(error("access-receipt.process-level", "Process access requires workspace-write.", `${path}.process`));
    if (!isRecord(value.enforcement))
        diagnostics.push(error("access-receipt.enforcement", "Access enforcement receipt is required.", `${path}.enforcement`));
    else {
        validateAccessCapabilities(value.enforcement, `${path}.enforcement`, diagnostics);
        if (value.level === "read-only" && (!value.enforcement.readOnlyMountIsolation || !value.enforcement.symlinkSafeContainment))
            diagnostics.push(error("access-receipt.read-isolation", "Read-only receipt requires mount isolation and symlink-safe containment.", `${path}.enforcement`));
        if (value.level === "workspace-write" && (!value.enforcement.readWriteMountIsolation || !value.enforcement.symlinkSafeContainment))
            diagnostics.push(error("access-receipt.write-isolation", "Workspace-write receipt requires write isolation and symlink-safe containment.", `${path}.enforcement`));
        if (value.process === true && !value.enforcement.processIsolation)
            diagnostics.push(error("access-receipt.process-isolation", "Process receipt requires process isolation.", `${path}.enforcement.processIsolation`));
        if (value.network === "deny" && !value.enforcement.agentNetworkIsolation)
            diagnostics.push(error("access-receipt.network-isolation", "Denied network receipt requires agent network isolation.", `${path}.enforcement.agentNetworkIsolation`));
    }
    if (value.level === "none" && value.workingDirectory !== undefined)
        diagnostics.push(error("access-receipt.none-cwd", "Access none cannot produce a workingDirectory.", `${path}.workingDirectory`));
}
export function validateAccessCapabilities(value, path, diagnostics) {
    for (const field of [
        "readOnlyMountIsolation", "readWriteMountIsolation", "symlinkSafeContainment", "processIsolation", "agentNetworkIsolation",
    ]) {
        if (typeof value[field] !== "boolean")
            diagnostics.push(error("access-capability.boolean", `${field} must be boolean.`, `${path}.${field}`));
    }
}
export function validateLimitReceipt(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("limit-receipt.type", "Limit receipt must be an object.", path));
        return;
    }
    for (const [name, receipt] of Object.entries(value)) {
        if (!SUBAGENT_LIMIT_NAMES.includes(name) || !isRecord(receipt) || !isPositiveInteger(receipt.value) || !["backend-hard", "host-abort", "best-effort"].includes(String(receipt.enforcement))) {
            diagnostics.push(error("limit-receipt.entry", `Invalid enforced limit receipt: ${name}`, `${path}.${name}`));
        }
    }
}
export function validateAccessEnforcement(request, receipt) {
    const diagnostics = [];
    if (receipt.level !== request.level)
        diagnostics.push(error("preflight.access-level", "Access receipt level does not match request.", "access.level"));
    if (receipt.network !== request.network)
        diagnostics.push(error("preflight.network", "Access receipt network policy does not match request.", "access.network"));
    if (receipt.process !== (request.allowProcess === true))
        diagnostics.push(error("preflight.process", "Access receipt process policy does not match request.", "access.process"));
    if (request.level === "read-only" && (!receipt.enforcement.readOnlyMountIsolation || !receipt.enforcement.symlinkSafeContainment))
        diagnostics.push(error("preflight.read-isolation", "Read-only access requires mount isolation and symlink-safe containment.", "access.enforcement"));
    if (request.level === "workspace-write" && (!receipt.enforcement.readWriteMountIsolation || !receipt.enforcement.symlinkSafeContainment))
        diagnostics.push(error("preflight.write-isolation", "Workspace-write access requires write isolation and symlink-safe containment.", "access.enforcement"));
    if (request.allowProcess && !receipt.enforcement.processIsolation)
        diagnostics.push(error("preflight.process-isolation", "Process access requires process isolation.", "access.enforcement.processIsolation"));
    if (request.network === "deny" && !receipt.enforcement.agentNetworkIsolation)
        diagnostics.push(error("preflight.network-isolation", "Denied agent network requires network isolation.", "access.enforcement.agentNetworkIsolation"));
    const mapped = new Map(receipt.mounts.map((mount) => [mount.workspaceHandle, mount]));
    for (const workspace of request.workspaces) {
        const mount = mapped.get(workspace.handle);
        if (!mount)
            diagnostics.push(error("preflight.mount-missing", `Missing mount mapping for ${workspace.handle}.`, "access.mounts"));
        else if (mount.mode !== workspace.mode)
            diagnostics.push(error("preflight.mount-mode", `Mount mode mismatch for ${workspace.handle}.`, "access.mounts"));
    }
    for (const mount of receipt.mounts) {
        if (!request.workspaces.some((workspace) => workspace.handle === mount.workspaceHandle))
            diagnostics.push(error("preflight.mount-extra", `Unexpected mount mapping for ${mount.workspaceHandle}.`, "access.mounts"));
    }
    if (request.workingDirectory) {
        const requestedMount = mapped.get(request.workingDirectory.workspaceHandle);
        if (!receipt.workingDirectory || receipt.workingDirectory.mountId !== requestedMount?.mountId || receipt.workingDirectory.path !== request.workingDirectory.path)
            diagnostics.push(error("preflight.cwd", "Working-directory receipt does not match the request.", "access.workingDirectory"));
    }
    else if (receipt.workingDirectory) {
        diagnostics.push(error("preflight.cwd-extra", "Backend produced an unrequested working directory.", "access.workingDirectory"));
    }
    return diagnostics;
}
export function validatePreparedMessage(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("plan.message", "Prepared message must be an object.", path));
        return;
    }
    if (!["user", "assistant", "custom"].includes(String(value.role)))
        diagnostics.push(error("plan.message-role", "Unsupported prepared message role.", `${path}.role`));
    if (!Array.isArray(value.content) || value.content.length === 0) {
        diagnostics.push(error("plan.message-content", "Prepared message content must be a non-empty array.", `${path}.content`));
        return;
    }
    value.content.forEach((part, index) => {
        if (!isRecord(part))
            return diagnostics.push(error("plan.content-part", "Content part must be an object.", `${path}.content[${index}]`));
        if (part.type === "text") {
            if (typeof part.text !== "string")
                diagnostics.push(error("plan.text-part", "Text content requires text.", `${path}.content[${index}].text`));
        }
        else if (part.type === "media") {
            validateOpaqueId(part.mediaId, `${path}.content[${index}].mediaId`, diagnostics);
            if (typeof part.mimeType !== "string" || !part.mimeType.includes("/"))
                diagnostics.push(error("plan.media-mime", "Media content requires mimeType.", `${path}.content[${index}].mimeType`));
            validateFingerprint(part.digest, `${path}.content[${index}].digest`, diagnostics);
            if (part.backendResourceId !== undefined)
                validateOpaqueId(part.backendResourceId, `${path}.content[${index}].backendResourceId`, diagnostics);
        }
        else
            diagnostics.push(error("plan.content-type", "Unsupported prepared content part type.", `${path}.content[${index}].type`));
    });
    if (value.protectedTask !== undefined && typeof value.protectedTask !== "boolean")
        diagnostics.push(error("plan.protected-flag", "protectedTask must be boolean.", `${path}.protectedTask`));
}
export function validateContextBudgetReceipt(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("context-receipt.type", "Context budget receipt must be an object.", path));
        return;
    }
    if (!isPositiveInteger(value.maxBytes))
        diagnostics.push(error("context-receipt.max", "maxBytes must be a positive integer.", `${path}.maxBytes`));
    if (!isNonNegativeInteger(value.includedBytes) || (isPositiveInteger(value.maxBytes) && value.includedBytes > value.maxBytes))
        diagnostics.push(error("context-receipt.bytes", "includedBytes must be non-negative and no greater than maxBytes.", `${path}.includedBytes`));
    for (const field of ["includedItemIds", "omittedItemIds"]) {
        if (!Array.isArray(value[field]))
            diagnostics.push(error("context-receipt.ids", `${field} must be an array.`, `${path}.${field}`));
        else
            validateUniqueStringArray(value[field], `${path}.${field}`, diagnostics);
    }
}
export function validateUniqueStringArray(value, path, diagnostics) {
    const seen = new Set();
    value.forEach((item, index) => {
        if (typeof item !== "string")
            diagnostics.push(error("array.string", "Expected a string.", `${path}[${index}]`));
        else if (seen.has(item))
            diagnostics.push(error("array.duplicate", `Duplicate value: ${item}`, `${path}[${index}]`));
        else
            seen.add(item);
    });
}
export function validateDiagnosticArray(value, path, diagnostics) {
    value.forEach((item, index) => {
        if (!isRecord(item) || !["error", "warning", "info"].includes(String(item.level)) || typeof item.code !== "string" || typeof item.message !== "string")
            diagnostics.push(error("diagnostic.invalid", "Diagnostic requires level, code, and message.", `${path}[${index}]`));
    });
}
export function validateUsage(value, path, diagnostics) {
    if (!isRecord(value)) {
        diagnostics.push(error("usage.type", "usage must be an object.", path));
        return;
    }
    if (value.tokens !== undefined) {
        if (!isRecord(value.tokens) || !isNonNegativeInteger(value.tokens.input) || !isNonNegativeInteger(value.tokens.output) || !isNonNegativeInteger(value.tokens.total))
            diagnostics.push(error("usage.tokens", "Token usage values must be non-negative integers.", `${path}.tokens`));
        else if (value.tokens.total < value.tokens.input + value.tokens.output)
            diagnostics.push(error("usage.token-total", "Token total cannot be less than input + output.", `${path}.tokens.total`));
    }
    if (value.cost !== undefined && (!isRecord(value.cost) || !isNonNegativeFinite(value.cost.amount) || typeof value.cost.currency !== "string" || !/^[A-Z]{3}$/.test(value.cost.currency)))
        diagnostics.push(error("usage.cost", "Cost requires a non-negative amount and ISO 4217 currency code.", `${path}.cost`));
}
export function validateModelReference(value, path, diagnostics) {
    if (!isRecord(value) || typeof value.provider !== "string" || !value.provider.trim() || typeof value.id !== "string" || !value.id.trim())
        diagnostics.push(error("model.reference", "Model reference requires provider and id.", path));
}
export function validateOpaqueId(value, path, diagnostics) {
    if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value))
        diagnostics.push(error("id.invalid", "Expected an opaque id using letters, numbers, dot, underscore, colon, or hyphen (max 128).", path));
}
export function validateNamespace(value, path, diagnostics) {
    if (typeof value !== "string" || !NAMESPACE_PATTERN.test(value))
        diagnostics.push(error("namespace.invalid", "Expected a namespace using letters, numbers, dot, underscore, or hyphen (max 128).", path));
}
export function validateFingerprint(value, path, diagnostics) {
    if (!isFingerprint(value))
        diagnostics.push(error("fingerprint.invalid", "Expected sha256:v1 followed by 64 lowercase hex characters.", path));
}
export function isFingerprint(value) {
    return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}
export function isSafeRelativePath(value, allowDot = false) {
    if (typeof value !== "string" || value.includes("\\") || value.startsWith("/") || value.includes("\0"))
        return false;
    if (allowDot && value === ".")
        return true;
    if (!value || posix.normalize(value) !== value)
        return false;
    return value.split("/").every((segment) => segment !== "." && segment !== "..");
}
export function isIsoDate(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
export function isPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}
export function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
export function isNonNegativeFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function hasErrors(diagnostics) {
    return diagnostics.some((diagnostic) => diagnostic.level === "error");
}
export function error(code, message, path) {
    return { level: "error", code, message, path };
}
//# sourceMappingURL=validation.js.map