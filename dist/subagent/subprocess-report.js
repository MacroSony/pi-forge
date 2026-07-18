export const PI_FORGE_SUBPROCESS_REPORT_FD_ENV = "PI_FORGE_SUBAGENT_REPORT_FD";
export const MAX_SUBPROCESS_REPORT_STRING_BYTES = 64 * 1024;
const MIN_BASE64_REDACTION_BYTES = 4 * 1024;
export function sanitizeSubprocessReportValue(value) {
    if (Array.isArray(value))
        return value.map(sanitizeSubprocessReportValue);
    if (typeof value === "string")
        return sanitizeReportString(value);
    if (!isRecord(value))
        return value;
    if (value.type === "image" && typeof value.data === "string") {
        const { data, ...metadata } = value;
        return {
            ...Object.fromEntries(Object.entries(metadata).map(([key, item]) => [key, sanitizeSubprocessReportValue(item)])),
            dataOmitted: true,
            encodedBytes: Buffer.byteLength(data, "utf8"),
        };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeSubprocessReportValue(item)]));
}
function sanitizeReportString(value) {
    const bytes = Buffer.byteLength(value, "utf8");
    if (looksLikeBase64Payload(value, bytes))
        return `[Base64-like data omitted from retained subagent report: ${bytes} encoded bytes]`;
    if (bytes <= MAX_SUBPROCESS_REPORT_STRING_BYTES)
        return value;
    const suffix = `\n[Text truncated in retained subagent report: ${bytes} original bytes]`;
    return `${utf8Prefix(value, MAX_SUBPROCESS_REPORT_STRING_BYTES - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
}
function looksLikeBase64Payload(value, bytes) {
    if (bytes < MIN_BASE64_REDACTION_BYTES)
        return false;
    if (/^data:[^,;]+(?:;[^,]*)?;base64,/i.test(value))
        return true;
    const compact = value.replace(/\s/g, "");
    return compact.length >= MIN_BASE64_REDACTION_BYTES
        && compact.length / value.length >= 0.95
        && /^[A-Za-z0-9+/_=-]+$/.test(compact);
}
function utf8Prefix(value, maxBytes) {
    if (maxBytes <= 0)
        return "";
    const buffer = Buffer.from(value, "utf8");
    if (buffer.length <= maxBytes)
        return value;
    let end = maxBytes;
    let prefix = buffer.subarray(0, end).toString("utf8");
    while (prefix.endsWith("\uFFFD") && end > 0)
        prefix = buffer.subarray(0, --end).toString("utf8");
    return prefix;
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=subprocess-report.js.map