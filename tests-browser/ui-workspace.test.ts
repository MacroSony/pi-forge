import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeStack,
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

function findChromeExecutable(): string | undefined {
	return [
		process.env.CHROME_PATH,
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

test("workspace V4 keeps activation guarded and state distinct", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-workspace-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		name: "Workspace default",
		autoActivate: true,
		mode: "replace",
		items: [
			{ kind: "block", id: "system", name: "System instructions", enabled: true, role: "system", content: "Original workspace content." },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history", options: { includeSummaries: true } },
		],
	});

	const harness = createHarness();
	const context = createContext(cwd);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	let sessionStarted = false;
	try {
		await startSession(harness, context.ctx);
		sessionStarted = true;
		await harness.commands.preset.handler("ui", context.ctx);
		browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
		const page = await browser.newPage();
		page.setDefaultTimeout(5_000);
		const editorUrl = latestEditorUrl(context.editors);
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();

		const diskPath = join(promptStacksDir(cwd), "default.json");
		const before = readFileSync(diskPath, "utf8");
		assert.equal(await page.locator(".stack-row.active").count(), 1);

		await page.locator("#itemContent").fill("Unsaved workspace content.");
		await page.locator("#dirtyBadge.visible").waitFor();
		assert.equal(await page.locator("#activateBtn").isDisabled(), true);
		await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>("#activateBtn");
			if (!button) throw new Error("activate button missing");
			button.disabled = false;
			button.click();
		});
		assert.match(await page.locator("#status").textContent() ?? "", /Save this preset before activating/);
		await page.locator("#localeSelect").selectOption("zh-CN");
		assert.match(await page.locator("#status").textContent() ?? "", /请先保存|Save this preset/);
		assert.doesNotMatch(await page.locator("#status").textContent() ?? "", /Loading/);
		assert.equal(readFileSync(diskPath, "utf8"), before);
		assert.equal(await page.locator(".stack-row.active").count(), 1);

		await page.locator("#metadataToggleBtn").click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true);
		await page.locator("#metadataToggleBtn").click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true);

		await page.locator("#itemsTabBtn").click();
		const firstRow = page.locator("#itemList .item-row").first();
		assert.equal(await firstRow.getAttribute("role"), "option");
		assert.equal(await firstRow.getAttribute("aria-selected"), "true");
		assert.equal(await firstRow.getAttribute("tabindex"), "0");
		await firstRow.focus();
		await page.keyboard.press("Enter");
		assert.equal(await page.evaluate(() => document.activeElement?.matches("#itemList .item-row") ?? false), true, "Enter selection should retain row focus");
		await page.keyboard.press("Space");
		assert.equal(await page.evaluate(() => document.activeElement?.matches("#itemList .item-row") ?? false), true, "Space selection should retain row focus");
		await page.locator("#itemProperties summary").click();
		await page.locator("#itemId").waitFor({ state: "visible" });
		await page.locator("#itemRole").selectOption("user");
		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
		const saved = JSON.parse(readFileSync(diskPath, "utf8"));
		assert.equal(saved.items[0].id, "system");
		assert.equal(saved.items[0].role, "user");
	} finally {
		await browser?.close();
		if (sessionStarted) await harness.commands.preset.handler("ui stop", context.ctx);
		rmSync(cwd, { recursive: true, force: true });
	}
});
