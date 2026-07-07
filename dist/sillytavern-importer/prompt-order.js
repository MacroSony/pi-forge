export function selectCharacterEntry(order, preferredId) {
    if (order.length === 0)
        return undefined;
    if (preferredId !== undefined) {
        return order.find((entry) => entry.character_id === preferredId);
    }
    if (order.length === 1)
        return order[0];
    return undefined;
}
export function buildPromptMap(prompts) {
    const promptMap = new Map();
    for (const def of prompts) {
        promptMap.set(def.identifier, def);
    }
    return promptMap;
}
export function buildConversionItems(selectedEntry, promptMap) {
    const conversionItems = [];
    let orderIndex = 0;
    for (const orderItem of selectedEntry.order ?? []) {
        const def = promptMap.get(orderItem.identifier);
        if (def) {
            conversionItems.push({ def, orderEnabled: orderItem.enabled, orderIndex: orderIndex++ });
        }
    }
    return conversionItems;
}
export function findMissingIdentifiers(selectedEntry, promptMap) {
    const missingIdentifiers = [];
    for (const orderItem of selectedEntry.order ?? []) {
        if (!promptMap.has(orderItem.identifier)) {
            missingIdentifiers.push(orderItem.identifier);
        }
    }
    return missingIdentifiers;
}
//# sourceMappingURL=prompt-order.js.map