import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	createCapabilityFault,
	isUsableCapability,
	parseCapability,
	serializeCapability,
	type Capability,
	type LoadedCapability,
} from "../codecs/capability.ts";
import { isValidResourceId, type ResourceScope } from "../resource-identity.ts";
import { globalForgeDir } from "../storage.ts";

export { type Capability, type LoadedCapability };

export type CapabilityMutationResult =
	| { ok: true }
	| { ok: false; reason: "invalid-path" | "invalid-capability" | "conflict" | "io-error"; error: string };

export type CapabilityWriteResult = CapabilityMutationResult;
export type CapabilityDeleteResult = CapabilityMutationResult;

export const MAX_CAPABILITY_SOURCE_SIZE = 1024 * 1024; // 1 MiB

export function globalCapabilitiesDir(): string {
	return join(globalForgeDir(), "capabilities");
}

export function capabilitiesDir(cwd: string): string {
	return join(cwd, ".pi", "forge", "capabilities");
}

/**
 * Read global capabilities.
 * Returns empty array if directory does not exist (ENOENT).
 * Throws on real directory read errors (e.g. permission denied) to fail closed.
 */
export function readGlobalCapabilities(
	globalDir: string = globalCapabilitiesDir(),
): LoadedCapability[] {
	const capabilities = loadCapabilitiesFromDir(globalDir, "global");
	annotateDuplicateCapabilityIds(capabilities);
	return capabilities;
}

/**
 * Read scoped capabilities (global and project).
 * Returns empty array for missing directory (ENOENT); throws on real directory read errors.
 * Preserves faults for shadowed resolution and attaches errors to same-scope duplicate IDs.
 */
export function readCapabilitiesScoped(
	cwd: string,
	globalDir: string = globalCapabilitiesDir(),
): LoadedCapability[] {
	const capabilities = [
		...loadCapabilitiesFromDir(globalDir, "global"),
		...loadCapabilitiesFromDir(capabilitiesDir(cwd), "project"),
	];
	annotateDuplicateCapabilityIds(capabilities);
	return capabilities;
}

/**
 * Read a single capability file.
 * Returns a LoadedCapability fault if reading or parsing fails, or if file exceeds 1MiB.
 */
export function readSingleCapabilityFile(
	filePath: string,
	scope: ResourceScope = "project",
): LoadedCapability {
	let source: string;
	let sourceRevision: string;
	try {
		const stat = statSync(filePath);
		if (stat.size > MAX_CAPABILITY_SOURCE_SIZE) {
			return createCapabilityFault(
				filePath,
				scope,
				`Capability capability file size (${stat.size} bytes) exceeds 1MiB limit.`,
			);
		}
		const buf = readFileSync(filePath);
		if (buf.byteLength > MAX_CAPABILITY_SOURCE_SIZE) {
			return createCapabilityFault(
				filePath,
				scope,
				`Capability capability file size (${buf.byteLength} bytes) exceeds 1MiB limit.`,
			);
		}
		source = buf.toString("utf8");
		sourceRevision = createHash("sha256").update(buf).digest("hex");
	} catch (error) {
		return createCapabilityFault(
			filePath,
			scope,
			`Failed to read capability: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { ...parseCapability(source, filePath, scope), sourceRevision };
}

function loadCapabilitiesFromDir(
	dir: string,
	scope: ResourceScope,
): LoadedCapability[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error: unknown) {
		const err = error as { code?: string; message?: string };
		if (err && (err.code === "ENOENT" || (typeof err.message === "string" && err.message.includes("ENOENT")))) {
			return [];
		}
		throw error instanceof Error ? error : new Error(String(error));
	}

	const fileNames: string[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) continue;
		if (entry.isSymbolicLink()) {
			try {
				if (!statSync(join(dir, entry.name)).isFile()) continue;
			} catch {
				// Retain broken symlinks so read will record a fault
			}
		} else if (!entry.isFile()) {
			continue;
		}
		fileNames.push(entry.name);
	}
	fileNames.sort();

	return fileNames.map((name) => readSingleCapabilityFile(join(dir, name), scope));
}

function annotateDuplicateCapabilityIds(capabilities: LoadedCapability[]): void {
	const byScopeId = new Map<string, LoadedCapability[]>();
	for (const loaded of capabilities) {
		const key = `${loaded.scope}\0${loaded.capability.id}`;
		const matches = byScopeId.get(key) ?? [];
		matches.push(loaded);
		byScopeId.set(key, matches);
	}
	for (const matches of byScopeId.values()) {
		if (matches.length <= 1) continue;
		const files = matches.map((loaded) => basename(loaded.filePath)).join(", ");
		for (const loaded of matches) {
			loaded.diagnostics.push({
				level: "error",
				message: `Duplicate ${loaded.scope} capability id: "${loaded.capability.id}" appears in multiple files (${files}).`,
			});
		}
	}
}

/**
 * Compute the sha256 revision hash of raw capability file bytes.
 * Throws ENOENT if missing or an Error if size exceeds 1MiB limit.
 */
export function capabilityRevision(filePath: string): string {
	const stat = statSync(filePath);
	if (!stat.isFile()) {
		throw new Error(`Expected a regular file at ${filePath}`);
	}
	if (stat.size > MAX_CAPABILITY_SOURCE_SIZE) {
		throw new Error(`Capability capability file size (${stat.size} bytes) exceeds 1MiB limit.`);
	}
	const buf = readFileSync(filePath);
	if (buf.byteLength > MAX_CAPABILITY_SOURCE_SIZE) {
		throw new Error(`Capability capability file size (${buf.byteLength} bytes) exceeds 1MiB limit.`);
	}
	return createHash("sha256").update(buf).digest("hex");
}

function pathTraversesNoSymlink(anchor: string, target: string): boolean {
	const resolvedAnchor = resolve(anchor);
	const resolvedTarget = resolve(target);
	const rel = relative(resolvedAnchor, resolvedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) return false;
	try {
		if (lstatSync(resolvedAnchor).isSymbolicLink()) return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		// anchor does not exist yet
	}
	let current = resolvedAnchor;
	for (const segment of rel.split(sep)) {
		if (!segment || segment === ".") continue;
		current = join(current, segment);
		try {
			if (lstatSync(current).isSymbolicLink()) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
			// segment does not exist yet
		}
	}
	return true;
}

function verifyCapabilityPath(
	cwd: string,
	scope: ResourceScope,
	filePath: string,
	expectedId?: string,
): { ok: true; rootDir: string; fileName: string } | { ok: false; reason: "invalid-path"; error: string } {
	if (scope !== "project" && scope !== "global") {
		return { ok: false, reason: "invalid-path", error: `Invalid scope: ${String(scope)}` };
	}
	if (!filePath || typeof filePath !== "string") {
		return { ok: false, reason: "invalid-path", error: "File path is required." };
	}

	const rootDir = resolve(scope === "global" ? globalCapabilitiesDir() : capabilitiesDir(cwd));
	const anchor = resolve(scope === "global" ? globalForgeDir() : cwd);
	const resolvedTarget = resolve(filePath);

	if (dirname(resolvedTarget) !== rootDir) {
		return { ok: false, reason: "invalid-path", error: `Path is outside ${scope} root (${rootDir}): ${filePath}` };
	}
	const fileName = basename(resolvedTarget);
	if (!fileName.endsWith(".json") || fileName.startsWith(".")) {
		return { ok: false, reason: "invalid-path", error: `File must be a non-hidden .json file: ${fileName}` };
	}
	const id = basename(fileName, ".json");
	if (!isValidResourceId(id) || (expectedId !== undefined && expectedId !== id)) {
		return { ok: false, reason: "invalid-path", error: `Invalid ID or rename mismatch: ${fileName}` };
	}
	if (!pathTraversesNoSymlink(anchor, resolvedTarget)) {
		return { ok: false, reason: "invalid-path", error: `Path traverses or targets a symlink: ${filePath}` };
	}
	try {
		if (lstatSync(resolvedTarget).isDirectory()) {
			return { ok: false, reason: "invalid-path", error: `Path is a directory: ${filePath}` };
		}
	} catch {
		// Target does not exist yet
	}
	return { ok: true, rootDir, fileName };
}

function checkExpectedRevision(filePath: string, expected?: string): CapabilityMutationResult | null {
	if (!expected) return { ok: false, reason: "conflict", error: "expectedSourceRevision is required." };
	if (!existsSync(filePath)) return { ok: false, reason: "conflict", error: `File does not exist: ${filePath}` };
	try {
		const current = capabilityRevision(filePath);
		if (current !== expected) {
			return { ok: false, reason: "conflict", error: `Revision conflict: expected ${expected}, got ${current}.` };
		}
	} catch (err: any) {
		if (err?.code === "ENOENT") return { ok: false, reason: "conflict", error: `File does not exist: ${filePath}` };
		return { ok: false, reason: "io-error", error: `Failed to read revision: ${err instanceof Error ? err.message : String(err)}` };
	}
	return null;
}

/**
 * Write a capability file.
 * Creates exclusively with "wx" when overwrite is false.
 * Updates atomically with expectedSourceRevision check when overwrite is true.
 */
export function writeCapabilityFile(
	cwd: string,
	scope: ResourceScope,
	filePath: string,
	capability: Capability,
	options: { overwrite: boolean; expectedSourceRevision?: string },
): CapabilityWriteResult {
	const pathCheck = verifyCapabilityPath(cwd, scope, filePath, capability?.id);
	if (!pathCheck.ok) return pathCheck;

	let serialized: string;
	try {
		serialized = serializeCapability(capability);
	} catch (error) {
		return { ok: false, reason: "invalid-capability", error: `Failed to serialize capability: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (Buffer.byteLength(serialized, "utf8") > MAX_CAPABILITY_SOURCE_SIZE) {
		return { ok: false, reason: "invalid-capability", error: "Capability capability file size exceeds 1MiB limit." };
	}
	const parsed = parseCapability(serialized, filePath, scope);
	if (!isUsableCapability(parsed)) {
		const msg = parsed.diagnostics.filter((d) => d.level === "error").map((d) => d.message).join("; ");
		return { ok: false, reason: "invalid-capability", error: msg || "Invalid capability." };
	}

	const { rootDir, fileName } = pathCheck;
	if (!options.overwrite) {
		if (existsSync(filePath)) return { ok: false, reason: "conflict", error: `Capability capability already exists: ${filePath}` };
		try {
			mkdirSync(rootDir, { recursive: true });
			writeFileSync(filePath, serialized, { encoding: "utf8", flag: "wx" });
			return { ok: true };
		} catch (error: any) {
			if (error?.code === "EEXIST") return { ok: false, reason: "conflict", error: `Capability capability already exists: ${filePath}` };
			return { ok: false, reason: "io-error", error: `Failed to write capability: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	const revConflict = checkExpectedRevision(filePath, options.expectedSourceRevision);
	if (revConflict) return revConflict;

	const tempPath = join(rootDir, `.${fileName}.${randomUUID()}.tmp`);
	try {
		mkdirSync(rootDir, { recursive: true });
		writeFileSync(tempPath, serialized, "utf8");
		renameSync(tempPath, filePath);
		return { ok: true };
	} catch (error) {
		try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
		return { ok: false, reason: "io-error", error: `Failed to write capability: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Delete a capability file with expectedSourceRevision check.
 */
export function deleteCapabilityFile(
	cwd: string,
	scope: ResourceScope,
	filePath: string,
	options: { expectedSourceRevision: string },
): CapabilityDeleteResult {
	const pathCheck = verifyCapabilityPath(cwd, scope, filePath);
	if (!pathCheck.ok) return pathCheck;

	const revConflict = checkExpectedRevision(filePath, options?.expectedSourceRevision);
	if (revConflict) return revConflict;

	try {
		unlinkSync(filePath);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: "io-error", error: `Failed to delete capability: ${error instanceof Error ? error.message : String(error)}` };
	}
}
