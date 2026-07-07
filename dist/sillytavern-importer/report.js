import { displayMacroName, MACRO_NEEDS_MIGRATION, NATIVE_MACRO_NOTES, NATIVE_MACROS, } from "./macros.js";
export function buildSillyTavernImportReport(input) {
    const reportLines = [];
    reportLines.push(`# SillyTavern Import Report: ${input.fileName}`);
    reportLines.push("");
    reportLines.push(`- **Source file**: ${input.sourcePath}`);
    reportLines.push(`- **Character ID**: ${input.characterId}`);
    reportLines.push(`- **Output stack ID**: ${input.stackId}`);
    reportLines.push(`- **Names behavior**: ${input.styleName}`);
    reportLines.push(`- **Total prompts in source**: ${input.totalPrompts}`);
    reportLines.push(`- **Items in prompt_order**: ${input.orderItemCount}`);
    reportLines.push(`- **Converted items**: ${input.items.length}`);
    reportLines.push("");
    if (input.macroUsage.commentsStripped > 0) {
        reportLines.push(`- **Comments stripped**: ${input.macroUsage.commentsStripped} ST comment blocks removed`);
    }
    if (input.macroUsage.trimStripped > 0) {
        reportLines.push(`- **Trim markers removed**: ${input.macroUsage.trimStripped} {{trim}} markers (ST formatting hint)`);
    }
    reportLines.push("");
    if (input.disabledCount.marker > 0 || input.disabledCount.empty > 0 || input.disabledCount.orderDisable > 0) {
        reportLines.push("## Skipped items");
        reportLines.push("");
        if (input.disabledCount.marker > 0) {
            reportLines.push(`- ${input.disabledCount.marker} marker items (charDescription, worldInfo, etc.) — handled by Pi/ST runtime, not needed in prompt stack`);
        }
        if (input.disabledCount.empty > 0) {
            reportLines.push(`- ${input.disabledCount.empty} items with empty or missing content`);
        }
        if (input.disabledCount.orderDisable > 0) {
            reportLines.push(`- ${input.disabledCount.orderDisable} items disabled in prompt_order`);
        }
        reportLines.push("");
    }
    if (input.missingIdentifiers.length > 0) {
        reportLines.push("## ⚠️ Missing identifiers in prompts array");
        reportLines.push("");
        for (const id of input.missingIdentifiers) {
            reportLines.push(`- \`${id}\` (referenced in prompt_order but not found in prompts)`);
        }
        reportLines.push("");
    }
    if (input.regexScripts && input.regexScripts.total > 0) {
        reportLines.push("## SillyTavern regex scripts");
        reportLines.push("");
        reportLines.push(`- **Total scripts**: ${input.regexScripts.total}`);
        reportLines.push(`- **Enabled scripts**: ${input.regexScripts.enabled}`);
        reportLines.push(`- **Disabled scripts**: ${input.regexScripts.disabled}`);
        reportLines.push(`- **Prompt-only**: ${input.regexScripts.promptOnly}`);
        reportLines.push(`- **Markdown-only / display-only**: ${input.regexScripts.markdownOnly}`);
        reportLines.push(`- **Prompt + markdown mixed**: ${input.regexScripts.mixed}`);
        if (input.regexScripts.unspecified > 0) {
            reportLines.push(`- **Enabled with unspecified mode**: ${input.regexScripts.unspecified}`);
        }
        reportLines.push(`- **Converted to pi-forge rules**: ${input.regexScripts.converted}`);
        reportLines.push("");
        reportLines.push("| Script | Enabled | Mode | Converted | Warnings | Find regex | Replacement preview |");
        reportLines.push("|--------|---------|------|-----------|----------|------------|---------------------|");
        for (const script of input.regexScripts.scripts) {
            const converted = script.convertedRuleId ? `yes: ${script.convertedRuleId}` : script.conversionNote ?? "no";
            const warnings = script.conversionWarnings.length > 0 ? script.conversionWarnings.join("; ") : "-";
            reportLines.push(`| ${markdownTableCell(script.name)} | ${script.enabled ? "yes" : "no"} | ${script.mode} | ${markdownTableCell(converted)} | ${markdownTableCell(warnings)} | ${markdownTableCell(script.findRegex)} | ${markdownTableCell(script.replaceString)} |`);
        }
        reportLines.push("");
        const warningEntries = input.regexScripts.scripts.filter((script) => script.conversionWarnings.length > 0);
        if (warningEntries.length > 0) {
            reportLines.push("Conversion warnings:");
            for (const script of warningEntries) {
                for (const warning of script.conversionWarnings) {
                    reportLines.push(`- ${script.name}: ${warning}`);
                }
            }
            reportLines.push("");
        }
        reportLines.push("pi-forge does not run SillyTavern markdown rewriting, DOM/browser automation, CSS/HTML decoration, toasts, embedded JavaScript, or UI panel behavior.");
        if (input.regexScripts.converted > 0) {
            reportLines.push("Enabled and disabled prompt-only deterministic regex scripts were converted to `regex.rules` with `stage: \"history\"`, `effect: \"outgoing\"`, JavaScript replacement syntax, and preserved SillyTavern metadata under `source.sillytavern`. History-stage depth is relative to the filtered chat history inserted at the `chat-history` slot, matching SillyTavern's chat-relative depth, and rules do not touch the compiled system prompt. Use `stage: \"compiled\"` manually for global prompt transforms.");
        }
        reportLines.push("Markdown-only, mixed prompt/markdown, unspecified, invalid, or unsupported regex scripts remain report-only and require manual review.");
        reportLines.push("");
    }
    if (Object.keys(input.variables).length > 0) {
        reportLines.push("## Auto-populated variables");
        reportLines.push("");
        reportLines.push("These ST built-in macros were auto-populated as static variables with placeholder values:");
        reportLines.push("");
        for (const [key, val] of Object.entries(input.variables)) {
            reportLines.push(`- \`${key}\` = \`${val}\` — replace with your character/persona name`);
        }
        reportLines.push("");
        reportLines.push("Edit `stack.variables` in the stack JSON or web editor to set real values.");
        reportLines.push("");
    }
    const migrationEntries = Object.entries(input.macroUsage.migrationNeeded).sort(([, a], [, b]) => b - a);
    if (migrationEntries.length > 0) {
        reportLines.push("## ⚠️ Macros needing manual migration");
        reportLines.push("");
        reportLines.push("These ST macros appear in the preset but have no direct pi-forge equivalent:");
        reportLines.push("");
        for (const [name, count] of migrationEntries) {
            const note = MACRO_NEEDS_MIGRATION[name] ?? "no mapping available";
            reportLines.push(`- **\`{{${displayMacroName(name)}}}\`** (${count} occurrence${count > 1 ? "s" : ""}) — ${note}`);
        }
        reportLines.push("");
    }
    const nativeDetected = [...input.macroUsage.detected].filter((macro) => NATIVE_MACROS.has(macro));
    if (nativeDetected.length > 0) {
        reportLines.push("## Handled macros");
        reportLines.push("");
        for (const name of nativeDetected) {
            const displayName = displayMacroName(name);
            if (name === "char" || name === "user") {
                reportLines.push(`- \`{{${displayName}}}\` → auto-populated as static variable`);
            }
            else if (name === "lastusermessage") {
                reportLines.push(`- \`{{${displayName}}}\` → handled by pi-forge runtime (chat-history slot)`);
            }
            else if (NATIVE_MACRO_NOTES[name]) {
                reportLines.push(`- \`{{${displayName}}}\` → ${NATIVE_MACRO_NOTES[name]}`);
            }
            else {
                reportLines.push(`- \`{{${displayName}}}\` → handled natively by pi-forge`);
            }
        }
        reportLines.push("");
    }
    reportLines.push("## Item mapping");
    reportLines.push("");
    reportLines.push("| # | ST Identifier | ST Name | pi-forge ID | Role | Enabled | Kind |");
    reportLines.push("|---|--------------|---------|-------------|------|---------|------|");
    for (const item of input.items) {
        const stId = item.source?.previousId ?? "—";
        const stName = item.name ?? "—";
        const enabled = item.enabled !== false ? "✓" : "✗";
        const kind = item.kind;
        reportLines.push(`| ${item.id} | ${stId} | ${stName} | ${item.id} | ${item.role ?? "—"} | ${enabled} | ${kind} |`);
    }
    reportLines.push("");
    reportLines.push("## General notes");
    reportLines.push("");
    if (input.usesLastUserMessage) {
        reportLines.push("- Auto-detected `{{lastUserMessage}}` in post-history content. `chat-history` slot set with `includeLastUserMessage: false`.");
    }
    if (input.macroUsage.commentsStripped > 0 || input.macroUsage.trimStripped > 0) {
        reportLines.push(`- ${input.macroUsage.commentsStripped} ST comment blocks and ${input.macroUsage.trimStripped} TRIM markers were stripped during import.`);
    }
    reportLines.push("- All items are assigned sequential numeric IDs. Original SillyTavern identifiers are preserved in `source.previousId`.");
    reportLines.push("- Marker items for world info, character description, persona, scenario, and dialogue examples are omitted — these are handled by the SillyTavern frontend and have no direct pi-forge equivalent.");
    reportLines.push(`- The stack is set with \`autoActivate: false\`. Use \`/preset use ${input.stackId}\` to activate.`);
    reportLines.push("");
    reportLines.push("## Suggested next steps");
    reportLines.push("");
    reportLines.push("1. Set real values for auto-populated variables by editing `stack.variables`.");
    reportLines.push("2. Review items with migration-needed macros and rewrite for pi-forge's macro system.");
    reportLines.push("3. Consider adding a `variables` slot for template variable visibility.");
    reportLines.push(`4. Run \`/preset validate ${input.stackId}\` to check for issues.`);
    return reportLines.join("\n");
}
function markdownTableCell(value) {
    if (typeof value !== "string" || !value.trim())
        return "-";
    const collapsed = value.replace(/\s+/g, " ").trim();
    const truncated = collapsed.length > 96 ? `${collapsed.slice(0, 93)}...` : collapsed;
    return truncated.replace(/\|/g, "\\|");
}
//# sourceMappingURL=report.js.map