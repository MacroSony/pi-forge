import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const optionalRoot = process.env.PI_FORGE_SUBAGENTS_ROOT ?? resolve(rootDir, "../pi-forge-subagents");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, opts = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...opts });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
	}
	return result.stdout;
}

function packInto(cwd, into) {
	const stdout = run(npm, ["pack", "--pack-destination", into, "--json", "--ignore-scripts"], { cwd });
	const [manifest] = JSON.parse(stdout);
	return join(into, manifest.filename);
}

function smokeScript(imports) {
	const lines = [
		"const mainDefault = (await import('@zihanw/pi-forge')).default;",
		"const port = await import('@zihanw/pi-forge/subagent');",
		"if (typeof mainDefault !== 'function') throw new Error('@zihanw/pi-forge default is not a function');",
		"if (typeof port.ForgeHostClient !== 'function') throw new Error('@zihanw/pi-forge/subagent ForgeHostClient is not exported');",
	];
	for (const line of imports) lines.push(line);
	lines.push("console.log('packed-install smoke ok');");
	return lines.join("\n");
}

// The packed tarball ships .d.ts files whose relative specifiers keep the
// authored .ts extensions (TypeScript resolves them to sibling .d.ts files).
// Prove the shipped type surface resolves the way consumers use it by
// typechecking a consumer module under nodenext with the repo's own tsc.
function typeSmoke(dir, entryImports) {
	const lines = [
		"import piForge, { registerMacro, registerSlot, type PromptMacroDefinition, type PromptEnvironment, type ForgeExtensionApi } from '@zihanw/pi-forge';",
		"import { ForgeHostClient, ForgeHost, FORGE_HOST_PORT_VERSION, type ForgePrepareRequest, type ForgeHostTransport, subagentFingerprint } from '@zihanw/pi-forge/subagent';",
		...entryImports,
		"const version: 1 = FORGE_HOST_PORT_VERSION;",
		"void [piForge, registerMacro, registerSlot, ForgeHostClient, ForgeHost, version, subagentFingerprint];",
		"export type { PromptMacroDefinition, PromptEnvironment, ForgeExtensionApi, ForgePrepareRequest, ForgeHostTransport };",
	];
	writeFileSync(join(dir, "smoke.ts"), lines.join("\n"));
	writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
		compilerOptions: {
			strict: true,
			noEmit: true,
			module: "nodenext",
			moduleResolution: "nodenext",
			skipLibCheck: true,
		},
		include: ["smoke.ts"],
	}));
	run(process.execPath, [join(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], { cwd: dir });
}

const tmp = mkdtempSync(join(tmpdir(), "pi-forge-packed-"));
try {
	// 1) main-only packed install
	const mainPack = packInto(rootDir, tmp);
	const mainOnly = mkdtempSync(join(tmpdir(), "pi-forge-packed-main-"));
	try {
		writeFileSync(join(mainOnly, "package.json"), JSON.stringify({ name: "smoke-main", private: true, type: "module" }));
		run(npm, ["install", mainPack,
			"@earendil-works/pi-coding-agent@0.83.0",
			"@earendil-works/pi-ai@0.83.0",
			"@earendil-works/pi-agent-core@0.83.0",
			"@earendil-works/pi-tui@0.83.0",
			"typebox@1.3.7",
			"--no-audit", "--no-fund", "--ignore-scripts"], { cwd: mainOnly });
		writeFileSync(join(mainOnly, "smoke.mjs"), smokeScript([`const { ForgeHostPortOperation } = await import('@zihanw/pi-forge/subagent');`]));
		run(process.execPath, ["smoke.mjs"], { cwd: mainOnly });
		typeSmoke(mainOnly, []);
	} finally {
		rmSync(mainOnly, { recursive: true, force: true });
	}
	console.log("main-only packed install smoke: PASS");

	// 2) main + optional packed install
	if (existsSync(optionalRoot)) {
		const optionalPack = packInto(optionalRoot, tmp);
		const both = mkdtempSync(join(tmpdir(), "pi-forge-packed-both-"));
		try {
			writeFileSync(join(both, "package.json"), JSON.stringify({
				name: "smoke-both",
				private: true,
				type: "module",
				dependencies: {
					"@zihanw/pi-forge": `file:${mainPack}`,
					"@zihanw/pi-forge-subagents": `file:${optionalPack}`,
				},
			}));
			run(npm, ["install",
				"@earendil-works/pi-coding-agent@0.83.0",
				"@earendil-works/pi-ai@0.84.2",
				"@earendil-works/pi-agent-core@0.84.2",
				"@earendil-works/pi-tui@0.84.2",
				"typebox@1.3.15",
				"@zihanw/pi-subagent-runtime@0.1.0-beta.2",
				"--no-audit", "--no-fund", "--ignore-scripts", "--legacy-peer-deps"], { cwd: both });
			writeFileSync(join(both, "smoke.mjs"), smokeScript([
				`const optional = await import('@zihanw/pi-forge-subagents');`,
				`if (typeof optional.default !== 'function') throw new Error('pi-forge-subagents default is not a function');`,
				`if (typeof optional.ForgeHostSession !== 'function') throw new Error('ForgeHostSession is not exported');`,
				`if (typeof optional.createForgeSubagentRuntime !== 'function') throw new Error('createForgeSubagentRuntime is not exported');`,
			]));
			run(process.execPath, ["smoke.mjs"], { cwd: both });
			typeSmoke(both, [
				"import forgeSubagents, { ForgeHostSession, createForgeSubagentRuntime, type ForgeSubagentRuntime } from '@zihanw/pi-forge-subagents';",
				"void [forgeSubagents, ForgeHostSession, createForgeSubagentRuntime];",
				"export type { ForgeSubagentRuntime };",
			]);
		} finally {
			rmSync(both, { recursive: true, force: true });
		}
		console.log("main + optional packed install smoke: PASS");
	} else {
		console.log("optional package not present; skipping main+optional packed smoke");
	}
} finally {
	rmSync(join(tmp, "main"), { recursive: true, force: true });
	rmSync(tmp, { recursive: true, force: true });
}
