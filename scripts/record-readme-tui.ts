import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const evidenceDir = process.env.PI_FORGE_MEDIA_OUT_DIR ?? "/tmp/forge-readme-tui";
const assetDir = process.env.PI_FORGE_ASSET_DIR ?? join(evidenceDir, "assets");
const asset = join(assetDir, "tui-quickstart.gif");
const display = ":196";
const width = 1000;
const height = 540;
const extension = join(repo, "dist/index.js");
const root = join(tmpdir(), `pi-forge-readme-tui-${Date.now()}-${process.pid}`);
const home = join(root, "home");
const agentDir = join(root, ".pi-agent");
const cwd = join(root, "demo-project");
const mp4 = join(evidenceDir, "tui-quickstart-master.mp4");
const palette = join(evidenceDir, "tui-quickstart-palette.png");
const terminalLog = join(evidenceDir, "terminal.log");

mkdirSync(join(cwd, ".pi/forge/prompt-stacks"), { recursive: true });
mkdirSync(join(cwd, ".pi/forge/instruction-modes"), { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(join(home, ".config"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });
mkdirSync(dirname(asset), { recursive: true });
if (existsSync(terminalLog)) rmSync(terminalLog, { force: true });

const stack = {
  schemaVersion: 2,
  type: "pi-forge.prompt-stack",
  id: "read-first",
  name: "Read-first worker",
  autoActivate: true,
  mode: "replace",
  tools: {
    allow: ["read", "ls", "forge_system_update", "bash", "edit"],
    initial: ["read", "ls", "forge_system_update"],
  },
  instructionModes: [{ id: "write-tools", ref: "project:write-tools", modelCallable: true }],
  items: [
    {
      kind: "block",
      id: "role",
      name: "Worker role",
      enabled: true,
      role: "system",
      content: "Read first. Enable write tools only when needed.",
    },
    { kind: "slot", id: "history", name: "Chat history", enabled: true, slot: "chat-history" },
  ],
};
const mode = {
  schemaVersion: 1,
  type: "pi-forge.instruction-mode",
  id: "write-tools",
  name: "Write tools",
  description: "Enable shell and edit for task commands.",
  content: "Use bash and edit only as needed; disable this mode when finished.",
  tools: { add: ["bash", "edit"], remove: [] },
};
writeFileSync(join(cwd, ".pi/forge/prompt-stacks/read-first.json"), `${JSON.stringify(stack, null, 2)}\n`);
writeFileSync(join(cwd, ".pi/forge/instruction-modes/write-tools.json"), `${JSON.stringify(mode, null, 2)}\n`);
// Isolated cosmetic theme and an inert local model entry: no real credentials or inference.
const demoSettings = { quietStartup: true, theme: "readme-demo" };
mkdirSync(join(agentDir, "themes"), { recursive: true });
const theme = JSON.parse(readFileSync(join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), "utf8"));
theme.name = "readme-demo"; theme.colors.dim = "#9ca3af";
writeFileSync(join(agentDir, "themes/readme-demo.json"), JSON.stringify(theme));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify(demoSettings));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "offline-demo": {
  baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "inert-demo-placeholder",
  models: [{ id: "offline-demo", name: "Offline demo", contextWindow: 128000, maxTokens: 4096 }],
} } }));
const networkLog = join(evidenceDir, "network-attempts.jsonl");
writeFileSync(networkLog, "");
const networkGuard = join(root, "no-network.mjs");
writeFileSync(networkGuard, `import fs from 'node:fs'; import net from 'node:net'; import {syncBuiltinESMExports} from 'node:module';
const deny = () => { fs.appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify({attempt:true})+'\\n'); throw new Error('Network disabled for README capture'); };
globalThis.fetch=deny; net.Socket.prototype.connect=deny; syncBuiltinESMExports();`);

const authKeys = [
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY",
  "CEREBRAS_API_KEY", "XAI_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "BASETEN_API_KEY",
  "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY",
  "MINIMAX_API_KEY", "MOONSHOT_API_KEY", "OPENCODE_API_KEY", "KIMI_API_KEY", "META_API_KEY",
  "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID", "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY", "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "AWS_PROFILE", "AWS_REGION",
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK",
];
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  DISPLAY: display,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local/share"),
  GSETTINGS_BACKEND: "memory",
};
for (const key of authKeys) delete childEnv[key];

const piArgs = [
  "pi", "--offline", "--no-session", "--approve", "--no-extensions", "--extension", extension,
  "--tui-mode", "regular", "--provider", "offline-demo", "--model", "offline-demo",
];
const demoCommands = [
  "/preset use project:read-first",
  "/instruction use project:write-tools",
  "/instruction status",
];
const terminalShell =
  `cd ${shellQuote(cwd)} && printf '\\033]11;#111827\\007\\033]10;#e5e7eb\\007' && export PI_CODING_AGENT_DIR=${shellQuote(agentDir)} HOME=${shellQuote(home)} TERM=xterm-256color COLORTERM=true NODE_OPTIONS=${shellQuote(`--import=${networkGuard}`)} && exec ${commandsToShell(piArgs)}`;
const commands = {
  pi: piArgs,
  terminal: [
    "dbus-run-session", "--", "gnome-terminal", "--wait", "--hide-menubar",
    "--geometry=100x24+0+0", "--title=Pi Forge quickstart", "--", "bash", "-lc", terminalShell,
  ],
  commands: demoCommands,
};

let xvfb: ChildProcess | undefined;
let terminal: ChildProcess | undefined;
let recorder: ChildProcess | undefined;
let windowId: string | undefined;
const startedAt = new Date().toISOString();
const actionLog: Array<Record<string, unknown>> = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function commandsToShell(args: string[]): string {
  return args.map(shellQuote).join(" ");
}
function run(command: string, args: string[], options: { capture?: boolean } = {}): string {
  return execFileSync(command, args, {
    env: childEnv,
    encoding: "utf8",
    stdio: options.capture === false ? "ignore" : ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function mark(action: string, details: Record<string, unknown> = {}): void {
  actionLog.push({ at: new Date().toISOString(), action, ...details });
}
function importKeyframe(name: string): void {
  run("import", ["-window", "root", join(evidenceDir, name)], { capture: false });
}
function sendKey(...keys: string[]): void { run("xdotool", ["key", ...keys], { capture: false }); }
function typeText(text: string): void { run("xdotool", ["type", "--delay", "12", text], { capture: false }); }
async function submitCommand(text: string, holdMs = 1_050): Promise<void> {
  mark("type-command", { text });
  typeText(text);
  // Pi's first Enter accepts the slash-command completion; the second submits it.
  sendKey("Return");
  await sleep(280);
  sendKey("Return");
  await sleep(holdMs);
}
async function waitForWindow(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const found = run("xdotool", ["search", "--onlyvisible", "--class", "Gnome-terminal"], { capture: true })
        .trim().split(/\s+/).filter(Boolean);
      if (found.length) return found[0]!;
    } catch { /* terminal is still starting */ }
    await sleep(100);
  }
  throw new Error("Timed out waiting for the private terminal window.");
}
function ffmpeg(args: string[]): void { run("ffmpeg", args, { capture: false }); }

async function cleanup(): Promise<void> {
  if (recorder && recorder.exitCode === null) {
    const done = new Promise<void>((resolve) => recorder!.once("close", () => resolve()));
    recorder.kill("SIGINT");
    await Promise.race([done, sleep(2_000)]);
  }
  if (windowId) {
    try { run("xdotool", ["windowkill", windowId], { capture: false }); } catch { /* already closed */ }
  }
  if (terminal && terminal.exitCode === null) {
    try { process.kill(-terminal.pid!, "SIGTERM"); } catch { terminal.kill("SIGTERM"); }
  }
  if (xvfb && xvfb.exitCode === null) xvfb.kill("SIGTERM");
  await sleep(700);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

try {
  if (existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) throw new Error(`${display} is already in use.`);
  const sourceSha256 = createHash("sha256").update(readFileSync(extension)).digest("hex");
  const sourceCommit = run("git", ["-C", repo, "rev-parse", "HEAD"]).trim();

  xvfb = spawn("Xvfb", [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-ac", "+extension", "XTEST"], {
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  await sleep(800);
  if (xvfb.exitCode !== null) throw new Error(`Xvfb exited with ${xvfb.exitCode}.`);

  terminal = spawn("dbus-run-session", ["--", "gnome-terminal", "--wait", "--hide-menubar", "--geometry=100x24+0+0", "--title=Pi Forge quickstart", "--", "bash", "-lc", commands.terminal.at(-1)!], {
    env: childEnv,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  terminal.stderr?.on("data", (data) => appendLog(data.toString()));
  windowId = await waitForWindow();
  run("xdotool", ["mousemove", "--window", windowId, "500", "300"], { capture: false });
  run("xdotool", ["click", "1"], { capture: false });
  await sleep(900);

  recorder = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning", "-y", "-nostdin", "-f", "x11grab", "-draw_mouse", "1",
    "-video_size", `${width}x${height}`, "-framerate", "30", "-i", `${display}.0`, "-c:v", "libx264",
    "-threads", "2", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4,
  ], { env: childEnv, stdio: ["ignore", "ignore", "pipe"] });
  recorder.stderr?.on("data", (data) => appendLog(data.toString()));
  await sleep(900);
  mark("capture-start", { display, width, height, windowId });
  await sleep(1_200);
  await submitCommand(commands.commands[0]!, 1_900);
  importKeyframe("keyframe-preset.png");
  mark("captured-preset-use", { command: commands.commands[0] });
  await submitCommand(commands.commands[1]!, 2_200);
  importKeyframe("keyframe-instruction-use.png");
  mark("captured-instruction-use", { command: commands.commands[1] });
  await submitCommand(commands.commands[2]!, 2_400);
  importKeyframe("keyframe-status-final.png");
  mark("captured-instruction-status-final", { command: commands.commands[2] });
  await sleep(2_500);
  mark("capture-stop");
  await cleanup();

  ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", mp4, "-vf", "fps=12,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff", palette]);
  ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", mp4, "-i", palette, "-lavfi", "fps=12,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a", "-loop", "0", asset]);

  const ffprobe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height,avg_frame_rate,pix_fmt", "-of", "json", mp4]));
  const gifProbe = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_name,width,height,avg_frame_rate,pix_fmt", "-of", "json", asset]));
  const decodeChecks = { mp4: decode(mp4), gif: decode(asset) };
  assert.equal(readFileSync(networkLog, "utf8"), "", "no network attempts during capture");
  writeFileSync(join(evidenceDir, "provenance.json"), JSON.stringify({
    recordedAt: startedAt,
    sourceCommit,
    extension,
    extensionSha256: sourceSha256,
    asset,
    masterVideo: mp4,
    display,
    terminal: { emulator: "gnome-terminal", geometry: "100x24", screen: `${width}x${height}`, nativeTui: true, isolatedColors: { background: "#111827", foreground: "#e5e7eb", colorControl: "OSC 11/10", font: "terminal default; isolated Pi dark theme with brighter dim text" } },
    exactCommands: commands,
    isolation: {
      cwd,
      home,
      piCodingAgentDir: agentDir,
      settingsFile: join(agentDir, "settings.json"),
      settings: demoSettings,
      environment: {
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        DISPLAY: display,
      },
      offline: true,
      noSession: true,
      noInference: true,
      inertModel: "offline-demo (not a real provider)",
      networkGuard: "fetch and net.Socket.connect blocked; empty network-attempts.jsonl asserted",
      noUserSettingsOrAuthModified: true,
      syntheticResources: [".pi/forge/prompt-stacks/read-first.json", ".pi/forge/instruction-modes/write-tools.json"],
    },
    captureMetadata: {
      providerRequests: 0,
      modelRequests: 0,
      externalRequests: [],
      expectedToolsBefore: ["read", "ls", "forge_system_update"],
      expectedToolsAfter: ["read", "ls", "forge_system_update", "bash", "edit"],
      actionLog,
      note: "Commands and holds are captured actions; expected tool lists are derived from the synthetic fixture, not screenshot assertions.",
    },
    ffprobe: { mp4: ffprobe, gif: gifProbe },
    decodeChecks,
  }, null, 2) + "\n");
  console.log(JSON.stringify({ asset, master: mp4, evidenceDir, duration: ffprobe.format?.duration, gifBytes: gifProbe.format?.size }));
} catch (error) {
  await cleanup();
  throw error;
}

function appendLog(text: string): void {
  writeFileSync(terminalLog, text, { flag: "a" });
}
function decode(path: string): { ok: boolean; output: string } {
  try {
    const output = run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-f", "null", "-"], { capture: true });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
