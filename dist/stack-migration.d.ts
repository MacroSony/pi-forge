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
export declare function migrateLegacyPromptStacks(cwd: string, options?: PromptStackMigrationOptions): PromptStackMigrationReport;
export declare function renderMigrationReport(report: PromptStackMigrationReport): string;
//# sourceMappingURL=stack-migration.d.ts.map