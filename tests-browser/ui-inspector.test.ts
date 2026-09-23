import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeStack,
} from "../tests/helpers/index-command-harness.ts";

function findChromeExecutable(): string | undefined {
	return process.env.CHROME_PATH || [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
	].find((path): path is string => !!path && existsSync(path));
}

async function withUiInspectorFixture(
	t: TestContext,
	run: (fixture: {
		cwd: string;
		editorUrl: URL;
		page: Page;
		harness: ReturnType<typeof createHarness>;
		context: ReturnType<typeof createContext>;
	}) => Promise<void>,
): Promise<void> {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-ui-inspector-"));
	writeStack(cwd, "default.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "default",
		name: "Inspector Baseline Stack",
		autoActivate: true,
		mode: "replace",
		items: [
			{ kind: "block", id: "system", name: "System Role", enabled: true, role: "system", content: "System baseline prompt instructions." },
			{ kind: "block", id: "user-role", name: "User Input", enabled: true, role: "user", content: "User prompt query." },
		],
	});
	writeStack(cwd, "inactive.json", {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "inactive",
		name: "Inactive Preset",
		autoActivate: false,
		mode: "replace",
		items: [
			{ kind: "block", id: "system", name: "Inactive System", enabled: true, role: "system", content: "Inactive system prompt." },
		],
	});

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);
	let browser: Browser | undefined;
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
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
		page.setDefaultTimeout(5_000);
		page.on("pageerror", (error) => browserErrors.push(error.message));

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();

		await run({ cwd, editorUrl, page, harness, context });

		assert.deepEqual(browserErrors, [], "No browser console errors expected");
	} finally {
		await browser?.close();
		if (editorStarted) {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
		await harness.events.session_shutdown?.({ type: "session_shutdown", reason: "exit" }, context.ctx);
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("V4 inspection: 3-state cycle (side->wide->focus->side), arrow handle, per-tab reading preference", { timeout: 30_000 }, async (t) => {
	await withUiInspectorFixture(t, async ({ page, cwd }) => {
		// 1. Open the preview dock
		await page.locator("#previewTabBtn").click();
		const dockArea = page.locator("#editorDockArea");
		await dockArea.waitFor();
		assert.ok(await dockArea.evaluate((el) => el.classList.contains("dock-open")), "Dock must be open");

		// 2. Baseline preview starts in side reading mode
		await page.locator(".context-diff-sections").waitFor();
		const initialReading = await dockArea.getAttribute("data-reading");
		assert.equal(initialReading, "side", "Compiled preview tab must start in side reading mode");
		assert.ok(await page.locator("#workspace").isVisible(), "Workspace editor must remain visible in side mode");

		// In side mode, scope badge is hidden to prevent narrow overcrowding
		const scopeBadge = page.locator(".scope-badge");
		if (await scopeBadge.count() > 0) {
			assert.equal(await scopeBadge.isVisible(), false, "Scope badge should be hidden in side mode");
		}

		// 3. Arrow handle geometry & accessibility
		const cycleButton = page.locator("#readingCycleBtn, #focus-toggle");
		await cycleButton.waitFor();
		const cycleBox = await cycleButton.boundingBox();
		assert.ok(cycleBox, "Cycle button must have layout dimensions");
		const paneBox = await page.locator("#contextDiffPanel").boundingBox();
		assert.ok(paneBox);
		assert.ok(Math.abs(cycleBox.x + cycleBox.width / 2 - paneBox.x) <= 2, "Reading handle must straddle the actual pane boundary, not a nested header");
		assert.ok(paneBox.width >= 330 && paneBox.width <= 360, "Sidebar preview has bounded width");
		const contentBox = await page.locator("#itemContent").boundingBox();
		assert.ok(contentBox && contentBox.width >= 500, "Desktop preview must leave a readable central editor");
		assert.ok(Math.abs(cycleBox.width - 30) <= 2, `Button width should be ~30px, got ${cycleBox.width}`);
		assert.ok(Math.abs(cycleBox.height - 30) <= 2, `Button height should be ~30px, got ${cycleBox.height}`);

		// Next action aria/title in side mode: widen
		const sideTitle = await cycleButton.getAttribute("title");
		assert.match(sideTitle ?? "", /widen|加宽/i, "Next action title in side mode must describe widening");

		// Role color labels: subtle strip and badge, theme variable usage
		const systemSection = page.locator(".context-diff-section.role-system");
		await systemSection.waitFor();
		const roleBadge = systemSection.locator(".section-role");
		assert.equal(await roleBadge.textContent(), "system");

		// 4. Cycle side -> wide
		await cycleButton.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "wide", "First cycle must switch to wide reading mode");
		assert.ok(await page.locator("#workspace").isVisible(), "Workspace editor must remain visible in wide mode");
		const wideTitle = await cycleButton.getAttribute("title");
		assert.match(wideTitle ?? "", /focus|收起编辑|hide editor/i, "Next action title in wide mode must describe focusing");
		if (await scopeBadge.count() > 0) {
			assert.equal(await scopeBadge.isVisible(), true, "Scope badge should be visible in wide mode");
		}

		// 5. Cycle wide -> focus
		await cycleButton.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "focus", "Second cycle must switch to focus reading mode");
		assert.equal(await page.locator("#workspace").isVisible(), false, "Workspace editor must be hidden in focus mode");
		const focusTitle = await cycleButton.getAttribute("title");
		assert.match(focusTitle ?? "", /restore|返回侧栏|sidebar/i, "Next action title in focus mode must describe restoring sidebar");

		// 6. Cycle focus -> side
		await cycleButton.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "side", "Third cycle must return to side reading mode");
		assert.ok(await page.locator("#workspace").isVisible(), "Workspace editor must be visible again in side mode");

		// 7. Per-tab preference & first diff focus
		// Switch to Draft diff tab -> should default to focus mode on first entry
		const draftTabBtn = page.locator('.context-diff-mode-tabs button[role="tab"]', { hasText: /Draft diff/i });
		await draftTabBtn.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "focus", "First entry into Draft diff must default to focus reading mode");

		// Manually change Draft diff to wide mode
		await cycleButton.click(); // focus -> side
		await cycleButton.click(); // side -> wide
		assert.equal(await dockArea.getAttribute("data-reading"), "wide", "Draft diff changed to wide mode");

		// Switch back to Preview tab -> should restore its previous state (side)
		const previewTabBtn = page.locator('.context-diff-mode-tabs button[role="tab"]', { hasText: /Preview/i });
		await previewTabBtn.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "side", "Returning to Preview tab must retain its side preference");

		// Switch back to Draft diff tab -> should retain user's manual selection (wide)
		await draftTabBtn.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "wide", "Returning to Draft diff tab must retain user's manual wide preference");

		// Switch to Run diff tab -> first entry must default to focus
		const runTabBtn = page.locator('.context-diff-mode-tabs button[role="tab"]', { hasText: /Run diff/i });
		await runTabBtn.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "focus", "First entry into Run diff must default to focus reading mode");

		// 8. View switching never dirties clean presets
		assert.equal(await page.locator("#dirtyBadge.visible").count(), 0, "Inspecting views does not make preset dirty");

		// 9. Edit then inspect / return / save does not lose content or dirty state
		await previewTabBtn.click();
		const textarea = page.locator("#itemContent");
		await textarea.waitFor();
		await textarea.fill("Edited prompt content that must not be lost.");
		await page.locator("#dirtyBadge.visible").waitFor();

		// Inspect Draft diff
		await draftTabBtn.click();
		// Return to editing
		const returnEditBtn = page.locator("#return-editing");
		if (await returnEditBtn.isVisible()) {
			await returnEditBtn.click();
		} else {
			await previewTabBtn.click();
		}
		// Check that edited content is retained
		assert.equal(await textarea.inputValue(), "Edited prompt content that must not be lost.");
		assert.ok(await page.locator("#dirtyBadge.visible").isVisible(), "Dirty badge must remain visible without unexpected discard");

		// Save and verify
		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
		const savedOnDisk = JSON.parse(readFileSync(join(cwd, ".pi", "forge", "prompt-stacks", "default.json"), "utf8"));
		assert.equal(savedOnDisk.items[0].content, "Edited prompt content that must not be lost.", "Saved disk content matches edit");

		// 10. Pure preview does not activate inactive presets
		assert.match(await page.locator(".stack-row.active .stack-name").textContent() ?? "", /default/);
		await page.locator(".stack-row").filter({ hasText: "Inactive Preset" }).click();
		await page.locator("#status").filter({ hasText: /Loaded inactive/i }).waitFor();
		await previewTabBtn.click();
		await page.locator(".context-diff-sections").filter({ hasText: "Inactive system prompt." }).waitFor();
		assert.match(await page.locator(".stack-row.active .stack-name").textContent() ?? "", /default/, "Previewing inactive preset must never activate it");
		assert.equal(await page.locator(".stack-row").filter({ hasText: "Inactive Preset" }).evaluate((el) => el.classList.contains("active")), false, "Inactive preset must remain inactive");

		// 11. Responsive boundary fallback prevents viewport clipping
		await page.setViewportSize({ width: 1000, height: 750 });
		const narrowBox = await cycleButton.boundingBox();
		assert.ok(narrowBox, "Cycle button must remain measurable on narrow view");
		assert.ok(narrowBox.x >= 0, `Button x position (${narrowBox.x}) must not be clipped off-screen to the left`);
	});
});

test("deleting the last preset while inspection is focused restores the empty editor", { timeout: 30_000 }, async t => {
 await withUiInspectorFixture(t, async ({ page }) => {
  page.on("dialog", dialog => dialog.accept());
  await page.locator('.stack-row').filter({ hasText: 'Inactive Preset' }).click();
  await page.locator('#moreActions > summary').click();
  await page.locator('#deleteStackBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.stack-row').length === 1);
  await page.locator('#previewTabBtn').click();
  await page.locator('[data-reading-cycle]').click();
  await page.locator('[data-reading-cycle]').click();
  assert.equal(await page.locator('#editorDockArea').getAttribute('data-reading'), 'focus');
  if (!(await page.locator('#deleteStackBtn').isVisible())) await page.locator('#moreActions > summary').click();
  await page.locator('#deleteStackBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.stack-row').length === 0);
  assert.equal(await page.locator('#emptyNewStackBtn').isVisible(), true, 'Empty-state recovery must not be hidden behind the focused dock');
  assert.equal(await page.locator('#contextDiffPanel').isVisible(), false);
  assert.equal(await page.locator('#saveBtn').isDisabled(), true);
 });
});
