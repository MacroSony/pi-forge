export class EditorApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "EditorApiError";
    }
}
export function createEditorApi(token) {
    return async function api(path, options = {}) {
        const headers = new Headers(options.headers);
        headers.set("x-pi-forge-token", token);
        let body = options.body;
        if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
            headers.set("content-type", "application/json");
            body = JSON.stringify(body);
        }
        const response = await fetch(path, { ...options, headers, body: body });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok)
            throw new EditorApiError(data.error || response.statusText, response.status);
        return data;
    };
}
//# sourceMappingURL=api.js.map