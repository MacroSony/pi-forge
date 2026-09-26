import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { build, normalizePath } from "vite";
import { formatImportSpecifier, isSamePath } from "./helpers/browser-fixture-path.ts";

function parsedImportPath(literal: string): string {
	const source = ts.createSourceFile("entry.ts", `import Component from ${literal};`, ts.ScriptTarget.ES2022, true);
	const declaration = source.statements[0];
	assert.ok(declaration && ts.isImportDeclaration(declaration));
	assert.ok(ts.isStringLiteral(declaration.moduleSpecifier));
	return declaration.moduleSpecifier.text;
}

test("fixture imports roundtrip native and foreign paths through the actual TypeScript parser", () => {
	for (const path of [
		"/workspace/Component.vue",
		String.raw`D:\a\pi-forge\pi-forge\src\Component.vue`,
		String.raw`C:\tools\notes\users\Component.vue`,
		String.raw`C:\Program Files\项目\Component.vue`,
		`/tmp/test's/"quoted"/组件.vue`,
		"/tmp/line\nbreak/Component.vue",
	]) {
		// Vite normalization is host-dependent: foreign paths remain correctly
		// escaped on POSIX; the Windows runner additionally exercises slash conversion.
		assert.equal(parsedImportPath(formatImportSpecifier(path)), normalizePath(path));
	}
});

test("the old raw Windows interpolation corrupts paths while the shared formatter preserves them", () => {
	const path = String.raw`C:\tools\notes\Component.vue`;
	const broken = parsedImportPath(`"${path}"`);
	assert.notEqual(broken, path);
	assert.ok(broken.includes("\t") && broken.includes("\n"));
	assert.equal(parsedImportPath(formatImportSpecifier(path)), normalizePath(path));
});

test("inspector stub matches Vite's native normalized ID without swallowing Vue subrequests", () => {
	const stub = resolve("src/web-editor/client/components/ContextDiffPanel.vue");
	const moduleId = normalizePath(stub);
	assert.equal(isSamePath(moduleId, stub), true);
	assert.equal(isSamePath(`${moduleId}?vue&type=template`, stub), false);
	assert.equal(isSamePath(`${moduleId}?vue&type=style&index=0`, stub), false);
	assert.equal(isSamePath(resolve("src/web-editor/client/components/SessionCapabilities.vue"), stub), false);
	if (process.platform === "win32") {
		assert.equal(isSamePath("C:/repo/ContextDiffPanel.vue", String.raw`C:\repo\ContextDiffPanel.vue`), true);
	}
});

test("Vite bundles a generated import from a real path containing spaces, an apostrophe and Unicode", async () => {
	const directory = mkdtempSync(join(tmpdir(), "forge fixture 项目-"));
	try {
		const component = join(directory, "owner's component.js");
		const entry = join(directory, "entry.ts");
		writeFileSync(component, 'export default "resolved-fixture";');
		writeFileSync(entry, `import value from ${formatImportSpecifier(component)}; export default value;`);
		const result = await build({
			root: directory, configFile: false, publicDir: false, logLevel: "silent",
			build: { write: false, minify: false, target: "es2022", lib: { entry, name: "PathFixture", formats: ["iife"] } },
		});
		const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => "output" in r ? r.output : []);
		const chunk = outputs.find(output => output.type === "chunk");
		assert.ok(chunk && chunk.type === "chunk");
		assert.equal(new Function(`${chunk.code}\nreturn PathFixture;`)(), "resolved-fixture");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
