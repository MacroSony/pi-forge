// Real continuous X11 browser capture for the README tools + regex examples.
// Synthetic fixtures only; uses the current built web editor/production loopback host.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chromium } from "playwright-core";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.PI_FORGE_MEDIA_OUT_DIR ?? join(tmpdir(), "forge-readme-tools-regex");
const assetDir = process.env.PI_FORGE_ASSET_DIR ?? join(OUT, "assets");
for (const locale of ["en", "zh-CN"]) mkdirSync(join(assetDir, locale), { recursive: true });
const DISPLAY = ":193";
assert.ok(!existsSync("/tmp/.X11-unix/X193"), "private recording display is already in use");
const env = { ...process.env, DISPLAY, XCURSOR_SIZE: "32" };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const xd = (...args: string[]) => execFileSync("xdotool", args, { env, stdio: "ignore", timeout: 5000 });
mkdirSync(OUT, { recursive: true });
for (const locale of ["en", "zh-CN"]) for (const scene of ["tool-selection", "regex-transforms"]) {
  mkdirSync(join(OUT, "masters", locale), { recursive: true });
  mkdirSync(join(OUT, "frames", locale), { recursive: true });
  mkdirSync(join(OUT, "evidence", locale), { recursive: true });
}

const xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-ac", "+extension", "XTEST"], { stdio: "ignore" });
await wait(700);
assert.equal(xvfb.exitCode, null);
const isolatedGlobal = mkdtempSync(join(tmpdir(), "pi-forge-readme-media-global-"));
const oldGlobal = process.env.PI_FORGE_GLOBAL_DIR;
const oldConfig = process.env.PI_FORGE_GLOBAL_CONFIG_PATH;
process.env.PI_FORGE_GLOBAL_DIR = join(isolatedGlobal, "resources");
process.env.PI_FORGE_GLOBAL_CONFIG_PATH = join(isolatedGlobal, "config.json");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const { createContext, createHarness, latestEditorUrl, startSession, writeStack } = await import("../tests/helpers/index-command-harness.ts");

let px = 790;
let py = 650;
let actionLog: any[] = [];
let started = 0;
function mark(action: string, detail: Record<string, unknown> = {}) {
  const entry = { time: new Date().toISOString(), ms: started ? Date.now() - started : 0, action, ...detail };
  actionLog.push(entry);
  console.log(JSON.stringify(entry));
}
async function move(x: number, y: number, duration = 350) {
  const sx = px, sy = py;
  const n = Math.max(1, Math.ceil(duration / 25));
  for (let i = 1; i <= n; i++) {
    const u = i / n, e = u * u * (3 - 2 * u);
    px = Math.round(sx + (x - sx) * e); py = Math.round(sy + (y - sy) * e);
    xd("mousemove", String(px), String(py)); await wait(duration / n);
  }
}
async function click(locator: any, name: string) {
  const box = await locator.boundingBox();
  assert.ok(box, `visible ${name}`);
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1441 && box.y + box.height <= 901, `onscreen ${name}`);
  await move(box.x + box.width / 2, box.y + box.height / 2);
  await wait(150); mark("click", { name, x: px, y: py });
  xd("mousedown", "1"); await wait(60); xd("mouseup", "1"); await wait(220);
}
async function openPreview(page: any, name: string) {
  const button = page.locator("#previewTabBtn");
  if (await button.getAttribute("aria-pressed") !== "true") await click(button, name);
  await page.locator(".context-diff-compiled").waitFor();
  if (await page.locator(".context-diff-dock").getAttribute("data-reading") === "side") await click(page.locator("#focus-toggle"), "Widen Preview for readable recording");
}
async function expandSelectedTools(page: any) {
  const panel = page.locator(".preview-selected-tools-panel").first(); await panel.waitFor();
  if (await panel.getAttribute("open") === null) await click(panel.locator("summary"), "Show Preview tool listing");
}
async function captureStart(out: string): Promise<ChildProcess> {
  started = Date.now(); actionLog = []; mark("capture-start", { out });
  const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-y", "-nostdin", "-f", "x11grab", "-draw_mouse", "1", "-video_size", "1440x900", "-framerate", "30", "-i", `${DISPLAY}.0`, "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr?.on("data", (data) => process.stderr.write(data)); await wait(900); assert.equal(proc.exitCode, null); return proc;
}
async function captureStop(proc: ChildProcess) {
  const done = new Promise<void>((resolve, reject) => proc.once("close", (code) => code === 0 || code === 255 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  proc.kill("SIGINT"); await done; mark("capture-stop"); started = 0;
}
async function makeBrowser(url: URL) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, env, ignoreDefaultArgs: ["--enable-automation"], args: ["--no-sandbox", "--disable-gpu", "--window-size=1440,900", "--window-position=0,0", "--kiosk", "--no-first-run", "--no-default-browser-check", "--disable-features=Translate,OptimizationHints"] });
  const ctx = await browser.newContext({ viewport: null });
  await ctx.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const cursor = document.createElement("div"); cursor.id = "capture-pointer-annotation";
      cursor.style.cssText = "position:fixed;left:-100px;top:-100px;width:28px;height:28px;border:2px solid rgba(80,215,244,.7);border-radius:50%;background:rgba(60,200,230,.07);transform:translate(-50%,-50%);z-index:2147483647;pointer-events:none;box-sizing:border-box";
      document.body.append(cursor);
      const update = (event: MouseEvent) => { const host = (event.target as Element)?.closest?.("dialog[open]") || document.body; if (cursor.parentNode !== host) host.append(cursor); cursor.style.left = `${event.clientX}px`; cursor.style.top = `${event.clientY}px`; };
      document.addEventListener("pointermove", update, true); document.addEventListener("dragover", update, true);
      document.addEventListener("pointerdown", (event) => { update(event); cursor.animate([{ boxShadow: "0 0 0 0 rgba(91,224,245,.8)" }, { boxShadow: "0 0 0 13px rgba(91,224,245,0)" }], { duration: 550 }); }, true);
      (window as any).__captureInput = [];
      for (const type of ["pointerdown", "click"]) document.addEventListener(type, (event: any) => (window as any).__captureInput.push({ type, trusted: event.isTrusted, x: event.clientX, y: event.clientY, target: event.target?.id || event.target?.className || "", time: performance.now() }), true);
    });
  });
  const page = await ctx.newPage(); page.setDefaultTimeout(9000); page.setDefaultNavigationTimeout(12000);
  const errors: string[] = [], external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => { const target = new URL(route.request().url()); if (target.origin === url.origin) return route.continue(); external.push(target.origin); return route.abort(); });
  await page.goto(url.href); await page.locator("#itemContent").waitFor(); xd("key", "F11"); await wait(700);
  const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, x: screenX, y: screenY }));
  assert.ok(geometry.x === 0 && geometry.y === 0 && geometry.width >= 1439 && geometry.height >= 899, "private fullscreen geometry");
  if (await page.locator("body").getAttribute("data-theme") !== "dark") await click(page.locator("#themeToggleBtn"), "Dark theme");
  await page.waitForFunction(() => document.body.dataset.theme === "dark"); px = 790; py = 650; xd("mousemove", String(px), String(py));
  return { browser, page, errors, external, geometry };
}
function probe(path: string) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height,avg_frame_rate,pix_fmt", "-of", "json", path], { encoding: "utf8" }));
}
function makeGif(mp4: string, gif: string) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-y", "-i", mp4, "-filter_complex_threads", "1", "-vf", "fps=15,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", "-loop", "0", gif], { stdio: "inherit" });
}

try {
  for (const locale of ["en", "zh-CN"]) {
    const zh = locale === "zh-CN";
    const cwd = mkdtempSync(join(tmpdir(), "pi-forge-readme-demo-"));
    const forge = join(cwd, ".pi", "forge"); mkdirSync(forge, { recursive: true });
    writeFileSync(join(forge, "config.json"), JSON.stringify({ webEditor: { locale } }));
    const sample = zh ? "合成示例 SAMPLE_TOKEN 仅用于演示。" : "Synthetic example SAMPLE_TOKEN for this demo only.";
    const stackBase: any = {
      schemaVersion: 2, type: "pi-forge.prompt-stack", id: "readme-demo", name: zh ? "README 演示" : "README demo", autoActivate: true, mode: "replace",
      tools: { allow: ["read", "ls", "grep"], initial: ["read", "ls"] },
      regex: { schemaVersion: 1, rules: [{ id: "redact-sample", name: zh ? "演示脱敏" : "Demo redaction", enabled: false, stage: "compiled", effect: "outgoing", frequency: "turn", pattern: "SAMPLE_TOKEN", flags: "g", replace: "[REDACTED]", targets: ["system"], roles: ["system"] }] },
      items: [{ id: "sample", name: zh ? "合成示例" : "Synthetic example", kind: "block", role: "system", content: sample, enabled: true }, { id: "history", name: zh ? "对话历史" : "Conversation history", kind: "slot", slot: "chat-history", enabled: true }],
    };
    writeStack(cwd, "readme-demo.json", stackBase);
    const h = createHarness({ activeTools: ["read", "ls"], allTools: ["read", "ls", "grep"] });
    const c = createContext(cwd, [], { leafId: null }); c.ctx.sessionManager.getSessionId = () => `readme-${locale}`;
    c.ctx.getSystemPromptOptions = () => ({ cwd, selectedTools: h.getActiveTools(), toolSnippets: {}, promptGuidelines: [], contextFiles: [], skills: [] }) as any;
    let ui: any; let rec: ChildProcess | undefined;
    try {
      await startSession(h, c.ctx); await h.commands.forge.handler("ui", c.ctx);
      const url = latestEditorUrl(c.editors); ui = await makeBrowser(url); const { page } = ui;
      const out = join(OUT, "masters", locale);
      {
        const policy = page.locator("#policyTabBtn"); await click(policy, "Policy"); await page.locator('[data-policy-row][data-policy-kind="tools"]').waitFor();
        await page.waitForFunction(() => (document.querySelector("[data-custom-defaults-toggle]") as HTMLInputElement)?.checked === true);
        const selected = page.locator("[data-selected-default-tools]"); assert.match(await selected.innerText(), /read/); assert.match(await selected.innerText(), /ls/);
        await move(790, 650); await wait(500);
        await openPreview(page, "Preview before tool toggle");
        const before = page.locator(".context-diff-compiled"); await before.waitFor();
        await expandSelectedTools(page);
        await page.waitForFunction(() => { const t = document.querySelector(".context-diff-compiled")?.textContent || ""; return t.includes("read") && t.includes("ls") && !t.includes("grep"); });
        await page.screenshot({ path: join(OUT, "frames", locale, "tool-selection-before.png") }); mark("verified-preview-before", { tools: ["read", "ls"] });
        rec = await captureStart(join(out, "tool-selection.mp4")); await wait(900); await wait(900);
        await click(page.locator("#policyTabBtn"), "Policy to add grep");
        const picker = page.locator("[data-default-tools-picker] [data-tool-picker-trigger]"); await click(picker, "Choose default tools");
        const search = page.locator("[data-tool-picker-search]"); await click(search, "Search registered tools"); await page.keyboard.type("grep", { delay: 90 });
        const grep = page.locator('[data-tool-checkbox][data-tool-name="grep"]'); await grep.waitFor(); assert.equal(await grep.isChecked(), false);
        await click(grep, "Add registered inert grep"); await page.waitForFunction(() => (document.querySelector("[data-selected-default-tools]")?.textContent || "").includes("grep"));
        await click(page.locator("[data-tool-picker-done]"), "Close tool picker"); mark("verified-default-tools-draft", { tools: ["read", "ls", "grep"] }); await wait(500);
        await click(page.locator("#saveBtn"), "Save tool policy"); await page.locator("#dirtyBadge").waitFor({ state: "hidden" }); mark("verified-policy-saved"); await wait(350);
        await click(page.locator("#activateBtn"), "Activate saved tool policy"); await page.waitForFunction(() => document.querySelector("#runtimeBadge")?.classList.contains("active")); mark("verified-policy-activated", { runtimeTools: h.getActiveTools(), setActiveToolsCalls: h.setActiveToolsCalls }); await wait(350);
        await openPreview(page, "Preview after tool toggle");
        await expandSelectedTools(page);
        await page.waitForFunction(() => { const t = document.querySelector(".context-diff-compiled")?.textContent || ""; return t.includes("read") && t.includes("ls") && t.includes("grep"); });
        const toolText = await page.locator(".context-diff-compiled").innerText(); assert.match(toolText, /read/); assert.match(toolText, /ls/); assert.match(toolText, /grep/);
        await page.screenshot({ path: join(OUT, "frames", locale, "tool-selection-after.png") }); mark("verified-preview-after", { tools: ["read", "ls", "grep"] }); await wait(1200);
        await captureStop(rec); rec = undefined;
        assert.deepEqual(ui.errors, [], "no browser errors"); assert.deepEqual(ui.external, [], "no external browser attempts");
        assert.deepEqual([...h.getActiveTools()].sort(), ["grep", "ls", "read"], "actual host tool policy updated");
        const evidence = { sourceCommit, locale, scene: "tool-selection", host: url.origin, fixture: "registered inert read/ls/grep names", before: ["read", "ls"], after: ["read", "ls", "grep"], modelRuntime: "inert command harness; no model transport exists", externalRequests: ui.external, pageErrors: ui.errors, geometry: ui.geometry, probe: probe(join(out, "tool-selection.mp4")), cursor: "native X11 cursor plus recording-only halo synced to trusted pointer events", actions: actionLog, input: await page.evaluate(() => (window as any).__captureInput) };
        writeFileSync(join(OUT, "evidence", locale, "tool-selection.json"), JSON.stringify(evidence, null, 2));
        makeGif(join(out, "tool-selection.mp4"), join(assetDir, locale, "tool-selection.gif"));
      }
      // Re-open from the saved isolated preset for an independent regex capture.
      await click(page.locator("#regexTabBtn"), "Regex"); await page.locator("[data-regex-row]").waitFor();
      const regexRow = page.locator("[data-regex-row]").first(); await click(regexRow.locator("[data-regex-toggle]"), "Expand outgoing regex");
      await page.waitForFunction(() => !!document.querySelector("[data-regex-body]"));
      const regexOut = join(OUT, "masters", locale, "regex-transforms.mp4"); await move(790, 650); await wait(500); rec = await captureStart(regexOut); await wait(900);
      await openPreview(page, "Preview before regex");
      await page.waitForFunction(() => (document.querySelector(".context-diff-compiled")?.textContent || "").includes("SAMPLE_TOKEN"));
      const preRegex = await page.locator(".context-diff-compiled").innerText(); assert.match(preRegex, /SAMPLE_TOKEN/); assert.doesNotMatch(preRegex, /\[REDACTED\]/);
      await page.screenshot({ path: join(OUT, "frames", locale, "regex-transforms-before.png") }); mark("verified-regex-before", { visible: "SAMPLE_TOKEN" }); await wait(1300);
      // Regex is already active alongside Preview; keep its expanded form visible.
      const enabled = page.locator("[data-regex-enabled]").first(); assert.equal(await enabled.isChecked(), false); await click(enabled, "Toggle outgoing regex");
      await page.waitForFunction(() => (document.querySelector("[data-regex-enabled]") as HTMLInputElement)?.checked === true); mark("verified-regex-enabled", { pattern: "SAMPLE_TOKEN", replacement: "[REDACTED]" }); await wait(700);
      await openPreview(page, "Preview after regex");
      await page.waitForFunction(() => { const t = document.querySelector(".context-diff-compiled")?.textContent || ""; return t.includes("[REDACTED]") && !t.includes("SAMPLE_TOKEN"); });
      const postRegex = await page.locator(".context-diff-compiled").innerText(); assert.match(postRegex, /\[REDACTED\]/); assert.doesNotMatch(postRegex, /SAMPLE_TOKEN/);
      await page.screenshot({ path: join(OUT, "frames", locale, "regex-transforms-after.png") }); mark("verified-regex-after", { visible: "[REDACTED]" }); await wait(2200);
      await captureStop(rec); rec = undefined;
      assert.deepEqual(ui.errors, [], "no browser errors"); assert.deepEqual(ui.external, [], "no external browser attempts");
      const evidence = { sourceCommit, locale, scene: "regex-transforms", host: url.origin, fixture: "synthetic SAMPLE_TOKEN only; no credential or payload", before: "SAMPLE_TOKEN", after: "[REDACTED]", rule: { stage: "compiled", effect: "outgoing", frequency: "turn", pattern: "SAMPLE_TOKEN", replace: "[REDACTED]", flags: "g", targets: ["system"], roles: ["system"] }, modelRuntime: "inert command harness; no model transport exists", externalRequests: ui.external, pageErrors: ui.errors, geometry: ui.geometry, probe: probe(regexOut), cursor: "native X11 cursor plus recording-only halo synced to trusted pointer events", actions: actionLog, input: await page.evaluate(() => (window as any).__captureInput) };
      writeFileSync(join(OUT, "evidence", locale, "regex-transforms.json"), JSON.stringify(evidence, null, 2));
      makeGif(regexOut, join(assetDir, locale, "regex-transforms.gif"));
    } catch (error) {
      await ui?.page.screenshot({ path: join(OUT, "evidence", locale, "failure.png") }).catch(() => {}); throw error;
    } finally {
      if (rec) await captureStop(rec).catch(() => {}); await ui?.browser.close();
      await h.commands.preset.handler("ui stop", c.ctx); await h.events.session_shutdown?.({ type: "session_shutdown", reason: "exit" }, c.ctx); rmSync(cwd, { recursive: true, force: true });
    }
  }
} finally {
  xvfb.kill(); rmSync(isolatedGlobal, { recursive: true, force: true });
  if (oldGlobal === undefined) delete process.env.PI_FORGE_GLOBAL_DIR; else process.env.PI_FORGE_GLOBAL_DIR = oldGlobal;
  if (oldConfig === undefined) delete process.env.PI_FORGE_GLOBAL_CONFIG_PATH; else process.env.PI_FORGE_GLOBAL_CONFIG_PATH = oldConfig;
}
