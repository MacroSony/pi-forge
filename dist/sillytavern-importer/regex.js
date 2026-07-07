const ST_REGEX_PLACEMENT_LABELS = {
    0: "MD Display",
    1: "User Input",
    2: "AI Output",
    3: "Slash Commands",
    5: "World Info",
    6: "Reasoning",
};
export function summarizeRegexScripts(preset) {
    const rawScripts = preset.extensions?.regex_scripts;
    if (!Array.isArray(rawScripts))
        return undefined;
    const scripts = rawScripts
        .map((raw, index) => classifyRegexScript(raw, index))
        .filter((script) => script !== undefined);
    const report = {
        total: scripts.length,
        enabled: 0,
        disabled: 0,
        promptOnly: 0,
        markdownOnly: 0,
        mixed: 0,
        unspecified: 0,
        converted: 0,
        scripts,
        rules: [],
    };
    const seenRuleIds = new Set();
    for (const [index, script] of scripts.entries()) {
        const conversion = convertPromptOnlyRegexScript(script, index, seenRuleIds);
        if (conversion.rule) {
            report.rules.push(conversion.rule);
            report.converted++;
            script.convertedRuleId = conversion.rule.id;
        }
        else if (conversion.note) {
            script.conversionNote = conversion.note;
        }
        if (!script.enabled) {
            report.disabled++;
            continue;
        }
        report.enabled++;
        if (script.mode === "prompt-only")
            report.promptOnly++;
        else if (script.mode === "markdown-only")
            report.markdownOnly++;
        else if (script.mode === "prompt+markdown")
            report.mixed++;
        else if (script.mode === "unspecified")
            report.unspecified++;
    }
    return report;
}
function classifyRegexScript(raw, index) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const script = raw;
    const enabled = script.disabled !== true;
    const promptOnly = script.promptOnly === true;
    const markdownOnly = script.markdownOnly === true;
    const mode = enabled
        ? promptOnly && markdownOnly
            ? "prompt+markdown"
            : promptOnly
                ? "prompt-only"
                : markdownOnly
                    ? "markdown-only"
                    : "unspecified"
        : "disabled";
    return {
        name: firstString(script.script_name, script.scriptName, script.name) ?? `regex-${index + 1}`,
        mode,
        enabled,
        promptOnly,
        markdownOnly,
        findRegex: firstString(script.findRegex),
        replaceString: firstString(script.replaceString),
        trimStrings: normalizeTrimStrings(script.trimStrings),
        placement: normalizeNumberArray(script.placement),
        substituteRegex: normalizeNumber(script.substituteRegex),
        minDepth: normalizeDepth(script.minDepth, -1),
        maxDepth: normalizeDepth(script.maxDepth, 0),
        conversionWarnings: [],
    };
}
function convertPromptOnlyRegexScript(entry, index, seenRuleIds) {
    if (!entry.promptOnly)
        return { note: entry.enabled ? "not prompt-only" : "disabled non-prompt script" };
    if (entry.markdownOnly)
        return { note: "mixed prompt/display script requires review" };
    if (!entry.findRegex)
        return { note: "missing findRegex" };
    const parsed = parseSillyTavernRegex(entry.findRegex);
    if ("error" in parsed)
        return { note: parsed.error };
    if (entry.placement && entry.placement.length > 0 && !entry.placement.some((placement) => placement === 1 || placement === 2)) {
        return { note: "placement has no pi-forge runtime mapping" };
    }
    const replacement = normalizeSillyTavernReplacement(entry.replaceString ?? "", entry.conversionWarnings);
    const roles = rolesForSillyTavernPlacement(entry.placement, entry.conversionWarnings);
    if (entry.substituteRegex && entry.substituteRegex !== 0) {
        entry.conversionWarnings.push("substituteRegex is preserved as metadata but dynamic find-regex macro substitution is not executed");
    }
    for (const placement of entry.placement ?? []) {
        if (placement !== 1 && placement !== 2) {
            entry.conversionWarnings.push(`placement ${placementLabel(placement)} is preserved as metadata but not directly mapped`);
        }
    }
    const id = uniqueRegexRuleId(`st-${entry.name || `regex-${index + 1}`}`, seenRuleIds);
    const rule = {
        id,
        name: entry.name,
        enabled: entry.enabled,
        stage: "history",
        effect: "outgoing",
        pattern: parsed.pattern,
        replace: replacement,
        source: {
            sillytavern: {
                scriptName: entry.name,
                findRegex: entry.findRegex,
                replaceString: entry.replaceString ?? "",
                trimStrings: entry.trimStrings ?? [],
                placement: entry.placement ?? [],
                placementNames: (entry.placement ?? []).map(placementLabel),
                promptOnly: entry.promptOnly,
                markdownOnly: entry.markdownOnly,
                substituteRegex: entry.substituteRegex ?? 0,
                minDepth: entry.minDepth,
                maxDepth: entry.maxDepth,
            },
        },
    };
    if (parsed.flags)
        rule.flags = parsed.flags;
    if (entry.trimStrings && entry.trimStrings.length > 0)
        rule.trimStrings = entry.trimStrings;
    if (roles && roles.length > 0)
        rule.roles = roles;
    if (isNonNegativeInteger(entry.minDepth))
        rule.minDepth = entry.minDepth;
    if (isNonNegativeInteger(entry.maxDepth))
        rule.maxDepth = entry.maxDepth;
    return {
        rule,
    };
}
function parseSillyTavernRegex(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return { error: "empty findRegex" };
    if (!trimmed.startsWith("/"))
        return validateParsedRegex(trimmed, "");
    const closingSlash = findRegexLiteralClosingSlash(trimmed);
    if (closingSlash <= 0)
        return { error: "could not parse regex literal" };
    const pattern = trimmed.slice(1, closingSlash);
    const flags = trimmed.slice(closingSlash + 1);
    return validateParsedRegex(pattern, flags);
}
function normalizeSillyTavernReplacement(value, warnings) {
    let result = value;
    if (/\{\{\s*match\s*\}\}/i.test(result)) {
        result = result.replace(/\{\{\s*match\s*\}\}/gi, () => "$&");
        warnings.push("converted SillyTavern {{match}} to JavaScript $&");
    }
    if (/\$0(?!\d)/.test(result)) {
        result = result.replace(/\$0(?!\d)/g, () => "$&");
        warnings.push("converted SillyTavern-style $0 full match to JavaScript $&");
    }
    return result;
}
function rolesForSillyTavernPlacement(placement, warnings) {
    if (!placement || placement.length === 0)
        return undefined;
    const roles = [];
    if (placement.includes(1))
        roles.push("user");
    if (placement.includes(2))
        roles.push("assistant");
    if (placement.includes(6))
        warnings.push("reasoning placement is preserved as metadata; use stripAssistantThinking or manual rules for thinking content");
    return roles.length > 0 ? roles : undefined;
}
function placementLabel(value) {
    return ST_REGEX_PLACEMENT_LABELS[value] ? `${ST_REGEX_PLACEMENT_LABELS[value]} (${value})` : `unknown (${value})`;
}
function normalizeTrimStrings(value) {
    if (typeof value === "string") {
        const strings = value.split(/\r?\n/).filter((entry) => entry.length > 0);
        return strings.length > 0 ? strings : undefined;
    }
    if (!Array.isArray(value))
        return undefined;
    const strings = value.filter((entry) => typeof entry === "string" && entry.length > 0);
    return strings.length > 0 ? strings : undefined;
}
function normalizeNumberArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const numbers = value
        .map(normalizeNumber)
        .filter((entry) => entry !== undefined);
    return numbers.length > 0 ? numbers : undefined;
}
function normalizeNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    if (typeof value === "boolean")
        return value ? 1 : 0;
    return undefined;
}
function normalizeDepth(value, minimum) {
    const number = normalizeNumber(value);
    if (number === undefined || !Number.isInteger(number) || number < minimum)
        return undefined;
    return number;
}
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function validateParsedRegex(pattern, flags) {
    if (!pattern)
        return { error: "empty regex pattern" };
    const seen = new Set();
    for (const flag of flags) {
        if (!["g", "i", "m", "s", "u"].includes(flag))
            return { error: `unsupported regex flag: ${flag}` };
        if (seen.has(flag))
            return { error: `duplicate regex flag: ${flag}` };
        seen.add(flag);
    }
    try {
        new RegExp(pattern, flags);
    }
    catch (error) {
        return { error: `regex failed to compile: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { pattern, flags: flags || undefined };
}
function findRegexLiteralClosingSlash(value) {
    for (let index = value.length - 1; index > 0; index--) {
        if (value[index] !== "/")
            continue;
        let slashCount = 0;
        for (let backslash = index - 1; backslash >= 0 && value[backslash] === "\\"; backslash--)
            slashCount++;
        if (slashCount % 2 === 0)
            return index;
    }
    return -1;
}
function uniqueRegexRuleId(base, seen) {
    const normalized = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "st-regex";
    let candidate = normalized;
    let suffix = 2;
    while (seen.has(candidate))
        candidate = `${normalized}-${suffix++}`;
    seen.add(candidate);
    return candidate;
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value;
    }
    return undefined;
}
//# sourceMappingURL=regex.js.map