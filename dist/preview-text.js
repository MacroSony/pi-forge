export function isTrulyEmptySystemSection(section) {
    const isSystem = section.id === "system" || section.role === "system";
    if (!isSystem)
        return false;
    const hasContent = Boolean(section.content && section.content.length > 0);
    const hasSections = Boolean(section.sections && Object.keys(section.sections).length > 0);
    const hasToolChanges = Boolean(section.toolChanges &&
        ((section.toolChanges.added && section.toolChanges.added.length > 0) ||
            (section.toolChanges.removed && section.toolChanges.removed.length > 0)));
    return !hasContent && !hasSections && !hasToolChanges;
}
/** Concatenates actual body + non-null section values only (no pseudo headers/tool metadata). */
export function previewSectionText(section) {
    const parts = [];
    if (section.content && section.content.length > 0) {
        parts.push(section.content);
    }
    if (section.sections) {
        for (const val of Object.values(section.sections)) {
            if (typeof val === "string" && val.length > 0) {
                parts.push(val);
            }
        }
    }
    return parts.join("\n\n");
}
//# sourceMappingURL=preview-text.js.map