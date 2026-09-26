import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Dialog, type Page, type Route } from "playwright-core";
import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeStack,
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

function findChromeExecutable(): string | undefined {
	return process.env.CHROME_PATH || [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
		process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
	].find((path): path is string => !!path && existsSync(path));
}

function defaultStack(content = "Original system text", name = "Original Preset", id = "default") {
	return {
		schemaVersion: 2,
		type: "pi-forge.prompt-stack",
		id,
		name,
		autoActivate: true,
		mode: "replace",
		items: [{ kind: "block", id: "system", role: "system", content }],
	};
}

interface BrowserContext {
	page: Page;
	url: URL;
	cwd: string;
}

async function runBrowserTest(
	t: test.TestContext,
	setup: (cwd: string) => void | Promise<void>,
	run: (ctx: BrowserContext) => Promise<void>
): Promise<void> {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("browser tests explicitly disabled");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "forge-preset-discard-"));
	const harness = createHarness();
	const context = createContext(cwd);
	let browser: Browser | undefined;
	let editorStarted = false;

	try {
		await setup(cwd);
		await startSession(harness, context.ctx);
		await harness.commands.preset.handler("ui", context.ctx);
		editorStarted = true;
		const url = latestEditorUrl(context.editors);

		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage();
		page.setDefaultTimeout(8_000);

		await run({ page, url, cwd });
	} finally {
		await browser?.close();
		if (editorStarted) {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("F1: Preset Import cancel preserves dirty edits and makes no writes", { timeout: 30_000 }, async (t) => {
	await runBrowserTest(t, (cwd) => writeStack(cwd, "default.json", defaultStack()), async ({ page, url, cwd }) => {
		const dialogs: Array<{ type: string; message: string; handled: string }> = [];
		page.on("dialog", async (dialog: Dialog) => {
			dialogs.push({ type: dialog.type(), message: dialog.message(), handled: "dismissed" });
			await dialog.dismiss();
		});

		await page.goto(url.href);
		await page.locator("#itemContent").waitFor();

		const dirtyText = "Original system text with DIRTY UNSAVED WORK";
		await page.locator("#itemContent").fill(dirtyText);
		await page.locator("#dirtyBadge.visible").waitFor();

		const importedPreset = defaultStack("Imported content", "Should Not Import", "imported-cancel");
		await page.locator("#importFileInput").setInputFiles({
			name: "imported-cancel.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify(importedPreset)),
		});

		await page.waitForTimeout(300);
		assert.ok(dialogs.length >= 1, "Discard confirmation dialog must be triggered");
		assert.ok(
			dialogs.some((d) => /discard|unsaved|未保存|放弃/i.test(d.message)),
			`Dialog message should warn about discard: ${JSON.stringify(dialogs)}`
		);

		const modalVisible = await page.locator("#stackResourceForm").isVisible();
		assert.strictEqual(modalVisible, false, "Import resource form must not open on cancel");

		const currentUiText = await page.locator("#itemContent").inputValue();
		assert.strictEqual(currentUiText, dirtyText, "Editor content must remain dirty after cancel");
		assert.strictEqual(await page.locator("#dirtyBadge.visible").isVisible(), true, "Dirty badge must remain visible");

		const defaultOnDisk = JSON.parse(readFileSync(join(promptStacksDir(cwd), "default.json"), "utf8"));
		assert.strictEqual(defaultOnDisk.items[0].content, "Original system text");
		assert.strictEqual(existsSync(join(promptStacksDir(cwd), "imported-cancel.json")), false, "No new file should be written");
	});
});

test("F1: Preset Import accept confirms discard, imports new preset, and switches", { timeout: 30_000 }, async (t) => {
	await runBrowserTest(t, (cwd) => writeStack(cwd, "default.json", defaultStack()), async ({ page, url, cwd }) => {
		const dialogs: Array<{ type: string; message: string }> = [];
		page.on("dialog", async (dialog: Dialog) => {
			dialogs.push({ type: dialog.type(), message: dialog.message() });
			await dialog.accept();
		});

		await page.goto(url.href);
		await page.locator("#itemContent").waitFor();

		await page.locator("#itemContent").fill("Unsaved dirty text");
		await page.locator("#dirtyBadge.visible").waitFor();

		const importedPreset = defaultStack("Fresh imported content", "Imported Ok", "imported-ok");
		await page.locator("#importFileInput").setInputFiles({
			name: "imported-ok.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify(importedPreset)),
		});

		await page.locator("#stackResourceForm").waitFor();
		await page.locator("#stackResourceForm button[type='submit']").click();
		await page.locator("#status").filter({ hasText: "Imported imported-ok" }).waitFor();

		assert.ok(
			dialogs.some((d) => /discard|unsaved|未保存|放弃/i.test(d.message)),
			"Discard confirmation dialog must be shown when dirty"
		);

		await page.locator("#itemContent").waitFor();
		const currentUiText = await page.locator("#itemContent").inputValue();
		assert.strictEqual(currentUiText, "Fresh imported content");
		assert.ok(existsSync(join(promptStacksDir(cwd), "imported-ok.json")), "Imported file written to disk");
	});
});

test("F4: Dirty Preset Reload prompts discard exactly ONCE on accept", { timeout: 30_000 }, async (t) => {
	await runBrowserTest(t, (cwd) => writeStack(cwd, "default.json", defaultStack("Disk pristine content")), async ({ page, url }) => {
		let dialogCount = 0;
		const dialogMessages: string[] = [];
		page.on("dialog", async (dialog: Dialog) => {
			dialogCount++;
			dialogMessages.push(dialog.message());
			await dialog.accept();
		});

		await page.goto(url.href);
		await page.locator("#itemContent").waitFor();

		await page.locator("#itemContent").fill("Edited dirty content before reload");
		await page.locator("#dirtyBadge.visible").waitFor();

		await page.locator("#reloadBtn").click();
		await page.locator("#status").filter({ hasText: "Reloaded from disk" }).waitFor();

		assert.strictEqual(dialogCount, 1, `Expected exactly 1 confirmation dialog, but got ${dialogCount}: ${dialogMessages.join(", ")}`);
		assert.strictEqual(await page.locator("#dirtyBadge.visible").isVisible(), false, "Dirty badge should not be visible after reload");

		const content = await page.locator("#itemContent").inputValue();
		assert.strictEqual(content, "Disk pristine content");
	});
});

test("F4: Failed Preset Reload preserves dirty draft and does not lose edits", { timeout: 30_000 }, async (t) => {
	await runBrowserTest(t, (cwd) => writeStack(cwd, "default.json", defaultStack("Disk pristine content")), async ({ page, url }) => {
		await page.route("**/api/reload", (route: Route) => {
			void route.fulfill({ status: 500, body: JSON.stringify({ error: "Network or Server Error" }) });
		});

		page.on("dialog", (dialog: Dialog) => {
			void dialog.accept();
		});

		await page.goto(url.href);
		await page.locator("#itemContent").waitFor();

		const dirtyContent = "My precious unsaved work";
		await page.locator("#itemContent").fill(dirtyContent);
		await page.locator("#dirtyBadge.visible").waitFor();

		await page.locator("#reloadBtn").click();
		await page.waitForTimeout(400);

		const isDirty = await page.locator("#dirtyBadge.visible").isVisible();
		assert.strictEqual(isDirty, true, "Dirty badge must remain visible when reload fails");

		const currentText = await page.locator("#itemContent").inputValue();
		assert.strictEqual(currentText, dirtyContent, "Unsaved draft content must not be discarded on failed reload");
	});
});

test("Inflight typing during createAndOpenStack is protected against late response overwrite", { timeout: 30_000 }, async (t) => {
	await runBrowserTest(t, (cwd) => writeStack(cwd, "default.json", defaultStack("Initial content", "Default Preset")), async ({ page, url }) => {
		page.on("dialog", (dialog: Dialog) => {
			void dialog.accept();
		});

		let holdStackCreate: ((value?: unknown) => void) | undefined;
		const createGate = new Promise((resolve) => { holdStackCreate = resolve; });

		await page.route("**/api/stacks", async (route: Route) => {
			if (route.request().method() === "POST") {
				const response = await route.fetch();
				await createGate;
				return route.fulfill({ response });
			}
			return route.continue();
		});

		await page.goto(url.href);
		await page.locator("#itemContent").waitFor();

		const importedPreset = defaultStack("Imported race content", "Imported Race", "imported-race");
		await page.locator("#importFileInput").setInputFiles({
			name: "imported-race.json",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify(importedPreset)),
		});

		await page.locator("#stackResourceForm").waitFor();
		await page.locator("#stackResourceForm button[type='submit']").click();

		await page.waitForTimeout(100);
		const newerText = "Initial content + INFLIGHT TYPING WORK";
		await page.locator("#itemContent").fill(newerText);

		holdStackCreate?.();
		await page.waitForTimeout(500);

		const currentText = await page.locator("#itemContent").inputValue();
		assert.strictEqual(currentText, newerText, "Inflight typing must not be overwritten by late create response");
		assert.strictEqual(await page.locator("#dirtyBadge.visible").isVisible(), true, "Dirty badge must remain visible");
	});
});

test("Inflight typing during reload protects newer edits between collection reload and selectStack", { timeout: 30_000 }, async (t) => {
	await runBrowserTest(t, (cwd) => writeStack(cwd, "default.json", defaultStack("Disk original", "Default Preset")), async ({ page, url }) => {
		let reloadGateRelease: (() => void) | undefined;
		const reloadGate = new Promise<void>((resolve) => { reloadGateRelease = resolve; });

		await page.route("**/api/reload", async (route: Route) => {
			const response = await route.fetch();
			await reloadGate;
			return route.fulfill({ response });
		});

		let dialogCount = 0;
		page.on("dialog", async (dialog: Dialog) => {
			dialogCount++;
			if (dialogCount === 1) {
				await dialog.accept();
			} else {
				await dialog.dismiss();
			}
		});

		await page.goto(url.href);
		await page.locator("#itemContent").waitFor();

		await page.locator("#itemContent").fill("Draft v1");
		await page.locator("#dirtyBadge.visible").waitFor();

		await page.locator("#reloadBtn").click();
		await page.waitForTimeout(100);

		const extraWork = "Draft v1 + EXTRA WORK IN-FLIGHT";
		await page.locator("#itemContent").fill(extraWork);

		reloadGateRelease?.();
		await page.waitForTimeout(500);

		assert.strictEqual(dialogCount, 2, "Second dialog must be prompted for edits made during in-flight reload");
		const currentText = await page.locator("#itemContent").inputValue();
		assert.strictEqual(currentText, extraWork, "Extra typing made during reload must not be wiped out");
		assert.strictEqual(await page.locator("#dirtyBadge.visible").isVisible(), true, "Dirty badge must remain visible");
	});
});

test("Import preserves edits made while File.text is pending, before create starts", { timeout: 30_000 }, async (t) => {
	await runBrowserTest(t, cwd => writeStack(cwd, "default.json", defaultStack()), async ({ page, url, cwd }) => {
		await page.goto(url.href);
		await page.locator("#itemContent").fill("confirmed draft");
		page.on("dialog", async dialog => {
			if (/Activate imported/.test(dialog.message())) await dialog.dismiss();
			else await dialog.accept();
		});
		await page.evaluate(() => {
			const original = File.prototype.text;
			const w = window as unknown as { releaseRead: () => void; readStarted: boolean };
			let release!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; });
			w.releaseRead = release;
			File.prototype.text = async function () { w.readStarted = true; await gate; return original.call(this); };
		});
		await page.locator("#importFileInput").setInputFiles({ name: "read-race.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(defaultStack("imported", "Read race", "read-race"))) });
		await page.waitForFunction(() => (window as unknown as { readStarted: boolean }).readStarted);
		await page.locator("#itemContent").fill("new work during file read");
		await page.evaluate(() => (window as unknown as { releaseRead: () => void }).releaseRead());
		await page.locator("#stackResourceForm").waitFor();
		const saved = page.waitForResponse(r => r.url().endsWith("/api/stacks") && r.request().method() === "POST");
		await page.locator("#stackResourceForm button[type=submit]").click();
		assert.equal((await saved).status(), 200);
		await page.locator(".stack-row").filter({ hasText: "Read race" }).waitFor();
		assert.equal(await page.locator("#itemContent").inputValue(), "new work during file read");
		assert.ok(await page.locator("#dirtyBadge.visible").isVisible());
		assert.ok(existsSync(join(promptStacksDir(cwd), "read-race.json")));
	});
});
