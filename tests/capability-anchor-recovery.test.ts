import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityAgentHarness } from "./helpers/capability-agent-harness.ts";
import { createCapabilitySnapshot, type CapabilityEvent } from "../src/capability-events.ts";
import { CAPABILITY_DELIVERY_TYPE, CAPABILITY_EVENT_ENTRY } from "../src/capability-protocol.ts";
import { readCapabilitySession } from "../src/session-adapter.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
const { SessionManager, initTheme } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
initTheme();

function activation(eventId: string): CapabilityEvent {
	return { schemaVersion: 1, eventId, actor: "user", op: "activate", createdAt: 1,
		snapshot: createCapabilitySnapshot({ activationId: `activation-${eventId}`, source: { kind: "manual" }, content: `RULE-${eventId}`, tools: { add: [], remove: [] } }) };
}
function read(manager: ReturnType<typeof SessionManager.inMemory>) {
	return readCapabilitySession({ sessionManager: manager } as unknown as ExtensionContext);
}
function anchor(manager: ReturnType<typeof SessionManager.inMemory>, eventId: string) {
	manager.appendCustomEntry(CAPABILITY_DELIVERY_TYPE, { schemaVersion: 1, throughEventId: eventId });
}

test("session adapter rejects malformed, unknown, future and reversed plain metadata cursors", () => {
	for (const kind of ["schema", "unknown", "future", "reversed"] as const) {
		const manager = SessionManager.inMemory("/isolated");
		manager.appendCustomEntry(CAPABILITY_EVENT_ENTRY, activation("one"));
		if (kind === "schema") manager.appendCustomEntry(CAPABILITY_DELIVERY_TYPE, { schemaVersion: 9, throughEventId: "one" });
		if (kind === "unknown" || kind === "future") anchor(manager, "two");
		if (kind === "future" || kind === "reversed") manager.appendCustomEntry(CAPABILITY_EVENT_ENTRY, activation("two"));
		if (kind === "reversed") { anchor(manager, "two"); anchor(manager, "one"); }
		assert.throws(() => read(manager), /schemaVersion|unknown or future|out-of-order/, kind);
	}
});

test("legacy carrier coverage is read without rewriting entries or duplicating new anchors", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-legacy-anchor-"));
	const manager = SessionManager.inMemory(cwd);
	manager.appendCustomEntry(CAPABILITY_EVENT_ENTRY, activation("legacy"));
	manager.appendCustomMessageEntry(CAPABILITY_DELIVERY_TYPE, "Forge instruction state changed. Use /capability status to inspect it.", false,
		{ schemaVersion: 1, throughEventId: "legacy" });
	const original = JSON.stringify(manager.getBranch());
	assert.equal(read(manager).lastAnchoredIndex, 0);
	assert.equal(JSON.stringify(manager.getBranch()), original);
	const h = await createCapabilityAgentHarness({ cwd, sessionManager: manager, native: true, responses: ["LEGACY_CONTINUES"] });
	try {
		await h.prompt("Continue with the old recorded rule");
		assert.equal(h.streamContexts.length, 1);
		assert.equal(manager.getBranch().filter(e => e.type === "custom" && e.customType === CAPABILITY_DELIVERY_TYPE).length, 0);
		assert.ok(h.streamContexts[0]!.messages.some(m => m.role === "system" && JSON.stringify(m.sections ?? {}).includes("RULE-legacy")));
		assert.ok(manager.getBranch().some(e => e.type === "custom_message" && e.content === "Forge instruction state changed. Use /capability status to inspect it."));
		assert.equal(h.fetchAttempts, 0);
	} finally { await h.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test("compaction checkpoint covers an unanchored event without backfilling historical anchors", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-checkpoint-anchor-"));
	const manager = SessionManager.inMemory(cwd);
	manager.appendMessage({ role: "system", content: "BASE", timestamp: 0 });
	const kept = manager.appendMessage({ role: "user", content: "HISTORICAL_TASK", timestamp: 1 });
	manager.appendCustomEntry(CAPABILITY_EVENT_ENTRY, activation("checkpoint"));
	manager.appendCompaction("HISTORICAL_SUMMARY", kept, 100);
	const h = await createCapabilityAgentHarness({ cwd, sessionManager: manager, native: true, responses: ["CONTINUE"] });
	try {
		await h.prompt("New postcompact request");
		assert.equal(h.streamContexts.length, 1);
		assert.equal(manager.getBranch().filter(e => e.type === "custom" && e.customType === CAPABILITY_DELIVERY_TYPE).length, 0);
		assert.equal(h.streamContexts[0]!.messages.filter(m => m.role === "system" && JSON.stringify(m.sections ?? {}).includes("RULE-checkpoint")).length, 1);
		assert.equal(h.fetchAttempts, 0);
	} finally { await h.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test("agent_end defers a pending anchor after an aborted response retains a partial tool call", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "forge-unfinished-anchor-"));
	// A scripted interrupted response preserves a partial call; use real SDK abort-result handling.
	const h = await createCapabilityAgentHarness({ cwd, native: true });
	try {
		h.setResponses([async () => {
			await h.prompt("/capability add FINAL_UNRESOLVED_RULE");
			return fauxAssistantMessage([fauxToolCall("fake_read", {}, { id: "unfinished" })], { stopReason: "aborted" });
		}]);
		await h.prompt("Stop at the tool call boundary");
		assert.equal(h.streamContexts.length, 1);
		assert.equal(h.toolExecutions.length, 0);
		assert.equal(h.manager.getBranch().filter(e => e.type === "custom" && e.customType === CAPABILITY_DELIVERY_TYPE).length, 0);
		h.setResponses(["NEW_USER_RECOVERY"]);
		await h.prompt("A new user turn recovers without permanent orphan blocking");
		assert.equal(h.streamContexts.length, 2);
		assert.equal(h.manager.getBranch().filter(e => e.type === "custom" && e.customType === CAPABILITY_DELIVERY_TYPE).length, 1);
		assert.equal(h.fetchAttempts, 0);
	} finally { await h.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
