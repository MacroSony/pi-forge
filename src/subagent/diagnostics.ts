import type { SubagentDiagnostic } from "./types.ts";
import { hasErrors } from "./validation.ts";

export function hasSubagentErrors(diagnostics: readonly SubagentDiagnostic[]): boolean {
	return hasErrors(diagnostics);
}
