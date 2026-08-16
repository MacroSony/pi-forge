import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDisabledPromptStackId, isSafePromptStackMutationPath, promptStackPath, promptStackReadDirs } from "./loader.js";
import { resolveResourceSelector } from "./catalog.js";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.js";
import { renderDiagnostics, renderPreview, showText } from "./preview.js";
import { importSillyTavernPreset } from "./sillytavern-importer.js";
import { migrateLegacyPromptStacks, renderMigrationReport } from "./stack-migration.js";
import { forgeExtensionsDir, globalForgeExtensionsDir } from "./storage.js";
export function registerPresetCommand(pi, state, deps) {
    pi.registerCommand("preset", {
        description: "Manage pi-forge prompt stacks: list, use, preview, validate, reload, ui",
        getArgumentCompletions: (prefix) => {
            const parts = prefix.trimStart().split(/\s+/);
            if (parts.length <= 1 && !prefix.endsWith(" ")) {
                const commands = ["list", "use", "preview", "validate", "diagnostics", "reload", "status", "import-silly", "migrate-stacks", "ui"];
                return commands.filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
            }
            const first = parts[0];
            if (["use", "preview", "validate"].includes(first)) {
                const fragment = parts[1] ?? "";
                const ids = ["none", ...stackSelectorCandidates(state)];
                return ids.filter((id) => id.startsWith(fragment)).map((id) => ({ value: `${first} ${id}`, label: id }));
            }
            if (first === "ui" && parts.length <= 2) {
                const fragment = parts[1] ?? "";
                const subs = ["stop", "restart"];
                return subs.filter((s) => s.startsWith(fragment)).map((s) => ({ value: `ui ${s}`, label: s }));
            }
            if (first === "migrate-stacks") {
                const fragment = parts[parts.length - 1] ?? "";
                const flags = ["--dry-run", "--overwrite", "--delete-legacy"];
                return flags.filter((flag) => flag.startsWith(fragment)).map((flag) => ({ value: `${parts.slice(0, -1).join(" ")} ${flag}`.trim(), label: flag }));
            }
            return null;
        },
        handler: async (args, ctx) => {
            await handlePresetCommand(state, deps, args, ctx);
        },
    });
}
async function handlePresetCommand(state, deps, args, ctx) {
    const trimmed = args.trim();
    const [command = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : ["list"];
    switch (command) {
        case "list":
        case "status":
            await showText(ctx, "pi-forge prompt stacks", renderStackList(state, ctx));
            return;
        case "reload":
            await deps.reloadStacks(ctx, deps.selectedActiveId());
            ctx.ui.notify(`pi-forge: reloaded ${state.stacks.length} prompt stack(s).`, "info");
            return;
        case "ui": {
            const sub = rest[0];
            if (sub === "stop") {
                await deps.stopWebEditor(ctx);
                return;
            }
            await deps.openWebEditor(ctx, sub === "restart" ? "restart" : "open");
            return;
        }
        case "use": {
            const id = rest[0];
            if (!id) {
                ctx.ui.notify("Usage: /preset use <id|none|project:id|global:id>", "warning");
                return;
            }
            if (!ctx.isProjectTrusted()) {
                ctx.ui.notify("pi-forge: project is not trusted; refusing to activate a prompt stack.", "warning");
                return;
            }
            if (!deps.setActive(id, ctx)) {
                ctx.ui.notify(`Unknown prompt stack: ${id}`, "error");
                return;
            }
            ctx.ui.notify(state.active ? `pi-forge: active prompt stack ${state.active.stack.id}` : "pi-forge: prompt stack disabled", "info");
            return;
        }
        case "preview": {
            const target = rest[0] ? findStack(state, rest[0]) : state.active;
            if (!target) {
                ctx.ui.notify(rest[0] ? `Unknown prompt stack: ${rest[0]}` : "No active prompt stack.", "warning");
                return;
            }
            await showText(ctx, `pi-forge preview: ${target.stack.id}`, renderPreview(ctx, target, state.sessionVariables));
            return;
        }
        case "validate": {
            const target = rest[0] ? findStack(state, rest[0]) : state.active;
            if (!target) {
                ctx.ui.notify(rest[0] ? `Unknown prompt stack: ${rest[0]}` : "No active prompt stack.", "warning");
                return;
            }
            await showText(ctx, `pi-forge validation: ${target.stack.id}`, renderDiagnostics(target.diagnostics));
            return;
        }
        case "diagnostics": {
            await showText(ctx, "pi-forge diagnostics", renderCurrentDiagnostics(state));
            return;
        }
        case "migrate-stacks": {
            const flags = new Set(rest);
            const dryRun = flags.has("--dry-run");
            if (!ctx.isProjectTrusted() && !dryRun) {
                ctx.ui.notify("pi-forge: project is not trusted; refusing to migrate prompt stacks.", "warning");
                return;
            }
            const report = migrateLegacyPromptStacks(ctx.cwd, {
                dryRun,
                overwrite: flags.has("--overwrite"),
                deleteLegacy: flags.has("--delete-legacy"),
            });
            if (!dryRun)
                await deps.reloadStacks(ctx, deps.selectedActiveId());
            const changed = report.copied + report.overwritten;
            const summary = dryRun
                ? `pi-forge: migration dry run found ${report.files.length} legacy stack file(s).`
                : `pi-forge: migrated ${changed} legacy stack file(s), skipped ${report.skipped}, errors ${report.errors}.`;
            ctx.ui.notify(summary, report.errors ? "warning" : "info");
            await showText(ctx, "pi-forge prompt-stack migration", renderMigrationReport(report));
            return;
        }
        case "import-silly":
            await handleImportSilly(state, deps, rest, ctx);
            return;
        default:
            ctx.ui.notify(`Unknown /preset subcommand: ${command}`, "warning");
            return;
    }
}
async function handleImportSilly(state, deps, rest, ctx) {
    if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("pi-forge: project is not trusted; refusing to write imported prompt stacks.", "warning");
        return;
    }
    const sourcePath = rest[0];
    if (!sourcePath) {
        ctx.ui.notify("Usage: /preset import-silly <path> [character_id] [--dry-run] [--overwrite]", "warning");
        return;
    }
    const charIdToken = rest[1]?.startsWith("--") ? undefined : rest[1];
    const flags = new Set(rest.slice(charIdToken ? 2 : 1));
    const dryRun = flags.has("--dry-run");
    let overwrite = flags.has("--overwrite");
    const resolvedPath = sourcePath.startsWith("/") ? sourcePath : join(ctx.cwd, sourcePath);
    if (!existsSync(resolvedPath)) {
        ctx.ui.notify(`File not found: ${resolvedPath}`, "error");
        return;
    }
    const charId = charIdToken ? Number(charIdToken) : undefined;
    if (charIdToken && (Number.isNaN(charId) || !Number.isFinite(charId))) {
        ctx.ui.notify(`Invalid character_id: ${charIdToken}`, "error");
        return;
    }
    const result = importSillyTavernPreset(resolvedPath, charId);
    if ("error" in result) {
        ctx.ui.notify(`pi-forge import error: ${result.error}`, "error");
        return;
    }
    const existingStack = state.stacks.find((candidate) => candidate.scope === "project" && candidate.stack.id === result.stack.id);
    const stackPath = existingStack?.filePath ?? promptStackPath(ctx.cwd, result.stack.id);
    if (!isSafePromptStackMutationPath(ctx.cwd, stackPath)) {
        ctx.ui.notify("pi-forge: refusing to import outside project prompt-stack storage or through a symbolic link.", "error");
        return;
    }
    const stacksDir = dirname(stackPath);
    const reportDir = join(ctx.cwd, ".pi", "forge", "import-reports");
    const reportPath = join(reportDir, `${result.stack.id}.md`);
    if (dryRun) {
        await showText(ctx, `pi-forge import dry run: ${result.stack.id}`, `Would write stack to: ${stackPath}\nWould write report to: ${reportPath}\n\n## Generated stack JSON\n\n\`\`\`json\n${JSON.stringify(result.stack, null, 2)}\n\`\`\`\n\n${result.report}`);
        return;
    }
    const existingPaths = [stackPath, reportPath].filter((path) => existsSync(path));
    if (existingPaths.length > 0 && !overwrite) {
        if (!ctx.hasUI) {
            ctx.ui.notify(`pi-forge: import would overwrite existing file(s): ${existingPaths.join(", ")}. Re-run with --overwrite.`, "error");
            return;
        }
        overwrite = await ctx.ui.confirm("Overwrite pi-forge import output?", `These file(s) already exist:\n${existingPaths.join("\n")}\n\nOverwrite them?`);
        if (!overwrite) {
            ctx.ui.notify("pi-forge: import cancelled; existing files were left unchanged.", "info");
            return;
        }
    }
    if (!existsSync(stacksDir))
        mkdirSync(stacksDir, { recursive: true });
    writeFileSync(stackPath, JSON.stringify(result.stack, null, 2), "utf8");
    if (!existsSync(reportDir))
        mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportPath, result.report, "utf8");
    await deps.reloadStacks(ctx, deps.selectedActiveId());
    ctx.ui.notify(`pi-forge: imported ${result.stack.id} (${result.stack.items.length} items)`, "info");
    await showText(ctx, `pi-forge import report: ${result.stack.id}`, `Stack written to: ${stackPath}\nReport written to: ${reportPath}\n\n${result.report}`);
}
function renderStackList(state, ctx) {
    const lines = [
        "Prompt stack directories:",
        ...promptStackReadDirs(ctx.cwd).map((dir, index) => `  ${index === 0 ? "primary" : "legacy"}: ${dir}`),
        "Forge extension directories:",
        `  global: ${globalForgeExtensionsDir()}`,
        `  project: ${forgeExtensionsDir(ctx.cwd)}`,
        `Loaded forge extensions: ${state.forgeExtensionPaths.length}`,
        `Active stack: ${state.active?.stack.id ?? "(none)"}`,
        "",
    ];
    if (state.stacks.length === 0) {
        lines.push("No prompt stacks found.", 'Create .pi/forge/prompt-stacks/<id>.json with "autoActivate": true to auto-activate a stack.');
        return lines.join("\n");
    }
    for (const loaded of state.stacks) {
        const marker = loaded === state.active ? "*" : " ";
        const errors = loaded.diagnostics.filter((d) => d.level === "error").length;
        const warnings = loaded.diagnostics.filter((d) => d.level === "warning").length;
        const suffix = errors || warnings ? ` (${errors} errors, ${warnings} warnings)` : "";
        lines.push(`${marker} ${loaded.stack.id}${loaded.stack.name ? ` \u2014 ${loaded.stack.name}` : ""}${suffix}`);
        lines.push(`  ${loaded.filePath}`);
    }
    lines.push("", "Commands:", "  /preset use <id|none>", "  /preset preview [id]", "  /preset validate [id]", "  /preset diagnostics", "  /preset reload", "  /preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]", "  /preset ui [stop|restart]");
    return lines.join("\n");
}
function renderCurrentDiagnostics(state) {
    const lines = ["# pi-forge diagnostics", ""];
    lines.push("## Active stack load/validation diagnostics", "");
    lines.push(state.active ? renderDiagnostics(state.active.diagnostics) : "No active prompt stack.");
    lines.push("", "## pi-forge extension diagnostics", "");
    lines.push(renderDiagnostics(state.forgeExtensionDiagnostics));
    lines.push("", "## Loaded pi-forge extensions", "");
    lines.push(state.forgeExtensionPaths.length > 0 ? state.forgeExtensionPaths.map((path) => `- ${path}`).join("\n") : "(none)");
    lines.push("", "## Latest runtime compile diagnostics", "");
    lines.push(renderDiagnostics(state.latestCompileDiagnostics));
    return lines.join("\n");
}
function stackSelectorCandidates(state) {
    const collidingIds = new Set();
    const byId = new Map();
    for (const loaded of state.stacks) {
        const count = (byId.get(loaded.stack.id) ?? 0) + 1;
        byId.set(loaded.stack.id, count);
        if (count === 2)
            collidingIds.add(loaded.stack.id);
    }
    const candidates = [];
    for (const loaded of state.stacks) {
        candidates.push(collidingIds.has(loaded.stack.id) ? formatResourceKey(loaded.key) : loaded.stack.id);
    }
    return [...new Set(candidates)].sort();
}
export function selectedActiveId(state) {
    if (state.active)
        return formatResourceKey(state.active.key);
    return isDisabledPromptStackId(state.lastPersistedActiveId) ? "none" : undefined;
}
export function findStack(state, selector) {
    const parsed = parseResourceSelector(selector);
    if (!parsed.ok)
        return undefined;
    return resolveResourceSelector(state.stacks, parsed.selector);
}
//# sourceMappingURL=preset-command.js.map