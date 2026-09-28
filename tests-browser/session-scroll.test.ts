import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright-core";
import { createContext, createHarness, latestEditorUrl, startSession, writeStack } from "../tests/helpers/index-command-harness.ts";

async function wheelInside(page: Page, selector: string): Promise<void> {
	const pane = page.locator(selector);
	const box = await pane.boundingBox();
	assert.ok(box);
	const y = Math.max(box.y, 0) + Math.min(100, (Math.min(box.y + box.height, page.viewportSize()!.height) - Math.max(box.y, 0)) / 2);
	await page.mouse.move(box.x + box.width / 2, y);
	await page.mouse.wheel(0, 500);
	await page.waitForFunction((s) => (document.querySelector(s)?.scrollTop ?? 0) > 0, selector);
}

test("Current session constrains long content and scrolls both panes across desktop and stacked layouts", { timeout: 45_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") { t.skip("browser tests explicitly disabled"); return; }
	const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
		process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
	].find((path): path is string => !!path && existsSync(path));
	assert.ok(executablePath, "Set CHROME_PATH to run browser acceptance.");
	const cwd = mkdtempSync(join(tmpdir(), "forge-session-scroll-"));
	writeStack(cwd, "base.json", { schemaVersion: 2, type: "pi-forge.prompt-stack", id: "base", name: "Scroll fixture", autoActivate: true, mode: "replace", items: [
		{ id: "system", kind: "block", role: "system", content: Array.from({ length: 180 }, (_, i) => `Synthetic long context line ${i + 1}`).join("\n") },
		{ id: "history", kind: "slot", slot: "chat-history", options: { includeSummaries: true } },
	] });
	const tools = Array.from({ length: 90 }, (_, i) => `fixture_tool_${i}`);
	const harness = createHarness({ activeTools: tools, allTools: tools });
	const context = createContext(cwd);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	try {
		await startSession(harness, context.ctx);
		await harness.commands.preset.handler("ui", context.ctx);
		browser = await chromium.launch({ executablePath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.setDefaultTimeout(5_000);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
		await page.goto(latestEditorUrl(context.editors).href);
		await page.locator("#itemContent").fill("Unsaved draft survives session navigation.");
		await page.locator("#sessionSurfaceBtn").click();
		await page.locator(".session-inspector .section-text").first().waitFor();
		// Stress scrolling with full text; the accepted Preview now defaults to excerpts.
		await page.locator(".session-inspector .inspection-full-toggle").click();
		const viewports = [[1440, 900], [901, 700], [900, 700], [850, 700], [821, 700], [820, 700], [800, 700], [390, 844], [820, 560], [390, 500], [1440, 560]];
		for (const [index, [width, height]] of viewports.entries()) {
			await page.setViewportSize({ width, height });
			await page.locator("#localeSelect").selectOption(index % 2 ? "zh-CN" : "en");
			await page.evaluate(() => {
				for (const s of [".session-workspace", ".capabilities-body", ".session-inspector .context-diff-compiled"]) document.querySelector(s)!.scrollTop = 0;
			});
			const box = await page.locator("[data-session-capabilities]").boundingBox();
			assert.ok(box && box.height > 0 && box.y + box.height <= height + 1, `${width}: Current session must fit the viewport`);
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${width}: no horizontal page overflow`);
			if (width > 820) {
				await wheelInside(page, ".capabilities-body");
			} else {
				await wheelInside(page, ".session-workspace");
				await page.locator(".session-inspector").scrollIntoViewIfNeeded();
			}
			await wheelInside(page, ".session-inspector .context-diff-compiled");
			await page.locator(".session-inspector .context-diff-compiled").evaluate((el) => { el.scrollTop = el.scrollHeight; });
			const lastLine = await page.locator(".session-inspector .section-text").first().evaluate((el) => {
				const pane = el.closest(".context-diff-compiled")!;
				return { contentBottom: el.getBoundingClientRect().bottom, paneBottom: pane.getBoundingClientRect().bottom };
			});
			assert.ok(lastLine.contentBottom <= lastLine.paneBottom + 1, `${width}: full text bottom remains reachable`);
			assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1 && window.scrollY === 0), `${width}: scrolling stays inside Session, not the document`);
			if (process.env.PI_FORGE_UI_SCREENSHOT_DIR) {
				mkdirSync(process.env.PI_FORGE_UI_SCREENSHOT_DIR, { recursive: true });
				await page.screenshot({ path: join(process.env.PI_FORGE_UI_SCREENSHOT_DIR, `session-scroll-${width}-${height}.png`) });
			}
		}
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator("#stacksSurfaceBtn").click();
		assert.equal(await page.locator("#itemContent").inputValue(), "Unsaved draft survives session navigation.");
		assert.ok(await page.locator("#dirtyBadge").isVisible());
		assert.ok(await page.evaluate(() => !document.querySelector(".app-root")!.classList.contains("session-surface-open")));
		await page.locator("#sessionSurfaceBtn").click();
		await page.locator(".session-inspector .section-text").first().waitFor();
		await page.locator(".session-workspace").evaluate((el) => { el.scrollTop = 0; });
		await wheelInside(page, ".session-workspace");
		assert.ok(await page.evaluate(() => window.scrollY === 0));
		assert.deepEqual(errors, []);
	} finally {
		await browser?.close();
		await harness.commands.preset.handler("ui stop", context.ctx);
		await harness.events.session_shutdown?.({ type: "session_shutdown", reason: "exit" }, context.ctx);
		rmSync(cwd, { recursive: true, force: true });
	}
});
