import { promptStackReadDirs } from "./loader.js";
import { resolveResourceSelector } from "./catalog.js";
import { formatResourceKey, parseResourceSelector } from "./resource-identity.js";
import { renderDiagnostics, renderPreview, showText } from "./preview.js";
import { migrateLegacyPromptStacks, renderMigrationReport } from "./stack-migration.js";
import { forgeExtensionsDir, globalForgeExtensionsDir } from "./storage.js";
export function registerPresetCommand(pi, workspace, compileCycle, deps) {
    pi.registerCommand("preset", {
        description: "Manage pi-forge prompt stacks: list, use, preview, validate, reload, ui",
        getArgumentCompletions: (prefix) => {
            const parts = prefix.trimStart().split(/\s+/);
            if (parts.length <= 1 && !prefix.endsWith(" ")) {
                const commands = ["list", "use", "preview", "validate", "diagnostics", "reload", "status", "migrate-stacks", "ui"];
                return commands.filter((cmd) => cmd.startsWith(parts[0] ?? "")).map((cmd) => ({ value: cmd, label: cmd }));
            }
            const first = parts[0];
            if (["use", "preview", "validate"].includes(first)) {
                const fragment = parts[1] ?? "";
                const ids = ["none", ...stackSelectorCandidates(workspace)];
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
            await handlePresetCommand(workspace, compileCycle, deps, args, ctx);
        },
    });
}
async function handlePresetCommand(workspace, compileCycle, deps, args, ctx) {
    const trimmed = args.trim();
    const [command = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : ["list"];
    switch (command) {
        case "list":
        case "status":
            await showText(ctx, "pi-forge prompt stacks", renderStackList(workspace, ctx));
            return;
        case "reload":
            await deps.reloadStacks(ctx, deps.selectedActiveId());
            ctx.ui.notify(`pi-forge: reloaded ${workspace.snapshot().stacks.length} prompt stack(s).`, "info");
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
            const active = workspace.snapshot().active;
            ctx.ui.notify(active ? `pi-forge: active prompt stack ${active.stack.id}` : "pi-forge: prompt stack disabled", "info");
            return;
        }
        case "preview": {
            const target = rest[0] ? findStack(workspace, rest[0]) : workspace.snapshot().active;
            if (!target) {
                ctx.ui.notify(rest[0] ? `Unknown prompt stack: ${rest[0]}` : "No active prompt stack.", "warning");
                return;
            }
            await showText(ctx, `pi-forge preview: ${target.stack.id}`, renderPreview(ctx, target));
            return;
        }
        case "validate": {
            const target = rest[0] ? findStack(workspace, rest[0]) : workspace.snapshot().active;
            if (!target) {
                ctx.ui.notify(rest[0] ? `Unknown prompt stack: ${rest[0]}` : "No active prompt stack.", "warning");
                return;
            }
            await showText(ctx, `pi-forge validation: ${target.stack.id}`, renderDiagnostics(target.diagnostics));
            return;
        }
        case "diagnostics": {
            await showText(ctx, "pi-forge diagnostics", renderCurrentDiagnostics(workspace, compileCycle));
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
        default:
            ctx.ui.notify(`Unknown /preset subcommand: ${command}`, "warning");
            return;
    }
}
function renderStackList(workspace, ctx) {
    const snapshot = workspace.snapshot();
    const lines = [
        "Prompt stack directories:",
        ...promptStackReadDirs(ctx.cwd).map((dir, index) => `  ${index === 0 ? "primary" : "legacy"}: ${dir}`),
        "Forge extension directories:",
        `  global: ${globalForgeExtensionsDir()}`,
        `  project: ${forgeExtensionsDir(ctx.cwd)}`,
        `Loaded forge extensions: ${snapshot.extensionPaths.length}`,
        `Active stack: ${snapshot.active?.stack.id ?? "(none)"}`,
        "",
    ];
    if (snapshot.stacks.length === 0) {
        lines.push("No prompt stacks found.", 'Create .pi/forge/prompt-stacks/<id>.json with "autoActivate": true to auto-activate a stack.');
        return lines.join("\n");
    }
    for (const loaded of snapshot.stacks) {
        const marker = loaded === snapshot.active ? "*" : " ";
        const errors = loaded.diagnostics.filter((d) => d.level === "error").length;
        const warnings = loaded.diagnostics.filter((d) => d.level === "warning").length;
        const suffix = errors || warnings ? ` (${errors} errors, ${warnings} warnings)` : "";
        lines.push(`${marker} ${loaded.stack.id}${loaded.stack.name ? ` \u2014 ${loaded.stack.name}` : ""}${suffix}`);
        lines.push(`  ${loaded.filePath}`);
    }
    lines.push("", "Commands:", "  /preset use <id|none>", "  /preset preview [id]", "  /preset validate [id]", "  /preset diagnostics", "  /preset reload", "  /preset migrate-stacks [--dry-run] [--overwrite] [--delete-legacy]", "  /preset ui [stop|restart]");
    return lines.join("\n");
}
function renderCurrentDiagnostics(workspace, compileCycle) {
    const snapshot = workspace.snapshot();
    const lines = ["# pi-forge diagnostics", ""];
    lines.push("## Active stack load/validation diagnostics", "");
    lines.push(snapshot.active ? renderDiagnostics(snapshot.active.diagnostics) : "No active prompt stack.");
    lines.push("", "## pi-forge extension diagnostics", "");
    lines.push(renderDiagnostics([...snapshot.extensionDiagnostics]));
    lines.push("", "## Loaded pi-forge extensions", "");
    lines.push(snapshot.extensionPaths.length > 0 ? snapshot.extensionPaths.map((path) => `- ${path}`).join("\n") : "(none)");
    lines.push("", "## Latest runtime compile diagnostics", "");
    lines.push(renderDiagnostics(compileCycle.latestCompileDiagnostics));
    return lines.join("\n");
}
function stackSelectorCandidates(workspace) {
    const stacks = workspace.snapshot().stacks;
    const collidingIds = new Set();
    const byId = new Map();
    for (const loaded of stacks) {
        const count = (byId.get(loaded.stack.id) ?? 0) + 1;
        byId.set(loaded.stack.id, count);
        if (count === 2)
            collidingIds.add(loaded.stack.id);
    }
    const candidates = [];
    for (const loaded of stacks) {
        candidates.push(collidingIds.has(loaded.stack.id) ? formatResourceKey(loaded.key) : loaded.stack.id);
    }
    return [...new Set(candidates)].sort();
}
export function findStack(workspace, selector) {
    const parsed = parseResourceSelector(selector);
    if (!parsed.ok)
        return undefined;
    return resolveResourceSelector(workspace.snapshot().stacks, parsed.selector);
}
//# sourceMappingURL=preset-command.js.map