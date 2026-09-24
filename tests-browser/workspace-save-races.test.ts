import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { createContext, createHarness, latestEditorUrl, startSession, writeStack } from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

test("late preset saves preserve newer edits, selection generations and source revisions", { timeout: 30_000 }, async (t) => {
	if (process.env.PI_FORGE_SKIP_BROWSER_TESTS === "1") { t.skip("browser tests explicitly disabled"); return; }
	const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p): p is string => !!p && existsSync(p));
	assert.ok(executablePath);
	const cwd = mkdtempSync(join(tmpdir(), "forge-save-race-"));
	for (const id of ["alpha", "beta"]) writeStack(cwd, id + ".json", { schemaVersion: 2, type: "pi-forge.prompt-stack", id, autoActivate: id === "alpha", mode: "replace", items: [{kind:"block", id:"body", role:"system", content:id}] });
	const disk = (id: string) => join(promptStacksDir(cwd), id + ".json");
	const read = (id: string) => JSON.parse(readFileSync(disk(id), "utf8"));
	const harness = createHarness();
	const context = createContext(cwd);
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	let release: (() => void) | undefined;
	try {
		await startSession(harness, context.ctx);
		await harness.commands.preset.handler("ui", context.ctx);
		browser = await chromium.launch({executablePath, headless:true, args:process.platform === "linux" ? ["--no-sandbox"] : []});
		const page = await browser.newPage(); page.setDefaultTimeout(5000);
		const url = latestEditorUrl(context.editors);
		await page.route("**/*", route => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
		page.on("dialog", d => d.accept());
		const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
		await page.goto(url.href); await page.locator("#itemContent").waitFor();
		let ready: (() => void) | undefined;
		let held: Promise<void> | undefined;
		let writes = 0;
		let receipt: any;
        let dropReceipt = false;
        let selectionGate: Promise<void> | undefined;
        let selectionReady: (() => void) | undefined;
		await page.route("**/api/stacks/*", async route => {
			if (route.request().method() !== "PUT") {
                if (selectionGate && route.request().url().endsWith("beta")) {
                    const response = await route.fetch(); selectionReady?.();
                    await selectionGate; return route.fulfill({response});
                }
                return route.fallback();
            }
			writes++;
			const response = await route.fetch();
			receipt = await response.json();
			ready?.();
			if (held) await held;
			if (dropReceipt) { const body = {...receipt}; delete body.sourceRevision; await route.fulfill({response, json:body}); }
            else await route.fulfill({response});
		});
		const saveHeld = async (text: string) => {
			await page.locator("#itemContent").fill(text);
			held = new Promise<void>(resolve => { release = resolve; });
			const arrived = new Promise<void>(resolve => { ready = resolve; });
			await page.locator("#saveBtn").click(); await arrived;
		};
		const settle = async () => { release?.(); held = undefined; ready = undefined; await page.waitForTimeout(180); };

        selectionGate = new Promise<void>(resolve => { release = resolve; });
        const selectionArrived = new Promise<void>(resolve => { selectionReady = resolve; });
        await page.locator('.stack-row').filter({hasText:'beta'}).click();
        await selectionArrived;
        await page.locator("#itemContent").fill("typing during selection");
        release?.(); selectionGate = undefined; await page.waitForTimeout(180);
        assert.equal(await page.locator("#itemContent").inputValue(), "typing during selection", "late selection GET must not discard new typing");
        assert.match(await page.locator("#resourceSelector").innerText(), /alpha/);
        assert.equal(await page.locator("#dirtyBadge").isVisible(), true);

		await saveHeld("first saved version");
		await page.locator("#itemContent").fill("newer unsaved edit");
        await page.locator("#saveBtn").evaluate((button: HTMLButtonElement) => { button.disabled = false; button.click(); });
        await page.keyboard.press("Control+s");
        assert.equal(writes, 1, "in-flight save is guarded even when the button is force-enabled");
		await settle();
		assert.equal(await page.locator("#itemContent").inputValue(), "newer unsaved edit", "a save reply must not erase typing after the click");
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true);
		assert.equal(read("alpha").items[0].content, "first saved version");
		assert.equal(receipt.sourceRevision, createHash("sha256").update(readFileSync(disk("alpha"))).digest("hex"));
		await page.locator("#saveBtn").click(); await page.locator("#dirtyBadge").waitFor({state:"hidden"});
		assert.equal(read("alpha").items[0].content, "newer unsaved edit", "next save uses this operation's revision receipt");

		await saveHeld("alpha saved while navigating");
		await page.locator('.stack-row').filter({hasText:'beta'}).click();
		await page.waitForFunction(() => (document.querySelector("#itemContent") as HTMLTextAreaElement)?.value === "beta");
		await page.locator("#itemContent").fill("beta unsaved edit");
		await settle();
		assert.equal(await page.locator("#itemContent").inputValue(), "beta unsaved edit");
		assert.match(await page.locator("#resourceSelector").innerText(), /beta/);
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true);
		assert.equal(read("beta").items[0].content, "beta");

		await page.locator('.stack-row').filter({hasText:'alpha'}).click();
		await page.waitForFunction(() => (document.querySelector("#itemContent") as HTMLTextAreaElement)?.value === "alpha saved while navigating");
		await saveHeld("alpha before roundtrip");
		await page.locator('.stack-row').filter({hasText:'beta'}).click();
		await page.waitForFunction(() => (document.querySelector("#itemContent") as HTMLTextAreaElement)?.value === "beta");
		await page.locator('.stack-row').filter({hasText:'alpha'}).click();
		await page.waitForFunction(() => (document.querySelector("#itemContent") as HTMLTextAreaElement)?.value === "alpha before roundtrip");
		await page.locator("#itemContent").fill("alpha after selection roundtrip");
		await settle();
		assert.equal(await page.locator("#itemContent").inputValue(), "alpha after selection roundtrip", "same selector must not bypass the selection generation fence");
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true);

		await saveHeld("saved before external edit");
		await page.locator("#itemContent").fill("still unsaved local work");
		const external = read("alpha"); external.items[0].content = "external writer";
		writeFileSync(disk("alpha"), JSON.stringify(external));
		await settle();
		assert.equal(await page.locator("#itemContent").inputValue(), "still unsaved local work");
		const conflict = page.waitForResponse(r => r.request().method() === "PUT" && r.status() === 409);
		await page.locator("#saveBtn").click(); await conflict;
		assert.equal(read("alpha").items[0].content, "external writer", "do not adopt a later GET revision and overwrite external edits");
		assert.equal(await page.locator("#dirtyBadge").isVisible(), true);
		assert.equal(writes, 6);
        await page.locator("#reloadBtn").click();
        await page.waitForFunction(() => (document.querySelector("#itemContent") as HTMLTextAreaElement)?.value === "external writer");
        dropReceipt = true;
        await page.locator("#itemContent").fill("saved but receipt missing");
        await page.locator("#saveBtn").click();
        await page.locator("#status").filter({hasText:"missing a valid source revision"}).waitFor();
        assert.equal(await page.locator("#dirtyBadge").isVisible(), true);
        assert.equal(await page.locator("#itemContent").inputValue(), "saved but receipt missing");
        dropReceipt = false;
        const rejected = page.waitForResponse(r => r.request().method() === "PUT" && r.status() === 409);
        await page.locator("#saveBtn").click(); await rejected;
        assert.equal(read("alpha").items[0].content, "saved but receipt missing");
        assert.deepEqual(errors, []);
	} finally {
		release?.(); await browser?.close();
		await harness.commands.preset.handler("ui stop", context.ctx);
		await harness.events.session_shutdown?.({type:"session_shutdown", reason:"exit"},context.ctx);
		rmSync(cwd,{recursive:true,force:true});
	}
});
