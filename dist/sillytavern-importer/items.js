import { COMMENT_MACRO_RE, TRIM_MACRO_RE } from "./macros.js";
const MARKER_CHAT_HISTORY = "chatHistory";
const MARKER_SKIP = new Set([
    "worldInfoBefore",
    "worldInfoAfter",
    "charDescription",
    "charPersonality",
    "personaDescription",
    "scenario",
    "dialogueExamples",
]);
export function convertPromptItems(conversionItems) {
    let nextId = 1;
    const items = [];
    let usesLastUserMessage = false;
    const disabledCount = { marker: 0, empty: 0, orderDisable: 0 };
    for (const { def, orderEnabled, orderIndex } of conversionItems) {
        const id = String(nextId++);
        if (def.marker) {
            if (def.identifier === MARKER_CHAT_HISTORY) {
                items.push({
                    kind: "slot",
                    id,
                    name: def.name || "Chat History",
                    enabled: orderEnabled,
                    slot: "chat-history",
                    source: { previousId: def.identifier, name: def.name },
                });
            }
            else if (MARKER_SKIP.has(def.identifier)) {
                disabledCount.marker++;
            }
            continue;
        }
        let content = def.content ?? "";
        if (!content.trim()) {
            disabledCount.empty++;
            continue;
        }
        content = content.replace(COMMENT_MACRO_RE, "");
        content = content.replace(TRIM_MACRO_RE, "");
        if (!content.trim()) {
            disabledCount.empty++;
            continue;
        }
        if (/\{\{\s*lastUserMessage\b/i.test(content)) {
            usesLastUserMessage = true;
        }
        const role = normalizeRole(def.role);
        if (!role) {
            disabledCount.empty++;
            continue;
        }
        if (!orderEnabled) {
            disabledCount.orderDisable++;
        }
        items.push({
            kind: "block",
            id,
            name: def.name,
            enabled: orderEnabled,
            role,
            content: cleanContent(content),
            source: {
                previousId: def.identifier,
                previousName: def.name,
                orderIndex,
            },
        });
    }
    return { items, usesLastUserMessage, disabledCount };
}
function cleanContent(content) {
    return content.replace(/\n{3,}/g, "\n\n").trim();
}
function normalizeRole(role) {
    if (!role)
        return undefined;
    const lower = role.trim().toLowerCase();
    if (lower === "system")
        return "system";
    if (lower === "user")
        return "user";
    if (lower === "assistant")
        return "assistant";
    return undefined;
}
//# sourceMappingURL=items.js.map