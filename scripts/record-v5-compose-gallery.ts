/**
 * v5.3 素材录制 A：编排章 + 预设画廊
 * 场景（~50s @1920x1080，暗色主题）：
 *   1. 打开编辑器（4 个真实 stack：default / minimal / regex-hack / system-status）
 *   2. 逐个切换左侧 stack 列表 —— 画廊镜头（每个 stack 载入自己的 items）
 *   3. default：点选积木 → 关掉一块 → Preview dock → 编辑文本 → Draft diff → 保存
 *   4. regex-hack：Regex tab 展示规则表
 *   5. system-status：items 里可见 custom slot（受信任扩展真实注册）
 * 运行：PI_FORGE_PROMO_OUT_DIR=/path/to/output node scripts/record-v5-compose-gallery.ts
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
	writeForgeExtension,
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

const OUT_DIR = process.env.PI_FORGE_PROMO_OUT_DIR
	?? join(process.cwd(), ".pi", "forge", "recordings");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const HOLD = (ms: number) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });
const cwd = mkdtempSync(join(tmpdir(), "pi-forge-v5-"));
mkdirSync(promptStacksDir(cwd), { recursive: true });
for (const [src, name] of [
	["examples/default-prompt-stack.json", "default.json"],
	["examples/minimal-prompt-stack.json", "minimal.json"],
	["examples/hack-prompt-stack.json", "regex-hack.json"],
	["examples/custom-system-status-extension/prompt-stack.json", "system-status.json"],
]) copyFileSync(src, join(promptStacksDir(cwd), name));

// system-status 预设的受信任扩展：真实注册 machine-status slot
writeForgeExtension(cwd, "system-status.ts", readFileSync("examples/custom-system-status-extension/index.ts", "utf8"));

const harness = createHarness();
const context = createContext(cwd, [], { trusted: true });
await startSession(harness, context.ctx);
await harness.commands.preset.handler("ui", context.ctx);
const editorUrl = latestEditorUrl(context.editors);
console.log("editor:", editorUrl.href);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const ctx = await browser.newContext({
	viewport: { width: 1920, height: 1080 },
	deviceScaleFactor: 1,
	recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
});
const page = await ctx.newPage();
page.setDefaultTimeout(10_000);
page.on("pageerror", (e) => console.error("pageerror:", e.message));

async function selectStack(name: string) {
	await page.locator(".stack-row").filter({ hasText: name }).first().click();
	await HOLD(1500);
}
async function clickTab(label: RegExp) {
	const byTab = page.getByRole("tab", { name: label }).first();
	if (await byTab.count()) { await byTab.click(); return true; }
	const byBtn = page.getByRole("button", { name: label }).first();
	if (await byBtn.count()) { await byBtn.click(); return true; }
	return false;
}

try {
	await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
	await page.locator(".item-row").first().waitFor();
	// 暗色主题（与字卡一致）
	const darkBtn = page.getByRole("button", { name: /Dark/i }).first();
	if (await darkBtn.count()) { await darkBtn.click(); await HOLD(600); }
	await HOLD(1400); // 定场

	// --- 画廊：逐个切换 stack ---
	for (const name of ["minimal", "regex-hack", "system-status", "default"]) {
		await selectStack(name);
	}

	// --- default：编排基础操作 ---
	const rows = page.locator(".item-row");
	await rows.nth(3).click(); await HOLD(900);
	await rows.nth(1).click(); await HOLD(900);
	await rows.nth(1).locator(".item-toggle").click();
	await page.locator("#dirtyBadge.visible").waitFor();
	await HOLD(1400);

	// Preview dock → 编辑 → Draft diff
	await page.locator("#previewTabBtn").click();
	await page.locator("#editorDockArea.dock-open").waitFor();
	await HOLD(1300);
	await rows.nth(0).click(); await HOLD(500);
	const editor = page.locator("#itemContent");
	await editor.click(); await HOLD(300);
	await editor.pressSequentially(" —— 演示：这一行是刚刚打上去的。", { delay: 55 });
	await HOLD(1800);
	if (await clickTab(/Draft diff/i)) await HOLD(2200);

	// 开回积木，保存
	await rows.nth(1).locator(".item-toggle").click(); await HOLD(700);
	await page.locator("#saveBtn").click();
	await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
	await HOLD(1000);

	// --- regex-hack：Regex tab ---
	await selectStack("regex-hack");
	if (await clickTab(/^Regex$/i)) await HOLD(2000);

	// --- system-status：custom slot 行 ---
	await selectStack("system-status");
	await HOLD(1200);
} finally {
	const video = page.video();
	await ctx.close();
	await browser.close();
	await harness.commands.preset.handler("ui stop", context.ctx);
	const videoPath = await video?.path();
	if (videoPath) {
		const { execSync } = await import("node:child_process");
		const out = join(OUT_DIR, "screencap_v5_compose_gallery.mp4");
		execSync(`ffmpeg -y -i "${videoPath}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${out}"`);
		console.log("✓", out);
	}
}
