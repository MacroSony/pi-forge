/**
 * 宣传片原型：真实 web 编辑器 + Playwright 脚本驱动录屏
 * 场景（约 45s @1920x1080）：
 *   1. 打开编辑器，default 栈已加载（左侧列表 default / reviewer 两条）
 *   2. 逐个点选积木行，预览跟随
 *   3. 关掉一块积木（On→Off），dirty 徽标出现
 *   4. 打开预览 dock（Draft diff），编辑文本，实时重新组装
 *   5. 把积木开回来，保存
 * 运行：cd /home/bruhw/programming/pi-forge && node scripts/record-promo-editor-demo.ts
 * 输出：<视频项目>/screencap_editor_demo_v1.mp4（webm 转码）
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

import {
	createContext,
	createHarness,
	latestEditorUrl,
	startSession,
} from "../tests/helpers/index-command-harness.ts";
import { promptStacksDir } from "../src/loader.ts";

const OUT_DIR =
	"/home/bruhw/programming/AIGC/VIDEO_PRODUCTION/projects/pi_forge_promo_20260826";
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const HOLD = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cwd = mkdtempSync(join(tmpdir(), "pi-forge-promo-"));
mkdirSync(promptStacksDir(cwd), { recursive: true });
// 真实示例配置：default（复刻原版）+ reviewer（审查档案）
copyFileSync(
	"examples/default-prompt-stack.json",
	join(promptStacksDir(cwd), "default.json"),
);
copyFileSync(
	"examples/reviewer-prompt-stack.json",
	join(promptStacksDir(cwd), "reviewer.json"),
);

const harness = createHarness();
const context = createContext(cwd, [], { trusted: true });
await startSession(harness, context.ctx);

await harness.commands.preset.handler("ui", context.ctx);
const editorUrl = latestEditorUrl(context.editors);
console.log("editor:", editorUrl.href);

const browser = await chromium.launch({
	executablePath: CHROME,
	headless: true,
	args: ["--no-sandbox", "--hide-scrollbars"],
});
const ctx = await browser.newContext({
	viewport: { width: 1920, height: 1080 },
	deviceScaleFactor: 1,
	recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
});
const page = await ctx.newPage();
page.setDefaultTimeout(10_000);
page.on("pageerror", (e) => console.error("pageerror:", e.message));

try {
	await page.goto(editorUrl.href, { waitUntil: "domcontentloaded" });
	await page.locator(".stack-row.selected").waitFor();
	await HOLD(2000); // 定场：让观众看清整体布局

	// --- 逐个点选积木（预览跟随）---
	const rows = page.locator(".item-row");
	const count = await rows.count();
	console.log("items:", count);
	for (const i of [1, 3, 5]) {
		if (i < count) {
			await rows.nth(i).click();
			await HOLD(1100);
		}
	}

	// --- 关掉一块积木 ---
	await rows.nth(1).locator(".item-toggle").click();
	await page.locator("#dirtyBadge.visible").waitFor();
	await HOLD(1600); // 展示 dirty 状态 + 预览变化

	// --- 开预览 dock，编辑文本实时重组装 ---
	await page.locator("#previewTabBtn").click();
	await page.locator("#editorDockArea.dock-open").waitFor();
	await HOLD(1500);

	await rows.nth(0).click(); // 选中第一块（通常是 system 文本块）
	await HOLD(600);
	const editor = page.locator("#itemContent");
	await editor.click();
	await HOLD(400);
	// 逐字符输入，模拟真人打字
	await editor.pressSequentially(" —— 演示：这一行是刚刚打上去的。", {
		delay: 60,
	});
	await HOLD(2500); // 停在 Draft diff 上，让观众看变更

	// --- 开回积木，保存 ---
	await rows.nth(1).locator(".item-toggle").click();
	await HOLD(800);
	await page.locator("#saveBtn").click();
	await page.locator("#dirtyBadge").waitFor({ state: "hidden" });
	await HOLD(1500); // 收尾定帧
} finally {
	const video = page.video();
	await ctx.close(); // 关 context 才会 flush 视频
	await browser.close();
	await harness.commands.preset.handler("ui stop", context.ctx);
	const videoPath = await video?.path();
	console.log("raw video:", videoPath);
	if (videoPath) {
		const { execSync } = await import("node:child_process");
		const out = join(OUT_DIR, "screencap_editor_demo_v1.mp4");
		execSync(
			`ffmpeg -y -i "${videoPath}" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "${out}"`,
		);
		console.log("✓", out);
	}
}
