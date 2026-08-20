import { ref } from "vue";

/**
 * Shared editor theme state. Theme is global to the whole editor page (both
 * the stacks and profiles surfaces), persisted to localStorage, applied to
 * `body[data-theme]`, and exposed as a Vue ref so any surface can render and
 * toggle it. Defaults to the OS color-scheme preference when no stored choice
 * exists.
 */
export type EditorTheme = "light" | "dark";

const THEME_STORAGE_KEY = "pi-forge-theme";

function readStoredTheme(): EditorTheme | "" {
	try {
		const theme = localStorage.getItem(THEME_STORAGE_KEY);
		return theme === "light" || theme === "dark" ? theme : "";
	} catch {
		return "";
	}
}

function systemTheme(): EditorTheme {
	return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function initialTheme(): EditorTheme {
	return readStoredTheme() || systemTheme();
}

export const editorTheme = ref<EditorTheme>(initialTheme());

export function applyEditorTheme(theme: EditorTheme): void {
	editorTheme.value = theme;
	document.body.dataset.theme = theme;
}

export function setEditorTheme(theme: EditorTheme): void {
	applyEditorTheme(theme);
	try {
		localStorage.setItem(THEME_STORAGE_KEY, theme);
	} catch {
		// Ignore storage failures; the current page can still switch themes.
	}
}

export function toggleEditorTheme(): void {
	setEditorTheme(editorTheme.value === "dark" ? "light" : "dark");
}
