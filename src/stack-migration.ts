import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { legacyPromptStacksDir, promptStacksDir } from "./storage.ts";

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

export function migrateLegacyPromptStacks(cwd: string, options: PromptStackMigrationOptions = {}): PromptStackMigrationReport {
	const sourceDir = legacyPromptStacksDir(cwd);
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

	if (!existsSync(sourceDir)) return report;

	let entries: string[];
	try {
		entries = readdirSync(sourceDir).filter((name) => name.endsWith(".json")).sort();
	} catch (error) {
		report.files.push({
			name: "(legacy directory)",
			sourcePath: sourceDir,
			targetPath: targetDir,
			action: "error",
			reason: error instanceof Error ? error.message : String(error),
			deleteLegacy: false,
		});
		report.errors++;
		return report;
	}

	for (const name of entries) {
		const sourcePath = join(sourceDir, name);
		const targetPath = join(targetDir, name);
		const targetExists = existsSync(targetPath);
		if (targetExists && !report.overwrite) {
			report.files.push({
				name,
				sourcePath,
				targetPath,
				action: "skip",
				reason: "target already exists",
				deleteLegacy: false,
			});
			report.skipped++;
			continue;
		}

		const action = targetExists ? "overwrite" : "copy";
		try {
			if (!report.dryRun) {
				mkdirSync(dirname(targetPath), { recursive: true });
				copyFileSync(sourcePath, targetPath);
				if (report.deleteLegacy) {
					unlinkSync(sourcePath);
					report.deletedLegacy++;
				}
			}
			if (action === "overwrite") report.overwritten++;
			else report.copied++;
			report.files.push({
				name,
				sourcePath,
				targetPath,
				action,
				deleteLegacy: report.deleteLegacy,
			});
		} catch (error) {
			report.files.push({
				name,
				sourcePath,
				targetPath,
				action: "error",
				reason: error instanceof Error ? error.message : String(error),
				deleteLegacy: false,
			});
			report.errors++;
		}
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
