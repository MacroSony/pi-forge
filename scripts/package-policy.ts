export interface PackedFile {
	path: string;
}

export interface PackageInventory {
	files: readonly PackedFile[];
	size: number;
}

// This is a regression budget, not a target. The text/code-only package is <1 MiB.
export const MAX_PACKED_BYTES = 2 * 1024 * 1024;
const MEDIA_EXTENSION = /\.(?:gif|apng|png|jpe?g|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|m4v|avi|mkv|ogv|mp3|wav|ogg|flac|aac|m4a)$/iu;
const PINNED_README_MEDIA = /^https:\/\/raw\.githubusercontent\.com\/MacroSony\/pi-forge\/[a-f\d]{40}\/assets\/[^?#\s]+$/u;

export function packageMediaFailures(inventory: PackageInventory): string[] {
	const failures: string[] = [];
	for (const { path } of inventory.files) {
		const normalized = path.replaceAll("\\", "/");
		if (/(?:^|\/)assets(?:\/|$)/iu.test(normalized) || MEDIA_EXTENSION.test(normalized)) {
			failures.push(`repository-only media leaked into npm tarball: ${path}`);
		}
	}
	if (!Number.isSafeInteger(inventory.size) || inventory.size < 0) {
		failures.push("npm tarball size must be a non-negative safe integer");
	} else if (inventory.size > MAX_PACKED_BYTES) {
		failures.push(`npm tarball exceeds ${MAX_PACKED_BYTES}-byte compressed budget: ${inventory.size}`);
	}
	return failures;
}

// README media must not depend on assets deliberately absent from the installed package.
// Check Markdown and HTML image syntax used by the landing pages, without network access.
export function readmeMediaFailures(markdown: string, label: string): string[] {
	const urls: string[] = [];
	let inFence = false;
	for (const line of markdown.split(/\r?\n/u)) {
		if (/^\s*(?:```|~~~)/u.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		for (const match of line.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/gu)) {
			urls.push(match[1] ?? match[2]);
		}
		for (const match of line.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
			urls.push(match[1]);
		}
	}
	return urls.filter(url => !PINNED_README_MEDIA.test(url)).map(url =>
		`${label}: README image must use a commit-pinned GitHub raw assets URL: ${url}`,
	);
}
