import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownFiles = collectMarkdown(rootDir);
const failures = [];
let checkedLinks = 0;

for (const sourcePath of markdownFiles) {
	const source = readFileSync(sourcePath, "utf8");
	for (const destination of markdownDestinations(source)) {
		if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(destination)) continue;

		const [rawPath, rawFragment = ""] = destination.split("#", 2);
		const decodedPath = decodeURIComponent(rawPath || "");
		const targetPath = decodedPath ? resolve(dirname(sourcePath), decodedPath) : sourcePath;
		checkedLinks += 1;

		if (!existsSync(targetPath)) {
			failures.push(`${display(sourcePath)}: missing target ${destination}`);
			continue;
		}

		if (rawFragment && extname(targetPath).toLowerCase() === ".md") {
			const fragment = decodeURIComponent(rawFragment).toLowerCase();
			if (!markdownAnchors(readFileSync(targetPath, "utf8")).has(fragment)) {
				failures.push(`${display(sourcePath)}: missing anchor ${destination}`);
			}
		}
	}
}

if (failures.length > 0) {
	console.error("Documentation links are invalid:");
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log(`Documentation links are valid (${markdownFiles.length} files; ${checkedLinks} local links).`);
}

function collectMarkdown(directory) {
	const paths = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if ([".git", "dist", "node_modules"].includes(entry.name) || entry.name.startsWith(".dist-check-")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) paths.push(...collectMarkdown(path));
		else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
	}
	return paths.sort();
}

function markdownDestinations(markdown) {
	const destinations = [];
	let inFence = false;
	for (const line of markdown.split(/\r?\n/u)) {
		if (/^\s*(```|~~~)/u.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;

		for (const match of line.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+['"][^'"]*['"])?\)/gu)) {
			destinations.push(stripAngles(match[1]));
		}
		const definition = line.match(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/u);
		if (definition) destinations.push(stripAngles(definition[1]));
	}
	return destinations;
}

function markdownAnchors(markdown) {
	const anchors = new Set();
	const counts = new Map();
	let inFence = false;
	for (const line of markdown.split(/\r?\n/u)) {
		if (/^\s*(```|~~~)/u.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
		if (!heading) continue;
		const base = heading[1]
			.replace(/<[^>]*>/gu, "")
			.replace(/[`*_~]/gu, "")
			.toLowerCase()
			.trim()
			.replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
			.replace(/\s+/gu, "-");
		const count = counts.get(base) ?? 0;
		counts.set(base, count + 1);
		anchors.add(count === 0 ? base : `${base}-${count}`);
	}
	return anchors;
}

function stripAngles(value) {
	return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

function display(path) {
	return relative(rootDir, path) || ".";
}
