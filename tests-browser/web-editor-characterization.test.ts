import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { chromium, type Page } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeStack,
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

test("web editor preserves its shell and guarded editing state", { timeout: 20_000 }, async (t) => {
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", stackFixture("default", "Default stack", true));
		writeStack(cwd, "alternate.json", stackFixture("alternate", "Alternate stack"));
	}, async ({ editorUrl, page }) => {
		const unauthorizedUrl = new URL(editorUrl);
		unauthorizedUrl.search = "";
		const unauthorized = await page.request.get(unauthorizedUrl.href);
		assert.equal(unauthorized.status(), 403);
		assert.equal(await unauthorized.text(), "Invalid pi-forge editor token.");

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		assert.equal(await page.title(), "pi-forge stack editor");
		assert.equal(await page.locator(".brand").textContent(), "pi-forge stack editor");
		assert.equal(await page.locator(".stack-row").count(), 2);
		assert.equal(await page.locator("#status").textContent(), "Loaded default");
		assert.equal(await page.locator("#itemContent").inputValue(), "Content for default.");
		assert.equal(await page.locator("#settings").isVisible(), false);

		const initialTheme = await page.locator("body").getAttribute("data-theme");
		assert.ok(initialTheme === "light" || initialTheme === "dark");
		await page.locator("#themeBtn").click();
		const toggledTheme = initialTheme === "light" ? "dark" : "light";
		assert.equal(await page.locator("body").getAttribute("data-theme"), toggledTheme);
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		assert.equal(await page.locator("body").getAttribute("data-theme"), toggledTheme);

		await page.locator("#sidebarToggleBtn").click();
		assert.equal(await page.locator("#shell").getAttribute("class"), "shell sidebar-collapsed");
		assert.equal(await page.locator("#status").textContent(), "Prompt stacks sidebar hidden");
		await page.locator("#sidebarToggleBtn").click();
		assert.equal(await page.locator("#shell").getAttribute("class"), "shell");

		await page.locator("#itemContent").fill("Unsaved content.");
		await page.locator("#dirtyBadge.visible").waitFor();

		page.once("dialog", async (dialog) => {
			assert.equal(dialog.type(), "confirm");
			assert.equal(dialog.message(), "Discard unsaved changes?");
			await dialog.dismiss();
		});
		await page.locator(".stack-row", { hasText: "alternate" }).click();
		assert.equal(await page.locator(".stack-row.selected .stack-name").textContent(), "defaultactive");
		assert.equal(await page.locator("#itemContent").inputValue(), "Unsaved content.");

		page.once("dialog", async (dialog) => {
			assert.equal(dialog.message(), "Discard unsaved changes?");
			await dialog.accept();
		});
		await page.locator(".stack-row", { hasText: "alternate" }).click();
		await page.locator("#status").filter({ hasText: "Loaded alternate" }).waitFor();
		assert.equal(await page.locator("#itemContent").inputValue(), "Content for alternate.");

		await page.locator("#stackTabBtn").click();
		const rawStack = JSON.parse(await page.locator("#stackJsonText").inputValue()) as Record<string, unknown>;
		await page.locator("#stackJsonText").fill(JSON.stringify({ id: "alternate" }));
		await page.locator("#applyStackJsonBtn").click();
		assert.equal(await page.locator("#status").textContent(), "Stack JSON needs an items array.");

		rawStack.name = "Raw JSON edit";
		rawStack.items = [{ kind: "block", id: "raw", role: "system", content: "Raw content." }];
		await page.locator("#stackJsonText").fill(JSON.stringify(rawStack));
		await page.locator("#applyStackJsonBtn").click();
		await page.locator("#status").filter({ hasText: "Applied stack JSON to editor" }).waitFor();
		await page.locator("#dirtyBadge.visible").waitFor();
		await page.locator("#itemsTabBtn").click();
		assert.equal(await page.locator("#itemContent").inputValue(), "Raw content.");
	});
});

test("web editor transitions between populated and empty stack states", { timeout: 20_000 }, async (t) => {
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "only.json", stackFixture("only", "Only stack", true));
	}, async ({ cwd, editorUrl, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();
		await page.locator("#regexTabBtn").click();
		await page.locator("#addRegexRuleBtn").waitFor();

		page.once("dialog", async (dialog) => {
			assert.match(dialog.message(), /Delete prompt stack 'only'/);
			await dialog.accept();
		});
		await page.locator("#deleteStackBtn").click();
		await page.locator(".empty-title").filter({ hasText: "No prompt stacks found." }).waitFor();
		assert.equal(await page.locator("#saveBtn").isDisabled(), true);
		assert.equal(await page.locator("#metadataPanel").isVisible(), false);
		assert.equal(existsSync(join(promptStacksDir(cwd), "only.json")), false);

		const promptAnswers = ["replacement", "Replacement stack"];
		page.on("dialog", async (dialog) => {
			assert.equal(dialog.type(), "prompt");
			const answer = promptAnswers.shift();
			assert.notEqual(answer, undefined);
			await dialog.accept(answer);
		});
		await page.locator("#emptyNewStackBtn").click();
		await page.locator("#status").filter({ hasText: "Created replacement" }).waitFor();
		assert.equal(await page.locator(".stack-row.selected .stack-name").textContent(), "replacementactive");
		assert.equal(await page.locator("#saveBtn").isEnabled(), true);
		assert.equal(existsSync(join(promptStacksDir(cwd), "replacement.json")), true);
		assert.deepEqual(promptAnswers, []);
	});
});

test("Vue tabs preserve drafts, errors, and unknown fields", { timeout: 20_000 }, async (t) => {
	await withBrowserEditor(t, (cwd) => {
		writeStack(cwd, "default.json", {
			...stackFixture("default", "Vue tab stack", true),
			tools: {
				allow: ["*"],
			},
			regex: {
				schemaVersion: 1,
				rules: [{
					id: "existing",
					enabled: true,
					stage: "compiled",
					effect: "outgoing",
					targets: ["messages"],
					pattern: "Content",
					replace: "Text",
					futureRuleField: { preserve: true },
				}],
			},
		});
		writeStack(cwd, "alternate.json", stackFixture("alternate", "Alternate stack"));
	}, async ({ cwd, editorUrl, page }) => {
		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();

		await page.locator("#stackTabBtn").click();
		await page.locator("#metadataToggleBtn").click();
		await page.locator("#stackName").fill("Vue tabs edited");
		await page.locator("#allowDuplicateChatHistoryInput").check();
		await page.locator("#addVariableBtn").click();
		await page.locator("#addVariableBtn").click();
		const variableRows = page.locator("[data-var-row]");
		await variableRows.nth(0).locator("[data-var-value]").fill("first");
		await variableRows.nth(1).locator("[data-var-name]").fill("var1");
		await variableRows.nth(1).locator("[data-var-value]").fill("second");
		assert.equal(await page.locator("#status").textContent(), "Duplicate stack variable names.");
		await page.locator("#itemsTabBtn").click();
		await page.locator("#stackTabBtn").click();
		await page.locator("#saveBtn").click();
		await page.locator("#status")
			.filter({ hasText: "Duplicate stack variable names." })
			.waitFor();
		assert.equal(await page.locator("[data-var-row]").count(), 1);
		await page.locator("[data-var-row] [data-var-value]").fill("resolved");
		await page.locator("#itemsTabBtn").click();
		await page.locator("#stackTabBtn").click();

		const rawStack = JSON.parse(await page.locator("#stackJsonText").inputValue()) as {
			context?: Record<string, unknown>;
			tools?: Record<string, unknown>;
			variables?: Record<string, unknown>;
		};
		assert.ok(rawStack.tools);
		rawStack.tools.futurePolicyField = { preserve: true };
		await page.locator("#stackJsonText").fill(JSON.stringify(rawStack));
		await page.locator("#applyStackJsonBtn").click();
		await page.locator("#status").filter({ hasText: "Applied stack JSON to editor" }).waitFor();

		await page.locator("#regexTabBtn").click();
		const regexRow = page.locator("[data-regex-row]").first();
		await regexRow.locator("[data-regex-max-messages]").fill("0");
		assert.match(
			await page.locator("#status").textContent() ?? "",
			/maxMessages must be a positive integer/,
		);
		await page.locator("#itemsTabBtn").click();
		await page.locator("#regexTabBtn").click();
		await page.locator("#saveBtn").click();
		await page.locator("#status")
			.filter({ hasText: "maxMessages must be a positive integer" })
			.waitFor();
		await page.locator("#dirtyBadge.visible").waitFor();

		await page.locator("#regexTabBtn").click();
		await page.locator("[data-regex-row]").first().locator("[data-regex-max-messages]").fill("2");
		await page.locator("#policyTabBtn").click();
		const toolsPolicy = page.locator('[data-policy-row][data-policy-kind="tools"]');
		await toolsPolicy.locator("[data-policy-patterns]").fill("read\nread");
		await page.locator("#itemsTabBtn").click();
		await page.locator("#saveBtn").click();
		await page.locator("#status")
			.filter({ hasText: "tools.allow has duplicate pattern: read" })
			.waitFor();

		await page.locator("#policyTabBtn").click();
		await page.locator('[data-policy-row][data-policy-kind="tools"] [data-policy-patterns]').fill("read");
		await page.locator("#regexTabBtn").click();
		await page.locator("#policyTabBtn").click();
		await page.locator("#itemsTabBtn").click();
		await page.locator("#regexTabBtn").click();
		await page.locator("#saveBtn").click();
		await page.locator("#status").filter({ hasText: "Loaded default" }).waitFor();

		const saved = JSON.parse(readFileSync(join(promptStacksDir(cwd), "default.json"), "utf8")) as {
			context?: Record<string, unknown>;
			name?: string;
			tools?: Record<string, unknown>;
			regex?: { rules?: Array<Record<string, unknown>> };
			variables?: Record<string, unknown>;
		};
		assert.equal(saved.context?.allowDuplicateChatHistory, true);
		assert.equal(saved.name, "Vue tabs edited");
		assert.deepEqual(saved.tools?.futurePolicyField, { preserve: true });
		assert.deepEqual(saved.regex?.rules?.[0]?.futureRuleField, { preserve: true });
		assert.deepEqual(saved.tools?.allow, ["read"]);
		assert.equal(saved.regex?.rules?.[0]?.maxMessages, 2);
		assert.deepEqual(saved.variables, { var1: "resolved" });

		await page.locator(".stack-row", { hasText: "alternate" }).click();
		await page.locator("#status").filter({ hasText: "Loaded alternate" }).waitFor();
		await page.locator("#regexTabBtn").click();
		await page.locator("#reloadBtn").click();
		await page.locator("#status").filter({ hasText: "Reloaded from disk" }).waitFor();
		assert.equal(await page.locator(".stack-row.selected .stack-name").textContent(), "alternate");
	});
});

function stackFixture(id: string, name: string, autoActivate = false) {
	return {
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id,
		name,
		autoActivate,
		mode: "replace",
		items: [
			{ kind: "block", id: "system", enabled: true, role: "system", content: `Content for ${id}.` },
			{ kind: "slot", id: "history", enabled: true, slot: "chat-history" },
		],
	};
}

async function withBrowserEditor(
	t: TestContext,
	prepare: (cwd: string) => void,
	run: (fixture: { cwd: string; editorUrl: URL; page: Page }) => Promise<void>,
): Promise<void> {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}

	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-browser-characterization-"));
	prepare(cwd);
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
		page.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(message.text());
		});

		await run({ cwd, editorUrl, page });
		assert.deepEqual(browserErrors, []);
	} finally {
		await browser?.close();
		if (editorStarted) await harness.commands.preset.handler("ui stop", context.ctx);
	}
}

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
