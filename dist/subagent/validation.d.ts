import { FINGERPRINT_PATTERN, LIMIT_NAMES, OPAQUE_ID_PATTERN, error, hasErrors, isFingerprint, isRecord, isSafeRelativePath, validateAccessEnforcement } from "@zihanw/pi-subagent-runtime";
import type { SubagentDiagnostic, SubagentPreparationRuntime } from "./types.ts";
export { FINGERPRINT_PATTERN, LIMIT_NAMES as SUBAGENT_LIMIT_NAMES, OPAQUE_ID_PATTERN, error, hasErrors, hasErrors as hasSubagentErrors, isFingerprint, isRecord, isSafeRelativePath, validateAccessEnforcement, };
export declare const NAMESPACE_PATTERN: RegExp;
export declare function validateAccessRequest(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateLimitRequest(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateLimitReceipt(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateBackendDescriptor(value: Record<string, unknown>, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validatePreparationRuntime(value: unknown, path: string, diagnostics: SubagentDiagnostic[], expectedFidelity?: SubagentPreparationRuntime["fidelity"]): void;
export declare function validateMediaReference(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateSelectedContext(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): SubagentDiagnostic[];
export declare function validateToolCatalog(value: readonly unknown[], diagnostics: SubagentDiagnostic[]): void;
/**
 * Host access-receipt validation. The portable runtime validator intentionally
 * checks less: the host additionally enforces mount uniqueness, access-level
 * consistency, and the isolation claims a receipt may make for its execution
 * boundary, because these cross-checks are the honesty terms of the host
 * contract (a shared-user boundary must never claim OS isolation).
 */
export declare function validateAccessReceipt(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateAccessCapabilities(value: Record<string, unknown>, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validatePreparedMessage(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateContextBudgetReceipt(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateUniqueStringArray(value: readonly unknown[], path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateDiagnosticArray(value: readonly unknown[], path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateUsage(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateModelReference(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateOpaqueId(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateNamespace(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function validateFingerprint(value: unknown, path: string, diagnostics: SubagentDiagnostic[]): void;
export declare function isIsoDate(value: unknown): boolean;
export declare function isPositiveInteger(value: unknown): value is number;
export declare function isNonNegativeInteger(value: unknown): value is number;
export declare function isNonNegativeFinite(value: unknown): value is number;
//# sourceMappingURL=validation.d.ts.map