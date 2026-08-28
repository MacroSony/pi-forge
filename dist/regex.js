const ALLOWED_REGEX_FLAGS = new Set(["g", "i", "m", "s", "u"]);
const VALID_STAGES = new Set(["history", "compiled"]);
const VALID_EFFECTS = new Set(["outgoing", "finalize"]);
const VALID_TARGETS = new Set(["system", "messages"]);
const VALID_FREQUENCIES = new Set(["turn", "request"]);
const FINALIZE_ROLES = new Set(["assistant", "toolResult"]);
export function validateRegexConfig(config) {
    const diagnostics = [];
    if (config === undefined)
        return diagnostics;
    if (!isPlainObject(config)) {
        diagnostics.push({ level: "warning", message: "regex must be an object when provided." });
        return diagnostics;
    }
    if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
        diagnostics.push({ level: "warning", message: "Missing or unsupported regex.schemaVersion; assuming 1." });
    }
    const rawRules = config.rules;
    if (rawRules === undefined)
        return diagnostics;
    if (!Array.isArray(rawRules)) {
        diagnostics.push({ level: "error", message: "regex.rules must be an array when provided." });
        return diagnostics;
    }
    const seenIds = new Set();
    for (const [index, rawRule] of rawRules.entries()) {
        validateRule(rawRule, index, seenIds, diagnostics);
    }
    return diagnostics;
}
export function applyRegexRulesToString(stack, text, stage, target, diagnostics) {
    let result = text;
    for (const rule of regexRulesFor(stack, stage, target, "outgoing", diagnostics)) {
        const transformed = transformString(result, rule);
        result = transformed.text;
        addRuleStats(diagnostics, rule, stage, target, {
            matches: transformed.matches,
            changedSegments: transformed.changed ? 1 : 0,
        });
    }
    return result;
}
export function applyRegexRulesToMessages(stack, messages, stage, diagnostics) {
    let result = messages;
    for (const rule of regexRulesFor(stack, stage, "messages", "outgoing", diagnostics)) {
        const stats = { matches: 0, changedSegments: 0 };
        result = transformMessages(result, rule, stats);
        addRuleStats(diagnostics, rule, stage, "messages", stats);
    }
    return result;
}
/** True when the stack has outgoing message rules that opt into every-request application. */
export function hasRequestFrequencyRules(stack) {
    return requestFrequencyMessageRules(stack, []).length > 0;
}
/**
 * Apply outgoing rules with `frequency: "request"` to Pi's natural context on
 * a tool-result follow-up request. On follow-ups there is no stack layout
 * rewrite, so both stages collapse onto the transcript: history-stage rules
 * and compiled-stage rules targeting messages all apply to the full natural
 * context. History-stage rules run first, mirroring compile order. Each
 * provider request is rebuilt from the transcript, so re-application is
 * wire-consistent and never doubled.
 */
export function applyRequestFrequencyRulesToMessages(stack, messages, diagnostics) {
    let result = messages;
    for (const rule of requestFrequencyMessageRules(stack, diagnostics)) {
        const stats = { matches: 0, changedSegments: 0 };
        result = transformMessages(result, rule, stats);
        addRuleStats(diagnostics, rule, rule.stage, "messages", stats);
    }
    return result;
}
function requestFrequencyMessageRules(stack, diagnostics) {
    const rules = Array.isArray(stack.regex?.rules) ? stack.regex.rules : [];
    const historyRules = [];
    const compiledRules = [];
    for (const rawRule of rules) {
        if (!isPlainObject(rawRule))
            continue;
        if (rawRule.enabled === false)
            continue;
        if (rawRule.frequency !== "request")
            continue;
        if ((rawRule.effect ?? "outgoing") !== "outgoing")
            continue;
        if (rawRule.stage === "compiled" && Array.isArray(rawRule.targets) && !rawRule.targets.includes("messages"))
            continue;
        const rule = compileRuntimeRule(rawRule, diagnostics);
        if (!rule)
            continue;
        if (rule.stage === "history")
            historyRules.push(rule);
        else
            compiledRules.push(rule);
    }
    return [...historyRules, ...compiledRules];
}
export function applyFinalizeRegexRulesToMessage(stack, message, diagnostics) {
    const role = String(message.role);
    if (!FINALIZE_ROLES.has(role))
        return undefined;
    let result = message;
    for (const rule of regexRulesFor(stack, "compiled", "messages", "finalize", diagnostics)) {
        // toolResult requires explicit opt-in via the rule's roles; rules without
        // roles keep their assistant-only behavior from before the extension.
        if (role === "toolResult" && !rule.roles?.includes("toolResult"))
            continue;
        const stats = { matches: 0, changedSegments: 0 };
        const [next = result] = transformMessages([result], rule, stats);
        result = next;
        addRuleStats(diagnostics, rule, "finalize", "messages", stats);
    }
    if (result === message)
        return undefined;
    diagnostics.push({
        level: "warning",
        message: "Finalize regex replaced stored message content; the original content is not preserved in the transcript.",
    });
    return result;
}
function validateRule(rawRule, index, seenIds, diagnostics) {
    const label = `regex rule ${index + 1}`;
    if (!isPlainObject(rawRule)) {
        diagnostics.push({ level: "error", message: `${label} must be an object.` });
        return;
    }
    const id = typeof rawRule.id === "string" ? rawRule.id.trim() : "";
    if (!id) {
        diagnostics.push({ level: "error", message: `${label} must have a non-empty id.` });
    }
    else if (seenIds.has(id)) {
        diagnostics.push({ level: "error", message: `Duplicate regex rule id: ${id}.` });
    }
    else {
        seenIds.add(id);
    }
    if (rawRule.enabled !== undefined && typeof rawRule.enabled !== "boolean") {
        diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} enabled must be a boolean when provided.` });
    }
    if (!VALID_STAGES.has(rawRule.stage)) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} stage must be "history" or "compiled".` });
    }
    const effect = typeof rawRule.effect === "string" ? rawRule.effect : undefined;
    if (rawRule.effect !== undefined) {
        if (!VALID_EFFECTS.has(rawRule.effect)) {
            diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} effect must be "outgoing" or "finalize".` });
        }
        else if (rawRule.effect === "finalize") {
            diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} effect "finalize" rewrites stored assistant/tool-result messages at completion time; the original content is not preserved in the transcript.` });
        }
    }
    if (rawRule.frequency !== undefined) {
        if (!VALID_FREQUENCIES.has(rawRule.frequency)) {
            diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} frequency must be "turn" or "request".` });
        }
        else if (effect === "finalize") {
            diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} frequency has no effect for "finalize" rules; finalize runs when each message completes.` });
        }
        else if (rawRule.frequency === "request"
            && rawRule.stage === "compiled"
            && isStringArray(rawRule.targets)
            && !rawRule.targets.includes("messages")) {
            diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} frequency "request" has no effect: the rule does not target messages.` });
        }
    }
    if (effect === "finalize" && rawRule.stage !== "compiled") {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} effect "finalize" requires stage "compiled".` });
    }
    if (typeof rawRule.pattern !== "string" || rawRule.pattern.length === 0) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} pattern must be a non-empty string.` });
    }
    else {
        const flagsError = validateRegexFlags(rawRule.flags, id, index);
        if (flagsError)
            diagnostics.push({ level: "error", message: flagsError });
        else {
            try {
                new RegExp(rawRule.pattern, typeof rawRule.flags === "string" ? rawRule.flags : "");
            }
            catch (error) {
                diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} pattern failed to compile: ${error instanceof Error ? error.message : String(error)}` });
            }
        }
    }
    if (rawRule.replace !== undefined && typeof rawRule.replace !== "string") {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} replace must be a string when provided.` });
    }
    else if (typeof rawRule.replace === "string") {
        if (/\{\{\s*match\s*\}\}/i.test(rawRule.replace)) {
            diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} replacement contains {{match}}; use JavaScript $& or $0 for the full match.` });
        }
    }
    if (rawRule.trimStrings !== undefined && !isStringArray(rawRule.trimStrings)) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} trimStrings must be an array of strings when provided.` });
    }
    if (rawRule.roles !== undefined && !isStringArray(rawRule.roles)) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} roles must be an array of strings when provided.` });
    }
    if (rawRule.targets !== undefined) {
        if (!isStringArray(rawRule.targets)) {
            diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} targets must be an array of strings when provided.` });
        }
        else {
            for (const target of rawRule.targets) {
                if (!VALID_TARGETS.has(target)) {
                    diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} target must be "system" or "messages": ${target}.` });
                }
                else if (effect === "finalize" && target !== "messages") {
                    diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} effect "finalize" only supports target "messages": ${target}.` });
                }
            }
        }
    }
    if (effect === "finalize" && isStringArray(rawRule.roles)) {
        const runnable = rawRule.roles.filter((role) => FINALIZE_ROLES.has(role));
        const unsupported = rawRule.roles.filter((role) => !FINALIZE_ROLES.has(role));
        if (runnable.length === 0) {
            diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} effect "finalize" only runs for finalized assistant and tool-result messages, but roles includes neither.` });
        }
        else if (unsupported.length > 0) {
            diagnostics.push({ level: "warning", message: `${regexRuleLabel(id, index)} effect "finalize" ignores unsupported roles: ${unsupported.join(", ")} (only assistant and tool-result messages are finalized).` });
        }
    }
    if (rawRule.maxMessages !== undefined && !isPositiveInteger(rawRule.maxMessages)) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} maxMessages must be a positive integer when provided.` });
    }
    if (rawRule.maxChars !== undefined && !isPositiveInteger(rawRule.maxChars)) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} maxChars must be a positive integer when provided.` });
    }
    if (rawRule.minDepth !== undefined && !isNonNegativeInteger(rawRule.minDepth)) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} minDepth must be a non-negative integer when provided.` });
    }
    if (rawRule.maxDepth !== undefined && !isNonNegativeInteger(rawRule.maxDepth)) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} maxDepth must be a non-negative integer when provided.` });
    }
    if (isNonNegativeInteger(rawRule.minDepth) && isNonNegativeInteger(rawRule.maxDepth) && rawRule.maxDepth < rawRule.minDepth) {
        diagnostics.push({ level: "error", message: `${regexRuleLabel(id, index)} maxDepth must be greater than or equal to minDepth.` });
    }
}
function regexRulesFor(stack, stage, target, effect, diagnostics) {
    const rules = Array.isArray(stack.regex?.rules) ? stack.regex.rules : [];
    const compiled = [];
    for (const rawRule of rules) {
        if (!isPlainObject(rawRule))
            continue;
        if (rawRule.enabled === false)
            continue;
        if ((rawRule.effect ?? "outgoing") !== effect)
            continue;
        if (rawRule.stage !== stage)
            continue;
        if (stage === "compiled" && Array.isArray(rawRule.targets) && !rawRule.targets.includes(target))
            continue;
        const rule = compileRuntimeRule(rawRule, diagnostics);
        if (rule)
            compiled.push(rule);
    }
    return compiled;
}
function compileRuntimeRule(rule, diagnostics) {
    if (typeof rule.id !== "string" || !rule.id.trim())
        return undefined;
    if (rule.stage !== "history" && rule.stage !== "compiled")
        return undefined;
    const effect = rule.effect ?? "outgoing";
    if (!VALID_EFFECTS.has(effect))
        return undefined;
    if (typeof rule.pattern !== "string" || rule.pattern.length === 0)
        return undefined;
    const flags = typeof rule.flags === "string" ? rule.flags : "";
    const flagsError = validateRegexFlags(flags, rule.id, -1);
    if (flagsError)
        return undefined;
    try {
        return {
            id: rule.id.trim(),
            stage: rule.stage,
            effect,
            frequency: VALID_FREQUENCIES.has(rule.frequency) ? rule.frequency : "turn",
            targets: normalizeTargets(rule.targets),
            roles: isStringArray(rule.roles) ? rule.roles : undefined,
            maxMessages: isPositiveInteger(rule.maxMessages) ? Math.floor(rule.maxMessages) : undefined,
            maxChars: isPositiveInteger(rule.maxChars) ? Math.floor(rule.maxChars) : undefined,
            minDepth: isNonNegativeInteger(rule.minDepth) ? Math.floor(rule.minDepth) : undefined,
            maxDepth: isNonNegativeInteger(rule.maxDepth) ? Math.floor(rule.maxDepth) : undefined,
            regexp: new RegExp(rule.pattern, flags),
            replace: typeof rule.replace === "string" ? rule.replace : "",
            trimStrings: isStringArray(rule.trimStrings) ? rule.trimStrings : undefined,
        };
    }
    catch (error) {
        diagnostics.push({ level: "error", message: `Regex rule ${rule.id} failed to compile: ${error instanceof Error ? error.message : String(error)}` });
        return undefined;
    }
}
function transformMessages(messages, rule, stats) {
    const eligible = eligibleMessageIndexes(messages, rule);
    const eligibleSet = new Set(rule.maxMessages ? eligible.slice(-rule.maxMessages) : eligible);
    let changed = false;
    const transformed = messages.map((message, index) => {
        if (!eligibleSet.has(index))
            return message;
        const next = transformMessage(message, rule, stats);
        if (next !== message)
            changed = true;
        return next;
    });
    return changed ? transformed : messages;
}
function eligibleMessageIndexes(messages, rule) {
    const indexes = [];
    for (const [index, message] of messages.entries()) {
        if (rule.roles && !rule.roles.includes(String(message.role)))
            continue;
        const depth = messages.length - 1 - index;
        if (rule.minDepth !== undefined && depth < rule.minDepth)
            continue;
        if (rule.maxDepth !== undefined && depth > rule.maxDepth)
            continue;
        indexes.push(index);
    }
    return indexes;
}
function transformMessage(message, rule, stats) {
    const content = message.content;
    if (typeof content === "string") {
        const result = transformString(content, rule);
        mergeStringStats(stats, result);
        return result.changed ? { ...message, content: result.text } : message;
    }
    if (!Array.isArray(content))
        return message;
    let changed = false;
    const nextContent = content.map((part) => {
        if (!isPlainObject(part) || part.type !== "text" || typeof part.text !== "string")
            return part;
        const result = transformString(part.text, rule);
        mergeStringStats(stats, result);
        if (!result.changed)
            return part;
        changed = true;
        return { ...part, text: result.text };
    });
    return changed ? { ...message, content: nextContent } : message;
}
function transformString(text, rule) {
    const headLength = rule.maxChars && text.length > rule.maxChars ? text.length - rule.maxChars : 0;
    const head = headLength > 0 ? text.slice(0, headLength) : "";
    const body = headLength > 0 ? text.slice(headLength) : text;
    const matches = countReplacementMatches(body, rule.regexp);
    const replaced = rule.trimStrings && rule.trimStrings.length > 0
        ? replaceWithTrimStrings(body, rule)
        : body.replace(rule.regexp, convertDollarZeroToFullMatch(rule.replace));
    const result = head + replaced;
    return {
        text: result,
        matches,
        changed: result !== text,
    };
}
/**
 * Normalizes a JavaScript replacement string so that `$0` (not followed by another
 * digit) behaves as the full match, matching the custom trimStrings expander.
 * `$$0` stays a literal `$0`. This keeps `$0` consistent across the native and
 * trimStrings replacement paths.
 */
function convertDollarZeroToFullMatch(replace) {
    let result = "";
    for (let i = 0; i < replace.length;) {
        const ch = replace[i];
        if (ch !== undefined && ch !== "$") {
            result += ch;
            i++;
            continue;
        }
        const next = replace[i + 1];
        if (next === "$") {
            result += "$$";
            i += 2;
            continue;
        }
        if (next === "0" && !isDigitCode(replace.charCodeAt(i + 2))) {
            result += "$&";
            i += 2;
            continue;
        }
        result += "$";
        i++;
    }
    return result;
}
function isDigitCode(code) {
    return code >= 48 && code <= 57;
}
function replaceWithTrimStrings(text, rule) {
    return text.replace(rule.regexp, (...args) => {
        const groups = isPlainObject(args.at(-1)) ? args.pop() : undefined;
        const input = String(args.pop() ?? "");
        const offset = Number(args.pop() ?? 0);
        const [match = "", ...captures] = args.map((arg) => typeof arg === "string" ? arg : "");
        return expandReplacementTemplate(rule.replace, {
            match,
            captures,
            offset,
            input,
            groups,
            trimStrings: rule.trimStrings ?? [],
        });
    });
}
function expandReplacementTemplate(template, context) {
    return template.replace(/\$([$&`']|0(?!\d)|[1-9]\d?|<[^>]+>)/g, (token) => {
        if (token === "$$")
            return "$";
        if (token === "$&" || token === "$0")
            return trimMatchedValue(context.match, context.trimStrings);
        if (token === "$`")
            return context.input.slice(0, context.offset);
        if (token === "$'")
            return context.input.slice(context.offset + context.match.length);
        if (token.startsWith("$<")) {
            const name = token.slice(2, -1);
            const value = context.groups?.[name];
            return typeof value === "string" ? trimMatchedValue(value, context.trimStrings) : "";
        }
        const captureIndex = Number(token.slice(1)) - 1;
        const capture = context.captures[captureIndex];
        return capture === undefined ? "" : trimMatchedValue(capture, context.trimStrings);
    });
}
function trimMatchedValue(value, trimStrings) {
    let result = value;
    for (const trimString of trimStrings) {
        if (!trimString)
            continue;
        result = result.split(trimString).join("");
    }
    return result;
}
function countReplacementMatches(text, regexp) {
    if (!regexp.global)
        return new RegExp(regexp.source, regexp.flags.replace("g", "")).test(text) ? 1 : 0;
    const matcher = new RegExp(regexp.source, regexp.flags);
    let count = 0;
    let match;
    while ((match = matcher.exec(text)) !== null) {
        count++;
        if (match[0] === "")
            matcher.lastIndex++;
    }
    return count;
}
function mergeStringStats(stats, result) {
    stats.matches += result.matches;
    if (result.changed)
        stats.changedSegments++;
}
function addRuleStats(diagnostics, rule, stage, target, stats) {
    if (stats.matches === 0)
        return;
    diagnostics.push({
        level: "info",
        message: `Regex rule ${rule.id} matched ${stats.matches} time(s) and changed ${stats.changedSegments} text segment(s) in ${stage}/${target}.`,
    });
}
function validateRegexFlags(value, id, index) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        return `${regexRuleLabel(id, index)} flags must be a string when provided.`;
    const seen = new Set();
    for (const flag of value) {
        if (!ALLOWED_REGEX_FLAGS.has(flag))
            return `${regexRuleLabel(id, index)} has unsupported regex flag: ${flag}.`;
        if (seen.has(flag))
            return `${regexRuleLabel(id, index)} has duplicate regex flag: ${flag}.`;
        seen.add(flag);
    }
    return undefined;
}
function normalizeTargets(value) {
    if (!isStringArray(value))
        return undefined;
    return value.filter((target) => target === "system" || target === "messages");
}
function regexRuleLabel(id, index) {
    return id ? `Regex rule ${id}` : `regex rule ${index + 1}`;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isPositiveInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=regex.js.map