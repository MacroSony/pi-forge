import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serializeCapability, type Capability } from "../src/codecs/capability.ts";
import { capabilityOperation } from "../src/capability-web-host.ts";
import { capabilitiesDir, readCapabilitiesScoped } from "../src/repositories/capability.ts";

function createMode(id: string, content: string): Capability {
	return { schemaVersion: 1, type: "pi-forge.capability", id, content, tools: { add: [], remove: [] } };
}

test("instruction capability writes return the canonical receipt for the exact submitted snapshot", () => {
	const base = mkdtempSync(join(tmpdir(), "pi-forge-capability-receipt-"));
	const cwd = join(base, "project");
	mkdirSync(capabilitiesDir(cwd), { recursive: true });
	const ctx = { cwd, isProjectTrusted: () => true } as any;
	const runtime = {
		readCapabilities: () => readCapabilitiesScoped(cwd, join(base, "global")),
		getStacks: () => [],
	};
	try {
		const first = createMode("review", "first");
		const created = capabilityOperation(ctx, runtime, "create", undefined, { scope: "project", capability: first });
		assert.equal(created.ok, true);
		if (!created.ok) return;
		const expectedFirst = createHash("sha256").update(serializeCapability(first)).digest("hex");
		assert.equal((created as { sourceRevision?: string }).sourceRevision, expectedFirst);

		const stale = capabilityOperation(ctx, runtime, "save", "project:review", {
			capability: createMode("review", "stale"), expectedSourceRevision: "0".repeat(64),
		});
		assert.equal(stale.ok, false);
		if (stale.ok) return;
		assert.equal(stale.status, 409);

		const second = createMode("review", "second");
		const saved = capabilityOperation(ctx, runtime, "save", "project:review", {
			capability: second, expectedSourceRevision: expectedFirst,
		});
		assert.equal(saved.ok, true);
		if (!saved.ok) return;
		assert.equal((saved as { sourceRevision?: string }).sourceRevision, createHash("sha256").update(serializeCapability(second)).digest("hex"));
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
