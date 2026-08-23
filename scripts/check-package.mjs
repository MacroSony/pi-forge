import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmPrefix = npmCli ? [npmCli] : [];
const packed = spawnSync(npmCommand, [...npmPrefix, "pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: rootDir,
	encoding: "utf8",
});

if (packed.error) throw packed.error;
if (packed.status !== 0) {
	process.stderr.write(packed.stderr);
	throw new Error(`npm pack --dry-run failed with exit code ${packed.status ?? 1}.`);
}

const [manifest] = JSON.parse(packed.stdout);
const paths = new Set(manifest.files.map((file) => file.path));
const failures = [];

for (const required of [
	"dist/index.js",
	"dist/index.d.ts",
	"dist/subagent/index.js",
	"dist/subagent/index.d.ts",
	"dist/ui-contribution/index.js",
	"dist/ui-contribution/index.d.ts",
	"docs/README.md",
	"docs/development/release.md",
	"docs/reference/commands.md",
]) {
	if (!paths.has(required)) failures.push(`missing required package entry: ${required}`);
}

const hostDependencies = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];
for (const dependency of hostDependencies) {
	if (packageJson.peerDependencies?.[dependency] !== "*") {
		failures.push(`host dependency must be a wildcard peer: ${dependency}`);
	}
	if (packageJson.peerDependenciesMeta?.[dependency]?.optional !== true) {
		failures.push(`host dependency peer must be optional: ${dependency}`);
	}
	if (packageJson.dependencies?.[dependency] !== undefined) {
		failures.push(`host dependency must not be privately installed: ${dependency}`);
	}
}

for (const path of paths) {
	if (path === "src" || path.startsWith("src/")) failures.push(`authored source leaked into npm tarball: ${path}`);
}

// 0.5.1 public surface: the package root, the /subagent host port, and the
// generic UI contribution port used by optional packages.
const allowedExportKeys = [".", "./subagent", "./ui-contribution"];
const exportKeys = Object.keys(packageJson.exports ?? {});
for (const key of exportKeys) {
	if (!allowedExportKeys.includes(key)) {
		failures.push(`non-allowlisted package export: ${key} (allowed: ${allowedExportKeys.join(", ")})`);
	}
}
for (const key of allowedExportKeys) {
	const entry = packageJson.exports?.[key];
	if (!entry) {
		failures.push(`missing intentional package export: ${key}`);
		continue;
	}
	// Every allowlisted entry must resolve to files that actually ship, and
	// carry exactly the intentional conditions with types first.
	const conditions = Object.keys(entry);
	if (conditions.join(",") !== "types,import,default") {
		failures.push(`export ${key} must carry exactly the conditions types,import,default (in order): got ${conditions.join(",")}`);
	}
	for (const condition of conditions) {
		if (!["types", "import", "default"].includes(condition)) {
			failures.push(`unexpected export condition on ${key}: ${condition}`);
		}
		const target = entry[condition];
		if (typeof target !== "string" || !target.startsWith("./dist/")) {
			failures.push(`export ${key} (${condition}) must target ./dist/: ${String(target)}`);
		} else if (!paths.has(target.slice(2))) {
			failures.push(`export ${key} (${condition}) target is not in the tarball: ${target}`);
		}
	}
}
for (const key of ["./src/*.ts", "./src/*.js", "./src/*", "./src/web-editor/client/*", "./examples/*"]) {
	if (key in (packageJson.exports ?? {})) {
		failures.push(`legacy compatibility export must not exist: ${key}`);
	}
}

for (const path of paths) {
	if (path.startsWith("dist/web-editor/client/")) {
		failures.push(`browser-only authored client module leaked into npm tarball: ${path}`);
	}
}

if (failures.length > 0) {
	console.error("npm package layout is invalid:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log(
		`npm package uses host-provided Pi peers and compiled runtime entries (${paths.size} files; docs included; no physical src/ entries).`,
	);
}
