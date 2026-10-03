import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MAX_PACKED_BYTES, packageMediaFailures, readmeMediaFailures } from "../scripts/package-policy.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const raw = "https://raw.githubusercontent.com/MacroSony/pi-forge/1184033b0ea1c211dd55aca8a74e9d1bbaa33e2b/assets/demo.gif";

test("package policy retains text, code, declarations, maps and authored examples", () => {
	assert.deepEqual(packageMediaFailures({ size: MAX_PACKED_BYTES, files: [
		"README.md", "LICENSE", "docs/assets-policy.md", "dist/index.js", "dist/index.d.ts",
		"dist/index.d.ts.map", "examples/custom/index.ts",
	].map(path => ({ path })) }), []);
});

test("package policy rejects image, audio and video entries anywhere, case-insensitively", () => {
	for (const path of ["README.GIF", "LICENSE.png", "docs/screenshot.jpeg", "dist/demo.MP4", "dist/logo.svg",
		"examples/frame.webp", "movie.webm", "docs/shot.avif", "docs\\shot.PNG", "demo.wav", "demo.mp3"] ) {
		assert.match(packageMediaFailures({ size: 100, files: [{ path }] }).join("\n"), /repository-only media leaked/u, path);
	}
});

test("package policy rejects repository asset directories regardless of file extension", () => {
	for (const path of ["assets/readme/PROVENANCE.md", "assets/unknown.bin", "dist/assets/clip.dat", "ASSETS\\notes.txt"]) {
		assert.equal(packageMediaFailures({ size: 100, files: [{ path }] }).length, 1, path);
	}
});

test("package compressed-size budget rejects oversized and invalid inventories", () => {
	assert.match(packageMediaFailures({ size: MAX_PACKED_BYTES + 1, files: [] }).join("\n"), /compressed budget/u);
	for (const size of [-1, NaN, Infinity, 1.5]) {
		assert.match(packageMediaFailures({ size, files: [] }).join("\n"), /non-negative safe integer/u);
	}
});

test("README media uses immutable hosted URLs, not missing installed assets or floating branches", () => {
	assert.deepEqual(readmeMediaFailures(`![Demo](${raw})\n<img alt="Demo" src="${raw}">`, "README"), []);
	for (const image of ["![Demo](assets/demo.gif)", "![Demo](<assets/demo.gif>)",
		`![Demo](${raw.replace("1184033b0ea1c211dd55aca8a74e9d1bbaa33e2b", "main")})`,
		'<img src="assets/demo.gif" alt="Demo">']) {
		assert.equal(readmeMediaFailures(image, "README").length, 1, image);
	}
	assert.deepEqual(readmeMediaFailures("```md\n![Example](assets/demo.gif)\n```", "README"), []);
	for (const name of ["README.md", "README.zh-CN.md"]) {
		assert.deepEqual(readmeMediaFailures(readFileSync(join(root, name), "utf8"), name), []);
	}
});

function write(rootDir: string, path: string, text: string): void {
	const file = join(rootDir, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function npmPack(cwd: string, destination: string, ignoreScripts = false) {
	const cli = process.env.npm_execpath;
	assert.ok(cli, "Run this integration through npm test so the same npm CLI is used on every platform");
	return spawnSync(process.execPath, [cli, "pack", "--json", "--pack-destination", destination,
		...(ignoreScripts ? ["--ignore-scripts"] : [])], { cwd, encoding: "utf8", timeout: 60_000 });
}

test("actual npm pack excludes injected media while prepack checks run once without recursion", () => {
	const fixture = mkdtempSync(join(tmpdir(), "forge-media-pack-"));
	const out = mkdtempSync(join(tmpdir(), "forge-media-output-"));
	try {
		write(fixture, "package.json", JSON.stringify({
			name: "forge-media-fixture", version: "0.0.0", private: true, type: "module",
			files: manifest.files, exports: manifest.exports,
			peerDependencies: manifest.peerDependencies, peerDependenciesMeta: manifest.peerDependenciesMeta,
			scripts: { build: "node scripts/fixture-build.mjs", "check:package": manifest.scripts["check:package"], prepack: manifest.scripts.prepack },
		}));
		write(fixture, "scripts/fixture-build.mjs", 'import {appendFileSync} from "node:fs"; appendFileSync(".build-ran", "1\\n");');
		for (const name of ["check-package.mjs", "package-policy.ts"]) {
			copyFileSync(join(root, "scripts", name), join(fixture, "scripts", name));
		}
		for (const entry of Object.values(manifest.exports) as { types: string; import: string }[]) {
			write(fixture, entry.types, "export {};\n");
			write(fixture, entry.import, "export {};\n");
		}
		const retained = ["dist/index.js.map", "README.md", "README.zh-CN.md", "CHANGELOG.md", "LICENSE",
			"PUBLIC_API.md", "SUBAGENT_ADAPTER_CONTRACT.md", "docs/README.md", "docs/development/release.md",
			"docs/reference/commands.md", "examples/read-first-worker-prompt-stack.json", "examples/capabilities/write-tools.json",
			"examples/custom-system-status-extension/index.ts"];
		for (const name of retained) write(fixture, name, name.endsWith(".json") ? "{}\n" : "fixture\n");
		const excluded = ["assets/readme/demo.gif", "assets/readme/PROVENANCE.md", "assets/header.png",
			"docs/demo.gif", "dist/demo.mp4", "examples/shot.png", "screenshot.PNG", "src/index.ts"];
		for (const name of excluded) write(fixture, name, "not a runtime resource\n");
		const packed = npmPack(fixture, out);
		assert.equal(packed.status, 0, `${packed.error ?? ""}\n${packed.stdout}\n${packed.stderr}`);
		// npm may forward lifecycle stdout before the final JSON array.
		const jsonStart = packed.stdout.lastIndexOf("\n[");
		const [inventory] = JSON.parse(jsonStart < 0 ? packed.stdout : packed.stdout.slice(jsonStart + 1));
		const paths = new Set<string>(inventory.files.map((file: { path: string }) => file.path));
		for (const name of retained) assert.ok(paths.has(name), `must retain ${name}`);
		for (const name of excluded) assert.ok(!paths.has(name), `must exclude ${name}`);
		assert.deepEqual(packageMediaFailures(inventory), []);
		assert.equal(readFileSync(join(fixture, ".build-ran"), "utf8"), "1\n", "nested inventory pack must not re-run prepack/build");
		assert.ok(existsSync(join(out, inventory.filename)));

		// npm always includes README variants, even outside the files whitelist.
		// Prove the inventory gate catches this escape hatch on the actual publish path.
		write(fixture, "README.gif", "GIF89a accidentally named like a README");
		const unguarded = npmPack(fixture, out, true);
		assert.equal(unguarded.status, 0, unguarded.stderr);
		assert.ok(JSON.parse(unguarded.stdout)[0].files.some((file: { path: string }) => file.path === "README.gif"));
		const badOut = join(out, "blocked");
		mkdirSync(badOut);
		const blocked = npmPack(fixture, badOut);
		assert.notEqual(blocked.status, 0);
		assert.match(blocked.stdout + blocked.stderr, /repository-only media leaked into npm tarball: README.gif/u);
		assert.deepEqual(readdirSync(badOut), [], "a failed prepack must not emit a new release tarball");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	}
});
