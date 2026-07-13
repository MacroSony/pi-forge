export class EditorApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = "EditorApiError";
	}
}

export type EditorRequestInit = Omit<RequestInit, "body"> & { body?: BodyInit | object };

export function createEditorApi(token: string) {
	return async function api<T = any>(path: string, options: EditorRequestInit = {}): Promise<T> {
		const headers = new Headers(options.headers);
		headers.set("x-pi-forge-token", token);
		let body = options.body;
		if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
			headers.set("content-type", "application/json");
			body = JSON.stringify(body);
		}
		const response = await fetch(path, { ...options, headers, body: body as BodyInit | null | undefined });
		const text = await response.text();
		const data = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string };
		if (!response.ok) throw new EditorApiError(data.error || response.statusText, response.status);
		return data;
	};
}
