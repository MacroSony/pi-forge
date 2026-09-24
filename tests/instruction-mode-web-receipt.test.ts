import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serializeInstructionMode, type InstructionMode } from "../src/codecs/instruction-mode.ts";
import { instructionModeOperation } from "../src/instruction-web-host.ts";
import { instructionModesDir, readInstructionModesScoped } from "../src/repositories/instruction-mode.ts";

function createMode(id: string, content: string): InstructionMode {
	return { schemaVersion: 1, type: "pi-forge.instruction-mode", id, content, tools: { add: [], remove: [] } };
}

test("instruction mode writes return the canonical receipt for the exact submitted snapshot", () => {
	const base = mkdtempSync(join(tmpdir(), "pi-forge-mode-receipt-"));
	const cwd = join(base, "project");
	mkdirSync(instructionModesDir(cwd), { recursive: true });
	const ctx = { cwd, isProjectTrusted: () => true } as any;
	const runtime = {
		readInstructionModes: () => readInstructionModesScoped(cwd, join(base, "global")),
		getStacks: () => [],
	};
	try {
		const first = createMode("review", "first");
		const created = instructionModeOperation(ctx, runtime, "create", undefined, { scope: "project", mode: first });
		assert.equal(created.ok, true);
		if (!created.ok) return;
		const expectedFirst = createHash("sha256").update(serializeInstructionMode(first)).digest("hex");
		assert.equal((created as { sourceRevision?: string }).sourceRevision, expectedFirst);

		const stale = instructionModeOperation(ctx, runtime, "save", "project:review", {
			mode: createMode("review", "stale"), expectedSourceRevision: "0".repeat(64),
		});
		assert.equal(stale.ok, false);
		if (stale.ok) return;
		assert.equal(stale.status, 409);

		const second = createMode("review", "second");
		const saved = instructionModeOperation(ctx, runtime, "save", "project:review", {
			mode: second, expectedSourceRevision: expectedFirst,
		});
		assert.equal(saved.ok, true);
		if (!saved.ok) return;
		assert.equal((saved as { sourceRevision?: string }).sourceRevision, createHash("sha256").update(serializeInstructionMode(second)).digest("hex"));
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
