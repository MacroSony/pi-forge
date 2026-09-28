import assert from "node:assert/strict";
import type { Page } from "playwright-core";

/** Observe the unmodified application write before the native clipboard transport. */
export async function observeClipboardWrites(page: Page): Promise<void> {
	await page.addInitScript(() => {
		if (!navigator.clipboard) return;
		const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
		navigator.clipboard.writeText = async (text: string) => {
			(window as unknown as { __forgeClipboardWrite?: string }).__forgeClipboardWrite = text;
			return writeText(text);
		};
	});
}

export async function assertClipboardText(page: Page, expected: string): Promise<void> {
	const observed = await page.evaluate(async () => ({
		written: (window as unknown as { __forgeClipboardWrite?: string }).__forgeClipboardWrite,
		read: await navigator.clipboard.readText(),
	}));
	assert.equal(observed.written, expected, "Application writes the complete, unchanged display text");
	// Windows' native text clipboard normalizes line separators. Do not trim,
	// collapse whitespace or weaken the exact application-write assertion above.
	const platformText = (text: string) => process.platform === "win32" ? text.replace(/\r\n/g, "\n") : text;
	assert.equal(platformText(observed.read), platformText(expected), "Clipboard round-trip preserves all text apart from native Windows CRLF conversion");
}
