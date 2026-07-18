export const PI_FORGE_SUBPROCESS_REPORT_FD_ENV = "PI_FORGE_SUBAGENT_REPORT_FD";
export function sanitizeSubprocessReportValue(value) {
    if (Array.isArray(value))
        return value.map(sanitizeSubprocessReportValue);
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
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
//# sourceMappingURL=subprocess-report.js.map