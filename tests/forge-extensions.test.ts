import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createForgeExtensionState,
	reloadForgeExtensions,
	unloadForgeExtensions,
} from "../src/forge-extensions.ts";
import { getRegisteredMacros } from "../src/macro-engine.ts";
import { forgeExtensionsDir } from "../src/storage.ts";

process.env.HOME = mkdtempSync(join(tmpdir(), "pi-forge-extension-home-"));

test("forge extension entry modules reload across supported ESM and CommonJS formats", async (t) => {
	for (const extension of ["ts", "mjs", "js", "cjs"] as const) {
		await t.test(extension, async () => {
			const cwd = mkdtempSync(join(tmpdir(), `pi-forge-extension-${extension}-`));
			const extensionsDir = forgeExtensionsDir(cwd);
			mkdirSync(extensionsDir, { recursive: true });
			const filePath = join(extensionsDir, `reload.${extension}`);
			const macroName = `reload-${extension}`;
			const state = createForgeExtensionState();

			try {
				writeFileSync(filePath, extensionSource(extension, macroName, "v1"), "utf8");
				const first = await reloadForgeExtensions(cwd, state);
				assert.deepEqual(first.diagnostics, []);
				assert.equal(renderMacro(macroName), "v1");

				writeFileSync(filePath, extensionSource(extension, macroName, "v2"), "utf8");
				const second = await reloadForgeExtensions(cwd, state);
				assert.deepEqual(second.diagnostics, []);
				assert.equal(renderMacro(macroName), "v2");
			} finally {
				unloadForgeExtensions(state);
			}
		});
	}
});

function extensionSource(extension: "ts" | "mjs" | "js" | "cjs", macroName: string, value: string): string {
	const registration = `api.registerMacro({ name: ${JSON.stringify(macroName)}, render: () => ${JSON.stringify(value)} });`;
	if (extension === "js" || extension === "cjs") {
		return `module.exports = function register(api) { ${registration} };\n`;
	}
	const parameter = extension === "ts" ? "api: any" : "api";
	return `export default function register(${parameter}) { ${registration} }\n`;
}

function renderMacro(name: string): string | undefined {
	return getRegisteredMacros().find((definition) => definition.name === name)?.render({} as never);
}

test("registry rejects dotted macro and slot names that forge-v1 cannot address", async () => {
	const { registerMacro } = await import("../src/macro-engine.ts");
	const { registerSlot } = await import("../src/slot-renderers.ts");
	// forge-v1 parses "extensions.git.branch" as three path segments, so a
	// dotted macro name would be registerable but unreachable — reject it.
	assert.throws(
		() => registerMacro({ name: "git.branch", dependencies: [], render: () => "main" }),
		/Macro name must start with a letter/,
	);
	assert.throws(
		() => registerSlot({ name: "chat.history", dependencies: [], render: () => "" }),
		/Slot name must start with a letter/,
	);
	// Single-segment names with underscore/hyphen remain valid.
	const macro = registerMacro({ name: "git-branch_ok", dependencies: [], render: () => "main" });
	macro();
});
