import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";
import { globalPromptStacksDir } from "../src/storage.ts";

function findChromeExecutable(): string | undefined {
	const candidates = [
		process.env.CHROME_PATH,
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
		process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : undefined,
	].filter((candidate): candidate is string => !!candidate);
	return candidates.find(existsSync);
}

test("new preset dialog: template choices, name suggestions, and persisted shapes on disk", { timeout: 35_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const previousGlobal = process.env.PI_FORGE_GLOBAL_DIR;
	const globalDir = mkdtempSync(join(tmpdir(), "pi-forge-templates-global-"));
	process.env.PI_FORGE_GLOBAL_DIR = globalDir;
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-browser-templates-"));

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	let editorStarted = false;
	const browserErrors: string[] = [];

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		editorStarted = true;
		const editorUrl = latestEditorUrl(context.editors);
		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(5_000);
		page.on("pageerror", (error) => browserErrors.push(error.message));

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator("#emptyNewStackBtn").click();
		await page.locator("#stackResourceForm").waitFor();
		assert.match(await page.locator(".resource-form-note").innerText(), /first preset.*activated automatically/);
		await page.locator("#template-empty").click();
		await page.locator("#stackResourceId").fill("initial");
		let unexpectedFirstDialog = false;
		const rejectFirstDialog = async (dialog: import("playwright-core").Dialog) => { unexpectedFirstDialog = true; await dialog.dismiss(); };
		page.on("dialog", rejectFirstDialog);
		await page.locator('#stackResourceForm button[type="submit"]').click();
		await page.locator("#status").filter({ hasText: /Created (project:)?initial/ }).waitFor();
		page.off("dialog", rejectFirstDialog);
		assert.equal(unexpectedFirstDialog, false);
		const firstJson = JSON.parse(readFileSync(join(promptStacksDir(cwd), "initial.json"), "utf8"));
		assert.deepEqual(firstJson.items, []);
		assert.equal(firstJson.autoActivate, true);
		assert.equal(await page.locator(".stack-row.selected.active").count(), 1);

		// 1. Open New preset dialog and check accessibility & options
		await page.locator("#newStackBtn").click();
		await page.locator("#stackResourceForm").waitFor();

		const templateRadios = page.locator('#stackResourceForm input[name="template"]');
		assert.equal(await templateRadios.count(), 3);
		assert.equal(await page.locator('#template-default').isChecked(), true);
		assert.equal(await page.locator('#template-empty').isChecked(), false);
		assert.equal(await page.locator('#template-minimal').isChecked(), false);

		// Name defaults to Default Pi Prompt Mirror
		const nameInput = page.locator("#stackResourceName");
		assert.equal(await nameInput.inputValue(), "Default Pi Prompt Mirror");

		// 2. Switching templates updates suggested name when unedited
		await page.locator('#template-empty').click();
		assert.equal(await page.locator('#template-empty').isChecked(), true);
		assert.equal(await nameInput.inputValue(), "Empty Preset");

		await page.locator('#template-minimal').click();
		assert.equal(await page.locator('#template-minimal').isChecked(), true);
		assert.equal(await nameInput.inputValue(), "Minimal Worker");

		await page.locator('#template-default').click();
		assert.equal(await page.locator('#template-default').isChecked(), true);
		assert.equal(await nameInput.inputValue(), "Default Pi Prompt Mirror");

		// 3. User custom name is NEVER overwritten when switching templates
		await nameInput.fill("My Custom Preset Name");
		await page.locator('#template-empty').click();
		assert.equal(await nameInput.inputValue(), "My Custom Preset Name");
		await page.locator('#template-minimal').click();
		assert.equal(await nameInput.inputValue(), "My Custom Preset Name");
		await page.locator('#template-default').click();
		assert.equal(await nameInput.inputValue(), "My Custom Preset Name");

		// Even text equal to another suggestion is user-owned after editing.
		await nameInput.fill("Minimal Worker");
		await page.locator('#template-empty').click();
		assert.equal(await nameInput.inputValue(), "Minimal Worker");

		// Cancel closes without writing to disk
		await page.locator('#stackResourceForm button[data-modal-close="true"]').click();
		await page.locator("#stackResourceForm").waitFor({ state: "hidden" });
		assert.deepEqual(readdirSync(promptStacksDir(cwd)), ["initial.json"]);

		// 4. Create Minimal Worker preset and verify persisted shape
		await page.locator("#newStackBtn").click();
		await page.locator("#stackResourceForm").waitFor();
		await page.locator('#template-minimal').click();
		assert.equal(await nameInput.inputValue(), "Minimal Worker");
		await page.locator("#stackResourceId").fill("worker-minimal");

		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await page.locator('#stackResourceForm button[type="submit"]').click();
		await page.locator("#status").filter({ hasText: /Created (project:)?worker-minimal/ }).waitFor();

		const minimalDiskPath = join(promptStacksDir(cwd), "worker-minimal.json");
		assert.ok(existsSync(minimalDiskPath), "worker-minimal.json must exist on disk");
		const minimalJson = JSON.parse(readFileSync(minimalDiskPath, "utf8"));
		const example = JSON.parse(readFileSync(new URL("../examples/minimal-prompt-stack.json", import.meta.url), "utf8"));
		assert.deepEqual(minimalJson, { ...example, id: "worker-minimal" });

		assert.equal(minimalJson.id, "worker-minimal");
		assert.equal(minimalJson.name, "Minimal Worker");
		assert.equal(minimalJson.schemaVersion, 2);
		assert.equal(minimalJson.type, "pi-forge.prompt-stack");
		assert.equal(minimalJson.mode, "replace");
		assert.deepEqual(minimalJson.tools, { allow: ["bash", "edit"] });
		assert.equal(minimalJson.skills, undefined);
		assert.equal(minimalJson.items.length, 2);
		assert.equal(minimalJson.items[0].id, "worker-role");
		assert.equal(minimalJson.items[0].role, "system");
		assert.equal(minimalJson.items[0].content, "You are a helpful software engineer assistant.");
		assert.equal(minimalJson.items[1].id, "chat-history");
		assert.equal(minimalJson.items[1].slot, "chat-history");
		assert.equal(minimalJson.items[1].options?.includeSummaries, false);
		assert.deepEqual(minimalJson.parameters, {});
		assert.equal(Object.hasOwn(minimalJson, "template"), false, "Saved schema must not contain template field");

		// 5. Create Empty preset and verify persisted shape (items: [], no tool/skill policy)
		await page.locator("#newStackBtn").click();
		await page.locator("#stackResourceForm").waitFor();
		await page.locator('#template-empty').click();
		assert.equal(await nameInput.inputValue(), "Empty Preset");
		await page.locator("#stackResourceId").fill("empty-worker");

		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await page.locator('#stackResourceForm button[type="submit"]').click();
		await page.locator("#status").filter({ hasText: /Created (project:)?empty-worker/ }).waitFor();

		const emptyDiskPath = join(promptStacksDir(cwd), "empty-worker.json");
		assert.ok(existsSync(emptyDiskPath), "empty-worker.json must exist on disk");
		const emptyJson = JSON.parse(readFileSync(emptyDiskPath, "utf8"));

		assert.equal(emptyJson.id, "empty-worker");
		assert.equal(emptyJson.name, "Empty Preset");
		assert.equal(emptyJson.schemaVersion, 2);
		assert.equal(emptyJson.type, "pi-forge.prompt-stack");
		assert.equal(emptyJson.mode, "replace");
		assert.deepEqual(emptyJson.items, []);
		assert.equal(emptyJson.tools, undefined);
		assert.equal(emptyJson.skills, undefined);
		assert.equal(Object.hasOwn(emptyJson, "template"), false, "Saved schema must not contain template field");

		// 6. Create Default Pi prompt preset and verify full mirror persisted shape
		await page.locator("#newStackBtn").click();
		await page.locator("#stackResourceForm").waitFor();
		assert.equal(await page.locator('#template-default').isChecked(), true);
		await page.locator("#stackResourceId").fill("default-mirror");

		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await page.locator('#stackResourceForm button[type="submit"]').click();
		await page.locator("#status").filter({ hasText: /Created (project:)?default-mirror/ }).waitFor();

		const defaultDiskPath = join(promptStacksDir(cwd), "default-mirror.json");
		assert.ok(existsSync(defaultDiskPath), "default-mirror.json must exist on disk");
		const defaultJson = JSON.parse(readFileSync(defaultDiskPath, "utf8"));

		assert.equal(defaultJson.id, "default-mirror");
		assert.equal(defaultJson.name, "Default Pi Prompt Mirror");
		assert.equal(defaultJson.schemaVersion, 2);
		assert.equal(defaultJson.type, "pi-forge.prompt-stack");
		assert.equal(defaultJson.mode, "replace");
		assert.deepEqual(defaultJson.tools, { allow: ["*"] });
		assert.deepEqual(defaultJson.skills, { allow: ["*"] });
		assert.equal(defaultJson.items.length, 10);
		assert.equal(Object.hasOwn(defaultJson, "template"), false, "Saved schema must not contain template field");

		// 7. Explicit global scope creation
		await page.locator("#newStackBtn").click();
		await page.locator("#stackResourceForm").waitFor();
		await page.locator('#template-minimal').click();
		await page.locator("#stackResourceId").fill("global-worker");
		await page.locator("#stackResourceScope").selectOption("global");

		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await page.locator('#stackResourceForm button[type="submit"]').click();
		await page.locator("#status").filter({ hasText: /Created (global:)?global-worker/ }).waitFor();

		const globalDiskPath = join(globalPromptStacksDir(), "global-worker.json");
		assert.ok(existsSync(globalDiskPath), "global-worker.json must exist in global directory");
		const globalJson = JSON.parse(readFileSync(globalDiskPath, "utf8"));
		assert.equal(globalJson.id, "global-worker");
		assert.equal(existsSync(join(promptStacksDir(cwd), "global-worker.json")), false, "Must not exist in project directory");

		// 8. Import dialog must NOT show template selector and preserves unknown fields
		page.once("dialog", async (dialog) => {
			await dialog.dismiss();
		});
		await page.locator("#importFileInput").setInputFiles({
			name: "custom-import.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify({
				schemaVersion: 1,
				type: "pi-forge.prompt-stack",
				id: "custom-import",
				unknownCustomField: { key: "preserved-data" },
				items: [{ kind: "block", id: "imported-role", role: "system", content: "Imported content." }],
			})),
		});
		await page.locator("#stackResourceForm").waitFor();
		assert.equal(await page.locator('#stackResourceForm input[name="template"]').count(), 0, "Import must not have template selector");
		assert.equal(await page.locator('#stackResourceForm .template-options').count(), 0);
		await page.locator('#stackResourceForm button[type="submit"]').click();
		await page.locator("#status").filter({ hasText: /Imported (project:)?custom-import/ }).waitFor();

		const importedDiskPath = join(promptStacksDir(cwd), "custom-import.json");
		assert.ok(existsSync(importedDiskPath));
		const importedJson = JSON.parse(readFileSync(importedDiskPath, "utf8"));
		assert.deepEqual(importedJson.unknownCustomField, { key: "preserved-data" });

		// 9. Fork uses the loaded source items, never any creation template.
		await page.locator("#moreActions > summary").click();
		await page.locator("#forkBtn").click();
		await page.locator("#stackResourceForm").waitFor();
		assert.equal(await page.locator('#stackResourceForm input[name="template"]').count(), 0, "Fork must not have template selector");
		assert.equal(await page.locator('#stackResourceForm .template-options').count(), 0);

		page.once("dialog", async (dialog) => {
			await dialog.dismiss();
		});
		await page.locator('#stackResourceForm button[type="submit"]').click();
		await page.locator("#status").filter({ hasText: /Forked (project:)?custom-import-fork/ }).waitFor();

		const forkedDiskPath = join(promptStacksDir(cwd), "custom-import-fork.json");
		assert.ok(existsSync(forkedDiskPath));
		const forkedJson = JSON.parse(readFileSync(forkedDiskPath, "utf8"));
		assert.deepEqual(forkedJson.items, importedJson.items);
		assert.equal(forkedJson.tools, undefined);
		assert.equal(Object.hasOwn(forkedJson, "template"), false);

		// 10. Usable mobile layout test
		await page.setViewportSize({ width: 375, height: 667 });
		await page.locator("#newStackBtn").click();
		await page.locator("#stackResourceForm").waitFor();
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "Modal layout must fit on mobile screen without horizontal overflow");
		await page.locator('#stackResourceForm button[data-modal-close="true"]').click();

		// Parent visual evidence is opt-in; ordinary tests produce no repository artifacts.
		const artifacts = process.env.PI_FORGE_TEMPLATE_ARTIFACTS;
		if (artifacts) mkdirSync(artifacts, { recursive: true });
		for (const locale of ["en", "zh-CN"]) {
			await page.locator("#localeSelect").selectOption(locale);
			for (const width of [1440, 390]) {
				await page.setViewportSize({ width, height: 900 });
				await page.locator("#newStackBtn").click();
				await page.locator("#stackResourceForm").waitFor();
				assert.equal(await page.locator("#stackResourceName").inputValue(), locale === "en" ? "Default Pi Prompt Mirror" : "默认 Pi 提示词镜像");
				await page.locator("#template-default").focus();
				await page.keyboard.press("ArrowDown");
				assert.equal(await page.locator("#template-empty").isChecked(), true);
				assert.equal(await page.locator("#stackResourceName").inputValue(), locale === "en" ? "Empty Preset" : "空白预设");
				assert.equal(await page.locator(".modal-body").evaluate(el => el.scrollWidth <= el.clientWidth), true);
				if (artifacts) await page.screenshot({ path: join(artifacts, `new-preset-${locale}-${width}.png`) });
				await page.locator('#stackResourceForm button[data-modal-close="true"]').click();
			}
		}
		assert.deepEqual(browserErrors, []);
	} finally {
		await browser?.close();
		if (editorStarted) await harness.commands.preset.handler("ui stop", context.ctx);
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalDir, { recursive: true, force: true });
		if (previousGlobal === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previousGlobal;
	}
});
