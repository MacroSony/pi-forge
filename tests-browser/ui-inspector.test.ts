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

test("inspection: reading controls, layout-stable tabs, draft save, and preview geometry", { timeout: 30_000 }, async (t) => {
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
		const cycleButton = page.locator("#focus-toggle");
		await cycleButton.waitFor();
		const cycleBox = await cycleButton.boundingBox();
		assert.ok(cycleBox && cycleBox.width >= 24 && cycleBox.height >= 24, "Reading control must have a usable target");
		const pane = page.locator("#contextDiffPanel");
		const paneBox = await pane.boundingBox();
		assert.ok(paneBox && paneBox.width > 0 && paneBox.height > 0, "Preview pane must be laid out");
		const workspaceBox = await page.locator("#workspace").boundingBox();
		assert.ok(workspaceBox && workspaceBox.width > 0, "Editor stays visible beside Preview");
		assert.ok(cycleBox.x >= paneBox.x && cycleBox.x + cycleBox.width <= paneBox.x + paneBox.width, "Reading handle must not overlap the editing pane");

		// Next action aria/title in side capability: widen
		const sideTitle = await cycleButton.getAttribute("title");
		assert.match(sideTitle ?? "", /widen|加宽/i, "Next action title in side layout must describe widening");

		// Role color labels: subtle strip and badge, theme variable usage
		const systemSection = page.locator(".context-diff-section.role-system");
		await systemSection.waitFor();
		const roleBadge = systemSection.locator(".section-role");
		assert.equal(await roleBadge.textContent(), "system");
        const rowSeparators = await page.locator(".item-row:not(.selected)").evaluateAll(rows => rows.map(row => {
            const style = getComputedStyle(row);
            return parseFloat(style.borderBottomWidth) > 0 && style.borderBottomColor !== "rgba(0, 0, 0, 0)";
        }));
        assert.ok(rowSeparators.length > 0 && rowSeparators.every(Boolean), "Unselected Stack items retain visible separators");

		// 4. Side -> wide uses the boundary control; wide exposes the separate focus control.
		await cycleButton.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "wide", "Boundary control must widen the Preview pane");
		assert.ok(await page.locator("#workspace").isVisible(), "Workspace editor must remain visible in wide mode");
		const wideTitle = await cycleButton.getAttribute("title");
		assert.match(wideTitle ?? "", /shrink|收窄|sidebar/i, "Boundary control in wide mode must describe returning to the sidebar layout");
		const focusButton = page.locator("#reading-focus-btn");
		await focusButton.waitFor();
		const focusBox = await focusButton.boundingBox();
		const widePaneBox = await pane.boundingBox();
		assert.ok(focusBox && focusBox.width >= 24 && focusBox.height >= 24, "Focus control must have a usable target");
		assert.ok(widePaneBox && widePaneBox.width > 0 && widePaneBox.height > 0, "Wide Preview pane must be laid out");
		assert.equal(await pane.locator("#reading-focus-btn").count(), 1, "Focus control must be inside Preview");
		assert.ok(focusBox.x >= widePaneBox.x && focusBox.x + focusBox.width <= widePaneBox.x + widePaneBox.width, "Focus control must remain wholly inside Preview");
		assert.ok(focusBox.y < widePaneBox.y + widePaneBox.height && focusBox.y + focusBox.height > widePaneBox.y, "Focus control must overlap the Preview geometry");
		if (await scopeBadge.count() > 0) {
			assert.equal(await scopeBadge.isVisible(), true, "Scope badge should be visible in wide mode");
		}

		// 5. Wide -> focus uses the separate focus control.
		await focusButton.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "focus", "Focus control must hide the editor for focused reading");
		assert.equal(await page.locator("#workspace").isVisible(), false, "Workspace editor must be hidden in focus mode");
		const focusTitle = await cycleButton.getAttribute("title");
		assert.match(focusTitle ?? "", /restore|previous|返回|sidebar/i, "Boundary control in focus mode must describe restoring the editor");

		// 6. Focus restores wide, then wide returns to side.
		await cycleButton.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "wide", "Focus restore must return to the prior wide layout");
		await cycleButton.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "side", "Boundary control must return to side reading mode");
		assert.ok(await page.locator("#workspace").isVisible(), "Workspace editor must be visible again in side mode");

		// 7. Content tabs preserve panel geometry in every layout, even after
		// an explicit focus and restore. There are no hidden per-tab preferences.
		const draftTabBtn = page.locator('.context-diff-mode-tabs button[role="tab"]', { hasText: /Draft diff/i });
		const previewTabBtn = page.locator('.context-diff-mode-tabs button[role="tab"]', { hasText: /Preview/i });
		const runTabBtn = page.locator('.context-diff-mode-tabs button[role="tab"]', { hasText: /Run diff/i });
		for (const layout of ["side", "wide", "focus"] as const) {
			if (layout === "wide") await cycleButton.click();
			if (layout === "focus") await focusButton.click();
			const before = await pane.boundingBox();
			for (const tab of [draftTabBtn, runTabBtn, previewTabBtn, draftTabBtn]) {
				await tab.click();
				assert.equal(await dockArea.getAttribute("data-reading"), layout);
				assert.equal(await page.locator("#workspace").isVisible(), layout !== "focus");
				const after = await pane.boundingBox();
				assert.ok(before && after);
				assert.equal(after.x, before.x, "Changing content does not move the panel");
				assert.equal(after.width, before.width, "Changing content does not resize the panel");
			}
		}
		await cycleButton.click();
		assert.equal(await dockArea.getAttribute("data-reading"), "wide");
		await cycleButton.click();

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
		await page.setViewportSize({ width: 850, height: 750 });
        await page.locator("#itemsTabBtn").click();
        assert.equal(await page.locator("#workspace").isVisible(), true, "850px editor navigation must not remain hidden behind Preview");
		const narrowBox = await cycleButton.boundingBox();
		assert.ok(narrowBox, "Cycle button must remain measurable on narrow view");
		assert.ok(narrowBox.x >= 0, `Button x position (${narrowBox.x}) must not be clipped off-screen to the left`);
	});
});

test("deleting the last preset while inspection is focused restores the empty editor", { timeout: 30_000 }, async t => {
 await withUiInspectorFixture(t, async ({ page }) => {
  await page.locator('.stack-row').filter({ hasText: 'Inactive Preset' }).click();
  const moreActions = page.locator('#moreActions');
  await moreActions.locator('summary').click();
  page.once('dialog', async dialog => {
   assert.match(dialog.message(), /inactive/i);
   await dialog.accept();
  });
  await page.locator('#deleteStackBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.stack-row').length === 1);
  await page.locator('#previewTabBtn').click();
  await page.locator('#focus-toggle').click();
  await page.locator('#reading-focus-btn').click();
  assert.equal(await page.locator('#editorDockArea').getAttribute('data-reading'), 'focus');
  if (!(await page.locator('#deleteStackBtn').isVisible())) await moreActions.locator('summary').click();
  page.once('dialog', async dialog => {
   assert.match(dialog.message(), /default/i);
   await dialog.accept();
  });
  await page.locator('#deleteStackBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.stack-row').length === 0);
  assert.equal(await page.locator('#emptyNewStackBtn').isVisible(), true, 'Empty-state recovery must not be hidden behind the focused dock');
  assert.equal(await page.locator('#contextDiffPanel').isVisible(), false);
  assert.equal(await page.locator('#saveBtn').isDisabled(), true);
 });
});
