import { join } from "node:path";
import { promptStacksDir } from "./storage.ts";
import {
	copyLegacyPromptStackFile,
	deleteLegacyPromptStackFile,
	readLegacyPromptStackSources,
	type LegacyPromptStackSource,
} from "./repositories/prompt-stack.ts";

export interface PromptStackMigrationOptions {
	dryRun?: boolean;
	overwrite?: boolean;
	deleteLegacy?: boolean;
}

export interface PromptStackMigrationFile {
	name: string;
	sourcePath: string;
	targetPath: string;
	action: "copy" | "overwrite" | "skip" | "error";
	reason?: string;
	deleteLegacy: boolean;
}

export interface PromptStackMigrationReport {
	sourceDir: string;
	targetDir: string;
	dryRun: boolean;
	overwrite: boolean;
	deleteLegacy: boolean;
	files: PromptStackMigrationFile[];
	copied: number;
	overwritten: number;
	skipped: number;
	errors: number;
	deletedLegacy: number;
}

/**
 * Orchestrate the legacy `.pi/prompt-stacks` -> `.pi/forge/prompt-stacks`
 * migration. All filesystem IO (raw byte-preserving reads, copies, deletes)
 * lives in the prompt-stack repository; this command owns only reporting,
 * overwrite policy, dry-run, and deletion ordering.
 */
export function migrateLegacyPromptStacks(cwd: string, options: PromptStackMigrationOptions = {}): PromptStackMigrationReport {
	const sourceDir = join(cwd, ".pi", "prompt-stacks");
	const targetDir = promptStacksDir(cwd);
	const report: PromptStackMigrationReport = {
		sourceDir,
		targetDir,
		dryRun: options.dryRun === true,
		overwrite: options.overwrite === true,
		deleteLegacy: options.deleteLegacy === true,
		files: [],
		copied: 0,
		overwritten: 0,
		skipped: 0,
		errors: 0,
		deletedLegacy: 0,
	};

	let sources: LegacyPromptStackSource[];
	try {
		sources = readLegacyPromptStackSources(cwd);
	} catch {
		sources = [];
	}
	if (sources.length === 0) return report;

	for (const source of sources) {
		const targetPath = join(targetDir, source.name);
		const copy = copyLegacyPromptStackFile(cwd, source.sourcePath, targetPath, {
			overwrite: report.overwrite,
			dryRun: report.dryRun,
		});

		if (!copy.ok && copy.reason === "exists") {
			report.files.push({
				name: source.name,
				sourcePath: source.sourcePath,
				targetPath,
				action: "skip",
				reason: "target already exists",
				deleteLegacy: false,
			});
			report.skipped++;
			continue;
		}

		if (!copy.ok) {
			report.files.push({
				name: source.name,
				sourcePath: source.sourcePath,
				targetPath,
				action: "error",
				reason: copy.error,
				deleteLegacy: false,
			});
			report.errors++;
			continue;
		}

		if (copy.action === "overwrite") report.overwritten++;
		else report.copied++;

		let deletedLegacy = false;
		if (report.deleteLegacy) {
			const deleted = deleteLegacyPromptStackFile(cwd, source.sourcePath, { dryRun: report.dryRun });
			if (deleted.ok) {
				deletedLegacy = true;
				report.deletedLegacy++;
			}
		}

		report.files.push({
			name: source.name,
			sourcePath: source.sourcePath,
			targetPath,
			action: copy.action,
			deleteLegacy: deletedLegacy,
		});
	}

	return report;
}

export function renderMigrationReport(report: PromptStackMigrationReport): string {
	const lines = [
		"# Prompt Stack Migration",
		"",
		`Source: ${report.sourceDir}`,
		`Target: ${report.targetDir}`,
		`Mode: ${report.dryRun ? "dry run" : "write"}`,
		`Overwrite existing target files: ${report.overwrite ? "yes" : "no"}`,
		`Delete legacy files after copy: ${report.deleteLegacy ? "yes" : "no"}`,
		"",
		`Copied: ${report.copied}`,
		`Overwritten: ${report.overwritten}`,
		`Skipped: ${report.skipped}`,
		`Errors: ${report.errors}`,
		`Deleted legacy files: ${report.deletedLegacy}`,
		"",
		"## Files",
		"",
	];

	if (report.files.length === 0) {
		lines.push("No legacy prompt-stack JSON files found.");
		return lines.join("\n");
	}

	for (const file of report.files) {
		const suffix = file.reason ? ` (${file.reason})` : "";
		lines.push(`- ${file.action}: ${file.name}${suffix}`);
		lines.push(`  from: ${file.sourcePath}`);
		lines.push(`  to:   ${file.targetPath}`);
		if (file.deleteLegacy) lines.push("  legacy delete: yes");
	}

	if (!report.deleteLegacy && !report.dryRun && (report.copied || report.overwritten)) {
		lines.push("", "Legacy files were left in place. Re-run with `--delete-legacy` after checking the migrated stacks if you want to remove them.");
	}

	return lines.join("\n");
}
