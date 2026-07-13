export function el(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Editor element #${id} is missing.`);
    return element;
}
export function query(root, selector) {
    return root.querySelector(selector);
}
export function queryAll(root, selector) {
    return root.querySelectorAll(selector);
}
export function eventElement(event) {
    if (!(event.target instanceof Element))
        throw new Error("Editor event has no element target.");
    return event.target;
}
export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    })[character]);
}
export function attr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
}
//# sourceMappingURL=dom.js.map