import assert from "node:assert/strict";
import { existsSync, rmSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { promptStacksDir } from "../src/loader.ts";

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

async function withUiFormsFixture(
	t: TestContext,
	prepare: (cwd: string) => void,
	run: (fixture: {
		cwd: string;
		editorUrl: URL;
		page: Page;
		token: string;
	}) => Promise<void>,
): Promise<void> {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") {
		t.skip("PI_FORGE_SKIP_BROWSER_TESTS=1");
		return;
	}
	const executablePath = findChromeExecutable();
	assert.ok(executablePath, "Chrome was not found. Set CHROME_PATH or PI_FORGE_SKIP_BROWSER_TESTS=1.");

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-ui-forms-"));
	prepare(cwd);

	const harness = createHarness();
	const context = createContext(cwd);
	await startSession(harness, context.ctx);
	let browser: Browser | undefined;
	let editorStarted = false;

	try {
		await harness.commands.preset.handler("ui", context.ctx);
		editorStarted = true;
		const editorUrl = latestEditorUrl(context.editors);
		const token = editorUrl.searchParams.get("token") || "";

		browser = await chromium.launch({
			executablePath,
			headless: true,
			args: process.platform === "linux" ? ["--no-sandbox"] : [],
		});
		const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
		page.setDefaultTimeout(6_000);

		await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
		await page.locator(".stack-row.selected").waitFor();

		await run({ cwd, editorUrl, page, token });
	} finally {
		await browser?.close();
		if (editorStarted) {
			await harness.commands.preset.handler("ui stop", context.ctx);
		}
		await harness.events.session_shutdown?.({ type: "session_shutdown", reason: "exit" }, context.ctx);
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("ui-forms: fold/unfold in regex, policy, and bindings does not dirty preset", { timeout: 35_000 }, async (t) => {
	await withUiFormsFixture(t, (cwd) => {
		const root = join(cwd, ".pi", "forge");
		mkdirSync(join(root, "capabilities"), { recursive: true });
		writeFileSync(
			join(root, "capabilities", "sample-capability.json"),
			JSON.stringify({
				schemaVersion: 1,
				type: "pi-forge.capability",
				id: "sample-capability",
				name: "Sample Capability",
				content: "Sample instructions",
			}),
		);
		writeStack(cwd, "default.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "default",
			name: "Test Stack",
			autoActivate: true,
			mode: "replace",
			items: [
				{ kind: "block", id: "system", enabled: true, role: "system", content: "Instructions." },
			],
			tools: {
				allow: ["fake_read"],
			},
			regex: {
				rules: [
					{
						id: "rule-1",
						name: "Alpha Rule",
						enabled: true,
						stage: "compiled",
						effect: "outgoing",
						frequency: "turn",
						pattern: "foo",
						replace: "bar",
						futureRuleField: "keep-me",
					},
				],
			},
			capabilities: [
				{
					ref: "project:sample-capability",
					modelCallable: false,
				},
			],
		});
	}, async ({ page }) => {
		// 1. Verify Regex fold/unfold does not dirty
		await page.locator("#regexTabBtn").click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Initial state not dirty");

		const regexToggle = page.locator("[data-regex-toggle]").first();
		await regexToggle.waitFor();
		await regexToggle.click(); // Expand rule
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Expanding regex card must not dirty");
		assert.equal(await page.locator("[data-regex-body]").count(), 1, "Regex card body expanded");
		await regexToggle.click(); // Collapse using the visible, keyboard-reachable toggle.
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Collapsing regex card must not dirty");
		assert.equal(await page.locator("[data-regex-body]").count(), 0, "Regex card body collapsed");

		// 2. Verify Policy advanced details does not dirty
		await page.locator("#policyTabBtn").click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Switching to policy tab not dirty");

		const policyAdvanced = page.locator(".policy-card details.advanced summary").first();
		await policyAdvanced.waitFor();
		await policyAdvanced.click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Toggling policy advanced must not dirty");
		await policyAdvanced.click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Closing policy advanced must not dirty");

		// 3. Verify Binding advanced toggle does not dirty
		await page.locator("#bindingsTabBtn").click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Switching to bindings tab not dirty");

		const bindingAdvancedToggle = page.locator("[data-binding-advanced-toggle]").first();
		await bindingAdvancedToggle.waitFor();
		await bindingAdvancedToggle.click(); // Open advanced body
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Opening binding advanced must not dirty");
		await bindingAdvancedToggle.click(); // Close advanced body
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Closing binding advanced must not dirty");
	});
});

test("ui-forms: regex scan-first, edit with immediate save, and reorder integrity", { timeout: 35_000 }, async (t) => {
	await withUiFormsFixture(t, (cwd) => {
		writeStack(cwd, "default.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "default",
			name: "Regex Stack",
			autoActivate: true,
			mode: "replace",
			items: [
				{ kind: "block", id: "system", enabled: true, role: "system", content: "Instructions." },
			],
			regex: {
				rules: [
					{
						id: "rule-1",
						name: "Rule Alpha",
						enabled: true,
						stage: "compiled",
						effect: "outgoing",
						frequency: "turn",
						pattern: "alpha-pat",
						replace: "alpha-rep",
						customMeta: { preserved: 1 },
					},
					{
						id: "rule-2",
						name: "Rule Beta",
						enabled: true,
						stage: "compiled",
						effect: "outgoing",
						frequency: "request",
						pattern: "beta-pat",
						replace: "beta-rep",
						customMeta: { preserved: 2 },
					},
				],
			},
		});
	}, async ({ cwd, page }) => {
		await page.locator("#regexTabBtn").click();

		// Check scan-first summary cards
		const rows = page.locator("[data-regex-row]");
		assert.equal(await rows.count(), 2);

		// Rule 1 visible summary check
		const row1 = rows.first();
		const name1 = await row1.locator("[data-regex-card-title]").textContent();
		assert.match(name1 ?? "", /Rule Alpha/);
		const excerpt1 = await row1.locator("[data-regex-excerpt]").textContent();
		assert.match(excerpt1 ?? "", /alpha-pat/);

		// Expand rule 1 to edit
		await row1.locator("[data-regex-toggle]").click();
		await row1.locator("[data-regex-pattern]").fill("alpha-pat-updated");
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true, "Editing pattern dirties preset");

		// Immediate save
		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });

		// Verify on disk that pattern was saved and unknown fields preserved
		const diskPath = join(promptStacksDir(cwd), "default.json");
		let saved = JSON.parse(readFileSync(diskPath, "utf8"));
		assert.equal(saved.regex.rules[0].pattern, "alpha-pat-updated");
		assert.deepEqual(saved.regex.rules[0].customMeta, { preserved: 1 });

		// Reorder: move rule 2 up
		const row2 = page.locator("[data-regex-row]").nth(1);
		await row2.locator("[data-regex-up='true']").click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true, "Reorder dirties preset");

		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });

		saved = JSON.parse(readFileSync(diskPath, "utf8"));
		assert.equal(saved.regex.rules[0].id, "rule-2", "Rule Beta is now first");
		assert.equal(saved.regex.rules[1].id, "rule-1", "Rule Alpha is now second");
		assert.deepEqual(saved.regex.rules[0].customMeta, { preserved: 2 });
		assert.deepEqual(saved.regex.rules[1].customMeta, { preserved: 1 });

		// Add new rule: verify it opens new row for editing
		await page.locator("#addRegexRuleBtn").click();
		const newRow = page.locator("[data-regex-row]").last();
		assert.equal(await newRow.locator("[data-regex-pattern]").isVisible(), true, "Newly added rule is expanded");
	});
});

test("ui-forms: policy deny button label and missing-vs-empty initial preservation", { timeout: 35_000 }, async (t) => {
	await withUiFormsFixture(t, (cwd) => {
		writeStack(cwd, "deny-stack.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "deny-stack",
			name: "Deny Stack",
			autoActivate: true,
			mode: "replace",
			items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "Instructions." }],
			tools: {
				deny: ["fake_danger"],
				// initial is missing intentionally
			},
		});
		writeStack(cwd, "empty-initial.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "empty-initial",
			name: "Empty Initial Stack",
			autoActivate: false,
			mode: "replace",
			items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "Instructions." }],
			tools: {
				allow: ["fake_read"],
				initial: [], // explicitly empty initial
			},
		});
	}, async ({ cwd, page }) => {
		await page.locator("#policyTabBtn").click();

		// Check deny mode button label in ceiling card
		const toolPolicyRow = page.locator('[data-policy-row][data-policy-kind="tools"]');
		await toolPolicyRow.waitFor();
		assert.equal(await toolPolicyRow.getAttribute("data-policy-mode"), "deny");

		// In deny mode, picker button MUST say "Choose denied tools…" (or Chinese: 选择拒绝工具), not "Choose permitted tools…"
		const pickerTrigger = page.locator("[data-permitted-tools-picker] [data-tool-picker-trigger]");
		await pickerTrigger.waitFor();
		const labelText = await pickerTrigger.textContent();
		assert.match(labelText ?? "", /denied|拒绝/i, "Deny picker must say choose denied tools, not permitted");

		// Check missing initial preservation:
		// Save deny-stack and verify tools.initial is still undefined/omitted
		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
		const denySaved = JSON.parse(readFileSync(join(promptStacksDir(cwd), "deny-stack.json"), "utf8"));
		assert.equal(denySaved.tools.initial, undefined, "Missing initial is preserved as missing on save");

		// Switch to empty-initial stack
		await page.locator(".stack-row").filter({ hasText: "Empty Initial Stack" }).click();
		await page.locator("#status").filter({ hasText: "Loaded empty-initial" }).waitFor();

		// Verify custom defaults toggle is checked and empty indicator is shown
		assert.equal(await page.locator("[data-custom-defaults-toggle]").isChecked(), true);
		assert.equal(await page.locator("[data-no-default-tools]").isVisible(), true);

		// Save and verify initial: [] is preserved
		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
		const emptySaved = JSON.parse(readFileSync(join(promptStacksDir(cwd), "empty-initial.json"), "utf8"));
		assert.deepEqual(emptySaved.tools.initial, [], "Explicit empty initial [] is preserved on save");
	});
});

test("ui-forms: preset binding advanced toggle does not activate or dirty preset", { timeout: 35_000 }, async (t) => {
	await withUiFormsFixture(t, (cwd) => {
		const root = join(cwd, ".pi", "forge");
		mkdirSync(join(root, "capabilities"), { recursive: true });
		writeFileSync(
			join(root, "capabilities", "capability-1.json"),
			JSON.stringify({
				schemaVersion: 1,
				type: "pi-forge.capability",
				id: "capability-1",
				name: "Capability 1",
				content: "Capability 1 instructions",
			}),
		);
		writeStack(cwd, "default.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "default",
			name: "Active Stack",
			autoActivate: true,
			mode: "replace",
			items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "Instructions." }],
		});
		writeStack(cwd, "inactive.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "inactive",
			name: "Inactive Stack",
			autoActivate: false,
			mode: "replace",
			items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "Instructions." }],
			capabilities: [
				{
					ref: "project:capability-1",
					modelCallable: false,
				},
			],
		});
	}, async ({ editorUrl, page, token }) => {
		// Switch to inactive preset
		await page.locator(".stack-row").filter({ hasText: "Inactive Stack" }).click();
		await page.locator("#status").filter({ hasText: "Loaded inactive" }).waitFor();

		// Navigate to bindings tab
		await page.locator("#bindingsTabBtn").click();
		const bindingRow = page.locator("[data-binding-row]").first();
		await bindingRow.waitFor();

		// Check modelCallable is false
		assert.equal(await bindingRow.locator("[data-binding-model-callable]").isChecked(), false);

		// Click advanced toggle
		await bindingRow.locator("[data-binding-advanced-toggle]").click();
		await page.locator("[data-binding-advanced-body]").waitFor();

		// Verify not dirty
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Advanced toggle must not dirty");

		// Verify preset is NOT activated
		const sessionResp = await page.request.get(
			new URL("/api/stacks", editorUrl).href,
			{ headers: { "x-pi-forge-token": token } },
		);
		const data = await sessionResp.json();
		const activeStack = data.stacks?.find((s: any) => s.active);
		assert.notEqual(activeStack?.id, "inactive", "Opening advanced must not activate the preset");
		assert.equal(await bindingRow.locator("[data-binding-model-callable]").isChecked(), false, "modelCallable not granted");
	});
});

test("ui-forms: zh-CN localization for forms and deny picker label", { timeout: 35_000 }, async (t) => {
	await withUiFormsFixture(t, (cwd) => {
		const root = join(cwd, ".pi", "forge");
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "config.json"),
			JSON.stringify({ webEditor: { locale: "zh-CN" } }),
		);
		writeStack(cwd, "deny-stack.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "deny-stack",
			name: "拒绝预设",
			autoActivate: true,
			mode: "replace",
			items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "说明。" }],
			tools: {
				deny: ["fake_danger"],
			},
		});
	}, async ({ page }) => {
		await page.locator("#policyTabBtn").click();

		// Check deny mode picker button in zh-CN
		const pickerTrigger = page.locator("[data-permitted-tools-picker] [data-tool-picker-trigger]");
		await pickerTrigger.waitFor();
		const labelText = await pickerTrigger.textContent();
		assert.match(labelText ?? "", /选择拒绝工具/, "Deny picker in zh-CN says 选择拒绝工具");

		// Check V4 policy card titles in zh-CN
		const ceilingTitle = await page.locator('[data-policy-row][data-policy-kind="tools"] .card-title h3').textContent();
		assert.match(ceilingTitle ?? "", /许可范围/);

		const defaultsTitle = await page.locator('[data-custom-defaults-section] .card-title h3').textContent();
		assert.match(defaultsTitle ?? "", /默认启用/);

		const skillsSummary = await page.locator('.skills-summary .skills-title').textContent();
		assert.match(skillsSummary ?? "", /技能列表可见性/);
	});
});

test("ui-forms: initial invalid rules unfold does not dirty and preserves unknowns and invalid fields across save and reorder", { timeout: 35_000 }, async (t) => {
	await withUiFormsFixture(t, (cwd) => {
		writeStack(cwd, "default.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "default",
			name: "Invalid Rules Stack",
			autoActivate: true,
			mode: "replace",
			items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "Instructions." }],
			regex: {
				rules: [
					{
						id: "rule-1",
						name: "Rule One",
						enabled: true,
						stage: "compiled",
						effect: "outgoing",
						frequency: "turn",
						pattern: "pat-1",
						replace: "rep-1",
						maxMessages: 0, // initially invalid positive integer
						futureRuleField: { preserve: true },
						customProp: "hello-custom",
					},
					{
						id: "rule-2",
						name: "Rule Two",
						enabled: true,
						stage: "compiled",
						effect: "outgoing",
						frequency: "turn",
						pattern: "pat-2",
						replace: "rep-2",
					},
				],
			},
		});
	}, async ({ cwd, page }) => {
		await page.locator("#regexTabBtn").click();

		// Initial mount must NOT dirty the preset even with initial invalid rule
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Initial mount with invalid rule is not dirty");

		const rows = page.locator("[data-regex-row]");
		assert.equal(await rows.count(), 2);
		const firstRow = rows.first();

		// Unfold the initial invalid rule: MUST NOT DIRTY
		const toggle1 = firstRow.locator("[data-regex-toggle]");
		await toggle1.click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Unfolding invalid rule must not dirty");
		assert.equal(await firstRow.locator("[data-regex-body]").isVisible(), true);

		// Collapse it: MUST NOT DIRTY
		await firstRow.locator(".regex-card-head").click({ position: { x: 5, y: 5 } });
		assert.equal(await page.locator("#dirtyBadge").isVisible(), false, "Collapsing invalid rule must not dirty");
		assert.equal(await firstRow.locator("[data-regex-body]").count(), 0);

		// Expand again to fix maxMessages and edit name
		await toggle1.click();
		await firstRow.locator("[data-regex-name]").fill("Rule One Renamed");
		// Open technical limits advanced details and fix maxMessages from 0 to 5
		await firstRow.locator(".regex-advanced summary").click();
		await firstRow.locator("[data-regex-max-messages]").fill("5");
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true, "Editing name and fixing field dirties preset");

		// Save preset
		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });

		// Verify on disk: unknown fields and fixed fields preserved
		const diskPath = join(promptStacksDir(cwd), "default.json");
		let saved = JSON.parse(readFileSync(diskPath, "utf8"));
		assert.equal(saved.regex.rules[0].name, "Rule One Renamed");
		assert.deepEqual(saved.regex.rules[0].futureRuleField, { preserve: true });
		assert.equal(saved.regex.rules[0].customProp, "hello-custom");
		assert.equal(saved.regex.rules[0].maxMessages, 5);

		// Reorder: move rule 1 down
		await firstRow.locator("[data-regex-down='true']").click();
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true, "Reordering dirties preset");

		await page.locator("#saveBtn").click();
		await page.locator("#dirtyBadge").waitFor({ state: "hidden" });

		saved = JSON.parse(readFileSync(diskPath, "utf8"));
		assert.equal(saved.regex.rules[0].id, "rule-2", "Rule 2 is now first");
		assert.equal(saved.regex.rules[1].id, "rule-1", "Rule 1 is now second");
		assert.equal(saved.regex.rules[1].name, "Rule One Renamed");
		assert.deepEqual(saved.regex.rules[1].futureRuleField, { preserve: true });
		assert.equal(saved.regex.rules[1].maxMessages, 5);
	});
});

test("ui-forms: effective preview queue same-tick coalescing, late-result drop, and unmount teardown", { timeout: 35_000 }, async (t) => {
	await withUiFormsFixture(t, (cwd) => {
		const root = join(cwd, ".pi", "forge");
		mkdirSync(join(root, "capabilities"), { recursive: true });
		for (const id of ["capability-a", "capability-b"]) {
			writeFileSync(
				join(root, "capabilities", `${id}.json`),
				JSON.stringify({
					schemaVersion: 1,
					type: "pi-forge.capability",
					id,
					name: `Capability ${id}`,
					content: `Content for ${id}`,
				}),
			);
		}
		writeStack(cwd, "default.json", {
			schemaVersion: 1,
			type: "pi-forge.prompt-stack",
			id: "default",
			name: "Binding Stack",
			autoActivate: true,
			mode: "replace",
			items: [{ kind: "block", id: "system", enabled: true, role: "system", content: "Instructions." }],
			capabilities: [
				{
					ref: "project:capability-a",
					modelCallable: false,
				},
			],
		});
	}, async ({ page }) => {
		const pageErrors: string[] = [];
		page.on("pageerror", (err) => pageErrors.push(err.message));

		// 1. Same-tick coalescing test
		const effectiveRequests: string[] = [];
		await page.route("**/api/capabilities/effective", async (route) => {
			effectiveRequests.push(route.request().url());
			await route.continue();
		});

		await page.locator("#bindingsTabBtn").click();
		await page.locator("[data-binding-row]").first().waitFor();
		await page.waitForTimeout(100);

		const baselineCount = effectiveRequests.length;

		// Trigger rapid operations in same tick
		await page.evaluate(() => {
			const btn = document.querySelector("#addBindingBtn") as HTMLButtonElement | null;
			if (btn && !btn.disabled) {
				btn.click();
			}
		});

		await page.waitForTimeout(150);
		const newCount = effectiveRequests.length;
		assert.ok(newCount <= baselineCount + 1, "Same tick operations coalesced into a single effective preview call");

		// 2. Late result scenario
		let resolveSlow: (() => void) | null = null;
		let reqCounter = 0;
		await page.unroute("**/api/capabilities/effective");
		await page.route("**/api/capabilities/effective", async (route) => {
			reqCounter++;
			const thisIndex = reqCounter;
			if (thisIndex === 1) {
				await new Promise<void>((resolve) => {
					resolveSlow = resolve;
				});
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						ok: true,
						bindings: [
							{
								ref: "project:capability-a",
								id: "STALE_SLOW",
								modelCallable: false,
							},
						],
					}),
				});
			} else {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						ok: true,
						bindings: [
							{
								ref: "project:capability-b",
								id: "FRESH_FAST",
								modelCallable: false,
							},
						],
					}),
				});
			}
		});

		// Trigger first request (slow)
		await page.evaluate(() => {
			const select = document.querySelector("[data-binding-ref]") as HTMLSelectElement | null;
			if (select) select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await page.waitForTimeout(40);

		// Trigger second request (fast)
		await page.evaluate(() => {
			const select = document.querySelector("[data-binding-ref]") as HTMLSelectElement | null;
			if (select) select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await page.waitForTimeout(80);

		// Now release the first request
		if (resolveSlow) {
			(resolveSlow as () => void)();
		}
		await page.waitForTimeout(100);

		// Verify STALE_SLOW is NOT present in the effective bindings preview
		const effectiveItems = await page.locator("[data-effective-binding]").allTextContents();
		assert.ok(!effectiveItems.some((text) => text.includes("STALE_SLOW")), "Late response must not overwrite fresh response");

		// 3. Unmount teardown scenario
		await page.locator("#itemsTabBtn").click(); // Unmount bindings tab
		await page.waitForTimeout(100);
		assert.equal(pageErrors.length, 0, "Unmount caused no errors");
	});
});

test('ui-forms: unrelated edits preserve invalid empty numeric values; explicit clearing repairs them', { timeout: 30_000 }, async t => {
 await withUiFormsFixture(t, cwd => writeStack(cwd, 'default.json', {
  schemaVersion: 1, type: 'pi-forge.prompt-stack', id: 'default',
  items: [{ kind: 'block', id: 'root', role: 'system', content: 'Fixture.' }],
  regex: { rules: [{ id: 'limits', stage: 'compiled', pattern: 'x', replace: 'y', maxMessages: null, maxChars: '', minDepth: -2, maxDepth: 2.5 }] },
 }), async ({ page, cwd }) => {
  await page.locator('#regexTabBtn').click();
  let row = page.locator('[data-regex-row]').first();
  await row.locator('[data-regex-toggle]').click();
  await row.locator('[data-regex-name]').fill('Unrelated title edit');
  await page.locator('#stackTabBtn').click();
  const draft = JSON.parse(await page.locator('#stackJsonText').inputValue());
  assert.equal(draft.regex.rules[0].maxMessages, null, 'Untouched invalid null must not be silently deleted');
  assert.equal(draft.regex.rules[0].maxChars, '');
  assert.equal(draft.regex.rules[0].minDepth, -2);
  assert.equal(draft.regex.rules[0].maxDepth, 2.5);
  await page.locator('#regexTabBtn').click();
  row = page.locator('[data-regex-row]').first();
  await row.locator('[data-regex-toggle]').click();
  await row.locator('.regex-advanced > summary').click();
  await row.locator('[data-regex-max-messages]').fill('1');
  await row.locator('[data-regex-max-messages]').fill('');
  await row.locator('[data-regex-max-chars]').fill('1');
  await row.locator('[data-regex-max-chars]').fill('');
  await row.locator('[data-regex-min-depth]').fill('0');
  await row.locator('[data-regex-max-depth]').fill('3');
  await page.locator('#saveBtn').click();
  await page.locator('#dirtyBadge').waitFor({ state: 'hidden' });
  const saved=JSON.parse(readFileSync(join(promptStacksDir(cwd),'default.json'),'utf8')).regex.rules[0];
  assert.equal(saved.maxMessages, undefined);
  assert.equal(saved.maxChars, undefined);
  assert.equal(saved.minDepth, 0);
  assert.equal(saved.maxDepth, 3);
  assert.equal(saved.name, 'Unrelated title edit');
 });
});
