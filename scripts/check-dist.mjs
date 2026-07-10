import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist");
const temporaryDistDir = mkdtempSync(join(rootDir, ".dist-check-"));

try {
	const tscPath = join(rootDir, "node_modules", "typescript", "bin", "tsc");
	const build = spawnSync(
		process.execPath,
		[tscPath, "-p", join(rootDir, "tsconfig.build.json"), "--outDir", temporaryDistDir],
		{ cwd: rootDir, stdio: "inherit" },
	);

	if (build.error) throw build.error;
	if (build.status !== 0) throw new Error(`TypeScript build failed with exit code ${build.status ?? 1}.`);

	const committedFiles = collectFiles(distDir);
	const generatedFiles = collectFiles(temporaryDistDir);
	const paths = [...new Set([...committedFiles.keys(), ...generatedFiles.keys()])].sort();
	const differences = [];

	for (const path of paths) {
		const committed = committedFiles.get(path);
		const generated = generatedFiles.get(path);
		if (!committed) differences.push(`missing from dist: ${path}`);
		else if (!generated) differences.push(`stale in dist: ${path}`);
		else if (!committed.equals(generated)) differences.push(`content differs: ${path}`);
	}

	if (differences.length > 0) {
		console.error("dist/ is not synchronized with src/:");
		for (const difference of differences) console.error(`  - ${difference}`);
		console.error("Run npm run build, review the generated changes, and commit dist/ with src/.");
		process.exitCode = 1;
	} else {
		console.log(`dist/ is synchronized with src/ (${generatedFiles.size} generated files).`);
	}
} finally {
	rmSync(temporaryDistDir, { recursive: true, force: true });
}

function collectFiles(directory) {
	const files = new Map();
	collect(directory, directory, files);
	return files;
}

function collect(directory, baseDirectory, files) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			collect(absolutePath, baseDirectory, files);
			continue;
		}
		if (!entry.isFile()) throw new Error(`Unsupported generated entry: ${absolutePath}`);
		files.set(relative(baseDirectory, absolutePath), readFileSync(absolutePath));
	}
}
