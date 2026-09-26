import { normalizePath } from "vite";

/**
 * Formats a host-native file path into a properly serialized JS string literal
 * import specifier suitable for direct interpolation into generated TS/JS imports.
 *
 * Uses Vite's `normalizePath` for host-native path normalization and `JSON.stringify`
 * so the specifier is safely quoted and escaped without manual quotes.
 */
export function formatImportSpecifier(path: string): string {
	return JSON.stringify(normalizePath(path));
}

/**
 * Compares two paths under Vite's path normalization so that Vite's
 * slash-normalized module IDs match host-native resolved paths on Windows.
 */
export function isSamePath(pathA: string, pathB: string): boolean {
	return normalizePath(pathA) === normalizePath(pathB);
}
