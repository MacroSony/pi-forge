import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

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

function createRealAgentMessages() {
	// Construct realistic multi-turn AgentMessage sequence:
	// Turn 1: User asks to inspect configs and check health
	const user1: UserMessage = {
		role: "user",
		content: [{ type: "text", text: "Please inspect the server configuration and verify endpoints." }],
		timestamp: 1000,
	};

	// Assistant calls two tools: read config and curl endpoint
	const asst1: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "I will inspect configs/server.json and ping the health endpoint." },
			{ type: "thinking", thinking: "Checking config first, then probing HTTP port." },
			{ type: "toolCall", id: "call_read_101", name: "read", arguments: { path: "configs/server.json", limit: 20 } },
			{ type: "toolCall", id: "call_bash_102", name: "bash", arguments: { command: "curl http://localhost:8080/health" } },
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 15, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 40, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 2000,
	};

	// Inverted results: call 2 (bash) fails and arrives first; call 1 (read) succeeds and arrives second
	const longErrorLines = Array.from({ length: 30 }, (_, i) => `  trace frame ${i + 1}: at handleRequest (server.ts:${100 + i})`).join("\n");
	const resBash: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_bash_102",
		toolName: "bash",
		isError: true,
		content: [{ type: "text", text: `Error: Connection refused to port 8080\nDetailed stack trace:\n${longErrorLines}` }],
		timestamp: 3000,
	};

	const resRead: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_read_101",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: '{\n  "host": "127.0.0.1",\n  "port": 8080,\n  "name": "server-config"\n}' }],
		timestamp: 3100,
	};

	// Turn 2: User prompt acting as an explicit barrier separating batches
	const user2: UserMessage = {
		role: "user",
		content: [{ type: "text", text: "The service is stopped. Please start the service now." }],
		timestamp: 4000,
	};

	// Assistant 2 issues a start command
	const asst2: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_bash_201", name: "bash", arguments: { command: "npm run start:service" } },
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 10, output: 15, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 5000,
	};

	const resStart: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_bash_201",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text: "Service started successfully on port 8080 (pid 9999)." }],
		timestamp: 5100,
	};

	return [
		{ type: "message", id: "msg-u1", parentId: null, message: user1 },
		{ type: "message", id: "msg-a1", parentId: "msg-u1", message: asst1 },
		{ type: "message", id: "msg-rbash", parentId: "msg-a1", message: resBash },
		{ type: "message", id: "msg-rread", parentId: "msg-rbash", message: resRead },
		{ type: "message", id: "msg-u2", parentId: "msg-rread", message: user2 },
		{ type: "message", id: "msg-a2", parentId: "msg-u2", message: asst2 },
		{ type: "message", id: "msg-rstart", parentId: "msg-a2", message: resStart },
	];
}

async function withPreviewInspectorBrowser(
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

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-preview-inspector-"));

	// Preset 1: Baseline stack with chat-history slot receiving real AgentMessage stream
	writeStack(cwd, "default.json", {
		schemaVersion: 2,
		type: "pi-forge.prompt-stack",
		id: "default",
		name: "Inspector Baseline Stack",
		autoActivate: true,
		mode: "replace",
		items: [
			{ kind: "block", id: "sys-role", name: "System Instructions", enabled: true, role: "system", content: "System baseline operating prompt." },
			{ kind: "slot", id: "hist-slot", name: "Chat History", enabled: true, slot: "chat-history" },
			{ kind: "block", id: "user-final", name: "Final User Directive", enabled: true, role: "user", content: "Always maintain high reliability." },
		],
	});

	// Preset 2: Secondary preset for testing preset boundary switching
	writeStack(cwd, "secondary.json", {
		schemaVersion: 2,
		type: "pi-forge.prompt-stack",
		id: "secondary",
		name: "Secondary Preset",
		autoActivate: false,
		mode: "replace",
		items: [
			{ kind: "block", id: "sys-secondary", name: "Secondary System", enabled: true, role: "system", content: "Secondary isolated instructions." },
		],
	});

	const entries = createRealAgentMessages();
	const harness = createHarness();
	const context = createContext(cwd, entries, { leafId: "msg-rstart" });
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
		const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
		page.setDefaultTimeout(7_000);
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

test("PreviewInspector browser suite: groups default open, tools default closed, tools styling, original vs paired switching, argument hints, failures count, search auto-expansion, pre internal scroll retention without focus stealing, barriers integrity, bilingual i18n, 380px narrow layout, and preset boundary switching", { timeout: 35_000 }, async (t) => {
	await withPreviewInspectorBrowser(t, async ({ page }) => {
		// 1. Open preview tab and verify PreviewInspector renders real AgentMessages via buildPreview
		await page.locator("#previewTabBtn").click();
		const inspector = page.locator(".preview-inspector");
		await inspector.waitFor();

		// 2. Default group open / tools closed
		const batches = page.locator(".inspection-batch");
		await batches.first().waitFor();
		assert.equal(await batches.count(), 2, "Must contain exactly 2 tool batches separated by user message barrier");

		// Both batches must be open by default
		for (let i = 0; i < 2; i++) {
			const batch = batches.nth(i);
			assert.equal(await batch.evaluate((el: HTMLDetailsElement) => el.open), true, `Batch #${i + 1} must be open by default`);
		}

		// Individual tool details must be closed by default
		const toolDetails = page.locator(".inspection-tool");
		const toolCount = await toolDetails.count();
		assert.equal(toolCount, 6, "Total 6 tools across 2 batches: 4 in batch 1 + 2 in batch 2");
		for (let i = 0; i < toolCount; i++) {
			const tool = toolDetails.nth(i);
			assert.equal(await tool.evaluate((el: HTMLDetailsElement) => el.open), false, `Tool #${i + 1} must be closed by default`);
		}

		// 3. Tools tool colors & labels
		const firstBatchSummary = batches.first().locator("> summary");
		const summaryStrong = firstBatchSummary.locator("strong");
		assert.equal(await summaryStrong.textContent(), "Tools", "Batch summary must declare 'Tools'");
		// Tool badges display role indicators
		assert.equal(await toolDetails.first().locator(".tool-badge").textContent(), "TOOL");

		// 4. Argument hint & failures fold count
		// read call has path "configs/server.json" -> result has shortPath "server.json" and title "configs/server.json"
		const resultPathHint = page.locator(".result-path").first();
		await resultPathHint.waitFor();
		assert.equal(await resultPathHint.textContent(), "server.json", "Short path excerpt displayed");
		assert.equal(await resultPathHint.getAttribute("title"), "configs/server.json", "Full path in title attribute");

		// Batch 1 has 1 failed tool result (bash failure)
		const batch1Failures = batches.first().locator(".batch-failures");
		assert.equal(await batch1Failures.isVisible(), true, "Failures count badge must be visible in batch summary");
		assert.match(await batch1Failures.textContent() ?? "", /1\s+(failed|个失败)/i, "Batch 1 shows 1 failed count");

		// 5. User / System barriers not folded into groups
		// Body rows must NEVER be placed inside an inspection-batch
		const nestedBodies = await page.locator(".inspection-batch .inspection-body").count();
		assert.equal(nestedBodies, 0, "inspection-body rows must never be folded inside inspection-batch");

		// The user barrier message between Turn 1 and Turn 2 is a direct sibling between the two batches
		const barrierText = "The service is stopped. Please start the service now.";
		const userBarrier = page.locator(".context-diff-sections .inspection-body.role-user", { hasText: barrierText });
		await userBarrier.waitFor();
		assert.equal(await userBarrier.isVisible(), true, "User conversation barrier must remain a visible top-level row");

		// 6. Original vs Paired order toggle (reversing out-of-order results)
		// In Batch 1:
		// Original projection order:
		// Row 0: call read
		// Row 1: call bash
		// Row 2: result bash (failed)
		// Row 3: result read (succeeded)
		const b1Tools = batches.first().locator(".inspection-tool");
		const originalToolNames = await b1Tools.locator(".tool-name").allTextContents();
		assert.deepEqual(originalToolNames, ["read", "bash", "bash", "read"], "Original order reflects compilation arrival");

		const selectMode = page.locator(".inspection-controls select");
		// Switch to paired mode
		await selectMode.selectOption("paired");
		const pairedNote = page.locator(".inspection-order-note");
		await pairedNote.waitFor();
		assert.equal(await pairedNote.isVisible(), true, "Order note must be displayed when paired mode is active");

		// Paired order: each result is hoisted right after its matching call:
		// Row 0: call read
		// Row 1: result read
		// Row 2: call bash
		// Row 3: result bash
		const pairedToolNames = await b1Tools.locator(".tool-name").allTextContents();
		assert.deepEqual(pairedToolNames, ["read", "read", "bash", "bash"], "Paired order hoists results immediately following their calls");
        assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Display order never dirties the Preset");
        if (process.env.PI_FORGE_UI_SCREENSHOT_DIR) {
            mkdirSync(process.env.PI_FORGE_UI_SCREENSHOT_DIR, { recursive: true });
            await firstBatchSummary.scrollIntoViewIfNeeded();
            await firstBatchSummary.evaluate(el => { const pane = el.closest(".context-diff-compiled")!; pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12; });
            await page.screenshot({ path: join(process.env.PI_FORGE_UI_SCREENSHOT_DIR, "preview-paired-desktop.png") });
            await page.locator("#themeToggleBtn").click();
            await page.screenshot({ path: join(process.env.PI_FORGE_UI_SCREENSHOT_DIR, "preview-paired-dark.png") });
            await page.locator("#themeToggleBtn").click();
        }

		// Switch back to original mode
		await selectMode.selectOption("original");
		const restoredToolNames = await b1Tools.locator(".tool-name").allTextContents();
		assert.deepEqual(restoredToolNames, ["read", "bash", "bash", "read"], "Original order restored");

		// 7. Full text expand and copy
		const fullTextToggle = page.locator(".inspection-full-toggle");
		await fullTextToggle.click();
		assert.equal(await fullTextToggle.getAttribute("aria-pressed"), "true", "Full text toggle active");

		// All tools are now expanded
		const openCount = await page.locator(".inspection-tool[open]").count();
		assert.equal(openCount, 6, "All tool rows must be open in full text mode");

		// Detail pane and copy button
		const firstDetail = page.locator(".tool-detail").first();
		await firstDetail.waitFor();
		const copyButton = firstDetail.locator("button", { hasText: /copy|复制/i });
		await copyButton.waitFor();
		await copyButton.click();
		assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await firstDetail.locator("pre").textContent(), "Clipboard contains the complete displayed parameter text");

		// Toggle back to excerpts
		await fullTextToggle.click();
		assert.equal(await fullTextToggle.getAttribute("aria-pressed"), "false");
		assert.equal(await page.locator(".inspection-tool[open]").count(), 0, "Tool rows collapse when returning from full text");

		// 8. Search query matching tool fields & auto-expansion
		const searchInput = page.locator(".inspection-controls input[type='search']");
		// Search for argument hint substring
		await searchInput.fill("server.json");
		const searchCount = page.locator(".inspection-search-count");
		await searchCount.waitFor();
		assert.match(await searchCount.textContent() ?? "", /\d+\s*\/\s*\d+\s+records matched/i, "Search count reflects matching records");
		// Matching row must be automatically expanded during search
		const searchExpandedCount = await page.locator(".inspection-tool[open]").count();
		assert.ok(searchExpandedCount >= 1, "Matching row auto-expands while searching");

		// Search for result error text
		await searchInput.fill("Connection refused");
		assert.ok(await page.locator(".inspection-tool[open]").count() >= 1, "Result error body hit expands matching row");

		// Clear search
		await searchInput.fill("");

		// 9. Pre internal scroll preservation without focus stealing
		// Open the bash error row which contains a long stack trace
		const errorTool = page.locator(".tool-error").first();
		await errorTool.locator("summary").click();
		assert.equal(await errorTool.evaluate((el: HTMLDetailsElement) => el.open), true);

		const pre = errorTool.locator("pre.tool-full-text");
		await pre.waitFor();

		// Scroll pre internally and record
		await pre.evaluate((el) => {
			el.scrollTop = 90;
			el.dispatchEvent(new Event("scroll"));
		});
		const scrollPos = await pre.evaluate((el) => el.scrollTop);
		assert.ok(scrollPos > 0, "Pre must be scrolled internally");

		// Move focus to search input outside inspector pre
		await searchInput.focus();
		assert.equal(await searchInput.evaluate((el) => document.activeElement === el), true);

		// Trigger view re-rendering via fullText toggle
		await fullTextToggle.click();
		await fullTextToggle.click();

		// Internal scroll in pre must be maintained
		const scrollAfter = await pre.evaluate((el) => el.scrollTop);
		assert.equal(scrollAfter, scrollPos, "pre internal scroll position must be preserved across inspection refresh");

		// Inspector must not steal focus away to pre
		const activeTagName = await page.evaluate(() => document.activeElement?.tagName);
		assert.notEqual(activeTagName, "PRE", "Inspector refresh must never steal focus into pre");

		// Actual same-data HTTP refresh (not merely a presentation toggle).
        await pre.focus();
        const originalPre = await pre.elementHandle();
        await Promise.all([
            page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/preview") && response.request().method() === "POST"),
            page.locator(".context-diff-compiled .context-diff-refresh").evaluate((button: HTMLButtonElement) => button.click()),
        ]);
        await page.waitForTimeout(100);
        assert.ok(await originalPre!.evaluate(el => el.isConnected && document.activeElement === el), "Same-data refresh retains keyed DOM and active focus");
        assert.equal(await pre.evaluate(el => el.scrollTop), scrollPos);
        // Closing a group and refreshing must not erase its nested reading state.
        await firstBatchSummary.click();
        await page.locator(".context-diff-compiled .context-diff-refresh").click();
        await page.waitForTimeout(100);
        assert.equal(await batches.first().evaluate((el: HTMLDetailsElement) => el.open), false);
        await firstBatchSummary.click();
        assert.equal(await pre.evaluate(el => el.scrollTop), scrollPos);
        await searchInput.fill("Service started successfully");
        await searchInput.fill("");
        assert.equal(await pre.evaluate(el => el.scrollTop), scrollPos, "Search removal/remount retains nested scroll memory");

        // 10. Bilingual i18n switching
		// Switch to Chinese
		await page.locator("#localeSelect").selectOption("zh-CN");
		await page.locator("html[lang='zh-CN']").waitFor();

		// Check Chinese inspector UI copy
		assert.match(await page.locator(".inspection-controls select option[value='original']").textContent() ?? "", /原始顺序/);
		assert.match(await page.locator(".inspection-controls select option[value='paired']").textContent() ?? "", /按调用配对/);
		assert.match(await page.locator(".inspection-full-toggle").textContent() ?? "", /全文/);
		assert.match(await page.locator(".inspection-controls input[type='search']").getAttribute("placeholder") ?? "", /搜索/);
		assert.match(await batches.first().locator("> summary").textContent() ?? "", /次调用/);

		// Switch back to English
		await page.locator("#localeSelect").selectOption("en");
		await page.locator("html[lang='en']").waitFor();
		assert.match(await page.locator(".inspection-controls select option[value='original']").textContent() ?? "", /Original order/);
		assert.match(await page.locator(".inspection-full-toggle").textContent() ?? "", /Full text/);

		// 11. 380px narrow column layout
		await page.setViewportSize({ width: 380, height: 800 });
		// Position badges are hidden at narrow widths (<=520px container query)
		const positionBadge = page.locator(".inspection-position").first();
		assert.equal(await positionBadge.isVisible(), false, "Position index hidden on narrow 380px column");

		// Reachability is not just a width assertion: both stacked work areas must work.
        assert.ok(await page.locator("#workspace").isVisible(), "The narrow editor must not collapse away");
        await page.locator("#itemContent").scrollIntoViewIfNeeded();
        const editorBox = await page.locator("#itemContent").boundingBox();
        assert.ok(editorBox && editorBox.y < 800 && editorBox.y + editorBox.height > 0, "Editor content is reachable before returning to Preview");
        await page.locator(".inspection-controls").scrollIntoViewIfNeeded();
        const controlsBox = await page.locator(".inspection-controls").boundingBox();
        assert.ok(controlsBox && controlsBox.y < 800 && controlsBox.y + controlsBox.height > 0, "Narrow Preview controls are actually reachable");
        assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && scrollY === 0), "Open narrow Preset scrolls inside its dock, not a clipped document");
        // Inspector controls wrap gracefully without overflowing viewport width
		const inspectorBox = await inspector.boundingBox();
		assert.ok(inspectorBox && inspectorBox.width <= 380, "Inspector fits within 380px viewport");

		if (process.env.PI_FORGE_UI_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.PI_FORGE_UI_SCREENSHOT_DIR, "preview-mobile.png"), fullPage: true });
        // Restore viewport
		await page.setViewportSize({ width: 1440, height: 900 });

		// 12. Preset boundary switching resets search query and open sets
		await searchInput.fill("configs");
		assert.equal(await searchInput.inputValue(), "configs");

		// Switch to Secondary Preset in preset list
		await page.locator(".stack-row").filter({ hasText: "Secondary Preset" }).click();
		await page.locator(".context-diff-sections").filter({ hasText: "Secondary isolated instructions." }).waitFor();

		// Boundary change cleanly resets search query
		assert.equal(await searchInput.inputValue(), "", "Preset boundary switch must reset search query");

		// Switch back to Inspector Baseline Stack
		await page.locator(".stack-row").filter({ hasText: "Inspector Baseline Stack" }).click();
		await page.locator(".context-diff-sections").filter({ hasText: "System baseline operating prompt." }).waitFor();
		assert.equal(await searchInput.inputValue(), "", "Returning to preset has clean fresh search query");
	});
});
