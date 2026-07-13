export interface EditorElement extends HTMLElement {
	value: string;
	checked: boolean;
	disabled: boolean;
	files: FileList | null;
}

export function el<T extends HTMLElement = EditorElement>(id: string): T {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Editor element #${id} is missing.`);
	return element as T;
}

export function query<T extends Element = EditorElement>(root: ParentNode, selector: string): T | null {
	return root.querySelector<T>(selector);
}

export function queryAll<T extends Element = EditorElement>(root: ParentNode, selector: string): NodeListOf<T> {
	return root.querySelectorAll<T>(selector);
}

export function eventElement(event: Event): EditorElement {
	if (!(event.target instanceof Element)) throw new Error("Editor event has no element target.");
	return event.target as EditorElement;
}

export function escapeHtml(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	})[character]!);
}

export function attr(value: unknown): string {
	return escapeHtml(value).replace(/`/g, "&#096;");
}
