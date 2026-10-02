import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PI_PACKAGES = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
];

/** Packed compatibility lanes target concrete stable releases, not npm ranges/tags. */
export function validateExactVersion(name: string, version: unknown): string {
	if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
		throw new Error(`${name} must be an exact stable release version, got ${JSON.stringify(version)}`);
	}
	return version;
}

function installedManifest(rootDir: string, name: string) {
	return JSON.parse(readFileSync(join(rootDir, "node_modules", name, "package.json"), "utf8"));
}

/** Fail on mixed/missing SDK installations instead of silently testing another version. */
export function resolveHostFamilyVersion(rootDir: string): string {
	const versions = PI_PACKAGES.map((name) => validateExactVersion(name, installedManifest(rootDir, name).version));
	if (!versions.every((version) => version === versions[0])) {
		throw new Error(`Incoherent installed Pi family: ${PI_PACKAGES.map((name, i) => `${name}@${versions[i]}`).join(", ")}`);
	}
	return versions[0];
}

export function resolveTypeboxVersion(rootDir: string): string {
	// Use the host's declaration, not an unrelated root TypeBox or dev pin. If upstream
	// switches to a range, require an explicit tested version rather than strip the range.
	return validateExactVersion("Host typebox dependency (or set TYPEBOX_TEST_VERSION)",
		installedManifest(rootDir, "@earendil-works/pi-coding-agent").dependencies?.typebox);
}

export function resolveTestVersions(rootDir: string, env: Record<string, string | undefined> = process.env) {
	const piVersion = env.PI_TEST_VERSION === undefined
		? resolveHostFamilyVersion(rootDir)
		: validateExactVersion("PI_TEST_VERSION", env.PI_TEST_VERSION);
	if (env.TYPEBOX_TEST_VERSION !== undefined) {
		return { piVersion, typeboxVersion: validateExactVersion("TYPEBOX_TEST_VERSION", env.TYPEBOX_TEST_VERSION) };
	}
	if (piVersion !== resolveHostFamilyVersion(rootDir)) {
		throw new Error("Set TYPEBOX_TEST_VERSION when PI_TEST_VERSION differs from the installed Pi family");
	}
	return { piVersion, typeboxVersion: resolveTypeboxVersion(rootDir) };
}
