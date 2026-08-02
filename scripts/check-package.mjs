import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
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

for (const key of ["./src/*.ts", "./src/*.js", "./src/*"]) {
	const entry = packageJson.exports?.[key];
	if (!entry || Object.values(entry).some((target) => typeof target !== "string" || !target.startsWith("./dist/"))) {
		failures.push(`legacy compatibility export must resolve only to dist: ${key}`);
	}
}

if (packageJson.exports?.["./src/web-editor/client/*"] !== null) {
	failures.push("browser-only authored client modules must be explicitly blocked from compatibility imports");
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
