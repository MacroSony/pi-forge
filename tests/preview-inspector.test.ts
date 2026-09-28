import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildPreview } from "../src/preview.ts";
import type { LoadedPromptStack, PromptCompileOptions } from "../src/types.ts";
import type { WebEditorPreviewSection } from "../src/web-editor/types.ts";
import {
	inspectionEntries,
	inspectionRows,
	isBatch,
	pairedRows,
	parameterExcerpt,
	rowMatches,
	textExcerpt,
	type InspectionBatch,
	type InspectionRow,
} from "../src/web-editor/client/preview-inspector.ts";

const defaultOptions: PromptCompileOptions = { cwd: "/test" };

function makeStackWithHistory(): LoadedPromptStack {
	return {
		stack: {
			schemaVersion: 2,
			type: "pi-forge.prompt-stack",
			id: "inspector-stack",
			items: [
				{ kind: "block", id: "sys-base", role: "system", content: "You are an expert system." },
				{ kind: "slot", id: "history-slot", slot: "chat-history" },
				{ kind: "block", id: "user-followup", role: "user", content: "Final prompt instructions." },
			],
		},
		filePath: "/test/inspector-stack.json",
		scope: "project",
		key: { scope: "project", id: "inspector-stack" },
		diagnostics: [],
	};
}

function makeContext(entries: unknown[]) {
	const chained = entries.map((entry: any, index: number) => {
		const id = entry.id ?? `entry-${index + 1}`;
		const parentId = entry.parentId ?? (index > 0 ? (entries[index - 1] as any).id ?? `entry-${index}` : null);
		return { ...entry, id, parentId };
	});
	const leafId = chained.length ? chained[chained.length - 1].id : null;
	return {
		sessionManager: {
			getLeafId: () => leafId,
			getEntries: () => chained,
			getBranch: (_fromId?: string) => chained,
		},
		getSystemPrompt: () => "Pi base system prompt",
		getSystemPromptOptions: () => defaultOptions,
		isProjectTrusted: () => true,
		model: {
			provider: "test-provider",
			id: "test-model",
			api: "test-api",
			compat: { supportsMidConvoSystemMessages: true },
		},
	} as unknown as ExtensionContext;
}

test("pure inspectionRows preserves original order, assigns 1-based positions, and never mutates input sections", () => {
	const sections: readonly WebEditorPreviewSection[] = Object.freeze([
		{
			id: "sec-sys",
			title: "System Section",
			role: "system",
			content: "System instruction content",
			chars: 25,
			approxTokens: 6,
		},
		{
			id: "sec-user",
			title: "User Prompt",
			role: "user",
			content: "Hello assistant",
			chars: 15,
			approxTokens: 4,
			inspection: {
				key: "insp-user-1",
				scope: "scope-main",
				parts: [{ key: "insp-user-1:part:0", kind: "text", text: "Hello assistant" }],
			},
		},
		{
			id: "sec-assistant",
			title: "Assistant Turn",
			role: "assistant",
			content: "Thinking and call",
			chars: 50,
			approxTokens: 12,
			inspection: {
				key: "insp-asst-1",
				scope: "scope-main",
				parts: [
					{ key: "insp-asst-1:part:0", kind: "thinking", text: "Planning file read" },
					{ key: "insp-asst-1:part:1", kind: "toolCall", toolName: "read", callId: "c1", text: '{"path":"src/index.ts"}' },
				],
			},
		},
		{
			id: "sec-res",
			title: "Tool Result",
			role: "toolResult",
			content: "export const ok = true;",
			chars: 24,
			approxTokens: 6,
			inspection: {
				key: "insp-res-1",
				scope: "scope-main",
				parts: [{ key: "insp-res-1:part:0", kind: "text", text: "export const ok = true;" }],
				toolResult: { callId: "c1", toolName: "read", isError: false },
			},
		},
	]);

	const snapshotBefore = JSON.stringify(sections);
	const rows = inspectionRows(sections);

	assert.equal(JSON.stringify(sections), snapshotBefore, "inspectionRows must never mutate input sections");
	assert.equal(rows.length, 5, "System(1) + User(1) + Asst(2 parts) + Result(1) = 5 rows");

	// Positions are sequential 1-based indices reflecting compilation projection
	assert.deepEqual(rows.map((r) => r.position), [1, 2, 3, 4, 5]);

	// Row 0: system
	assert.equal(rows[0].role, "system");
	assert.equal(rows[0].kind, "body");
	assert.equal(rows[0].text, "System instruction content");

	// Row 1: user
	assert.equal(rows[1].role, "user");
	assert.equal(rows[1].kind, "body");
	assert.equal(rows[1].text, "Hello assistant");

	// Row 2: assistant thinking part -> body
	assert.equal(rows[2].role, "assistant");
	assert.equal(rows[2].kind, "body");
	assert.equal(rows[2].partKind, "thinking");
	assert.equal(rows[2].owner, undefined);

	// Row 3: assistant toolCall part -> call
	assert.equal(rows[3].role, "assistant");
	assert.equal(rows[3].kind, "call");
	assert.equal(rows[3].partKind, "toolCall");
	assert.equal(rows[3].owner, "insp-asst-1");
	assert.equal(rows[3].callId, "c1");
	assert.equal(rows[3].pairKey, "insp-res-1");

	// Row 4: toolResult -> result
	assert.equal(rows[4].role, "toolResult");
	assert.equal(rows[4].kind, "result");
	assert.equal(rows[4].callId, "c1");
	assert.equal(rows[4].pairKey, rows[3].key);
	assert.equal(rows[4].owner, "insp-asst-1", "Paired result adopts call's owner");
	assert.equal(rows[4].argumentHint, "src/index.ts", "Argument hint extracted from call's JSON path");
});

test("pairing is strict: duplicate call IDs, missing IDs, cross-scope, inverted order, and toolname conflicts prevent pairing", () => {
	// Case 1: duplicate callId in the same scope (two calls sharing callId)
	const dupCallSections: WebEditorPreviewSection[] = [
		{
			id: "asst-dup",
			title: "Assistant",
			role: "assistant",
			content: "dup calls",
			chars: 20,
			approxTokens: 5,
			inspection: {
				key: "asst-dup",
				scope: "scope-dup",
				parts: [
					{ key: "call-1", kind: "toolCall", toolName: "read", callId: "dup-id", text: '{"path":"a.ts"}' },
					{ key: "call-2", kind: "toolCall", toolName: "read", callId: "dup-id", text: '{"path":"b.ts"}' },
				],
			},
		},
		{
			id: "res-dup",
			title: "Result",
			role: "toolResult",
			content: "res content",
			chars: 20,
			approxTokens: 5,
			inspection: {
				key: "res-dup-1",
				scope: "scope-dup",
				parts: [{ key: "res-dup-1:p0", kind: "text", text: "res" }],
				toolResult: { callId: "dup-id", toolName: "read" },
			},
		},
	];
	const dupRows = inspectionRows(dupCallSections);
	assert.equal(dupRows[0].pairKey, undefined, "Duplicate callId must not pair call 1");
	assert.equal(dupRows[1].pairKey, undefined, "Duplicate callId must not pair call 2");
	assert.equal(dupRows[2].pairKey, undefined, "Duplicate callId must not pair ambiguous result");

	// Case 2: duplicate results sharing the same callId
	const dupResultSections: WebEditorPreviewSection[] = [
		{
			id: "asst-single",
			title: "Assistant",
			role: "assistant",
			content: "call",
			chars: 20,
			approxTokens: 5,
			inspection: {
				key: "asst-single",
				scope: "scope-dup-res",
				parts: [{ key: "call-s", kind: "toolCall", toolName: "bash", callId: "c-single", text: "{}" }],
			},
		},
		{
			id: "res-dup-a",
			title: "Result A",
			role: "toolResult",
			content: "res A",
			chars: 10,
			approxTokens: 2,
			inspection: {
				key: "res-a",
				scope: "scope-dup-res",
				parts: [{ key: "res-a:p0", kind: "text", text: "res A" }],
				toolResult: { callId: "c-single", toolName: "bash" },
			},
		},
		{
			id: "res-dup-b",
			title: "Result B",
			role: "toolResult",
			content: "res B",
			chars: 10,
			approxTokens: 2,
			inspection: {
				key: "res-b",
				scope: "scope-dup-res",
				parts: [{ key: "res-b:p0", kind: "text", text: "res B" }],
				toolResult: { callId: "c-single", toolName: "bash" },
			},
		},
	];
	const dupResRows = inspectionRows(dupResultSections);
	assert.equal(dupResRows[0].pairKey, undefined, "Call must not pair when multiple results share callId");
	assert.equal(dupResRows[1].pairKey, undefined);
	assert.equal(dupResRows[2].pairKey, undefined);

	// Case 3: cross-scope (same callId, different scopes)
	const crossScopeSections: WebEditorPreviewSection[] = [
		{
			id: "asst-scope1",
			title: "Assistant 1",
			role: "assistant",
			content: "call",
			chars: 20,
			approxTokens: 5,
			inspection: {
				key: "asst-scope1",
				scope: "scope-ALPHA",
				parts: [{ key: "call-s1", kind: "toolCall", toolName: "read", callId: "shared-c", text: "{}" }],
			},
		},
		{
			id: "res-scope2",
			title: "Result 2",
			role: "toolResult",
			content: "res",
			chars: 10,
			approxTokens: 2,
			inspection: {
				key: "res-s2",
				scope: "scope-BETA",
				parts: [{ key: "res-s2:p0", kind: "text", text: "res" }],
				toolResult: { callId: "shared-c", toolName: "read" },
			},
		},
	];
	const crossScopeRows = inspectionRows(crossScopeSections);
	assert.equal(crossScopeRows[0].pairKey, undefined, "Cross-scope call must never pair");
	assert.equal(crossScopeRows[1].pairKey, undefined, "Cross-scope result must never pair");

	// Case 4: inverted position (result arrives before call)
	const invertedSections: WebEditorPreviewSection[] = [
		{
			id: "res-first",
			title: "Result First",
			role: "toolResult",
			content: "res before call",
			chars: 20,
			approxTokens: 5,
			inspection: {
				key: "res-first",
				scope: "scope-inv",
				parts: [{ key: "res-first:p0", kind: "text", text: "res" }],
				toolResult: { callId: "c-inv", toolName: "read" },
			},
		},
		{
			id: "call-later",
			title: "Assistant Later",
			role: "assistant",
			content: "call",
			chars: 20,
			approxTokens: 5,
			inspection: {
				key: "asst-inv",
				scope: "scope-inv",
				parts: [{ key: "call-later-part", kind: "toolCall", toolName: "read", callId: "c-inv", text: "{}" }],
			},
		},
	];
	const invertedRows = inspectionRows(invertedSections);
	assert.equal(invertedRows[0].pairKey, undefined, "Result preceding call must not pair");
	assert.equal(invertedRows[1].pairKey, undefined, "Call following result must not pair");

	// Case 5: explicit toolName conflict
	const nameConflictSections: WebEditorPreviewSection[] = [
		{
			id: "asst-conflict",
			title: "Assistant",
			role: "assistant",
			content: "call read",
			chars: 20,
			approxTokens: 5,
			inspection: {
				key: "asst-conf",
				scope: "scope-conf",
				parts: [{ key: "call-conf", kind: "toolCall", toolName: "read", callId: "c-conf", text: "{}" }],
			},
		},
		{
			id: "res-conflict",
			title: "Result",
			role: "toolResult",
			content: "res bash",
			chars: 10,
			approxTokens: 2,
			inspection: {
				key: "res-conf",
				scope: "scope-conf",
				parts: [{ key: "res-conf:p0", kind: "text", text: "res" }],
				toolResult: { callId: "c-conf", toolName: "bash" },
			},
		},
	];
	const conflictRows = inspectionRows(nameConflictSections);
	assert.equal(conflictRows[0].pairKey, undefined, "Conflicting toolName must not pair");
	assert.equal(conflictRows[1].pairKey, undefined, "Conflicting toolName must not pair");

	// Case 6: missing callId
	const missingIdSections: WebEditorPreviewSection[] = [
		{
			id: "asst-noid",
			title: "Assistant",
			role: "assistant",
			content: "call no id",
			chars: 20,
			approxTokens: 5,
			inspection: {
				key: "asst-noid",
				scope: "scope-noid",
				parts: [{ key: "call-noid", kind: "toolCall", toolName: "read", text: "{}" }],
			},
		},
		{
			id: "res-noid",
			title: "Result",
			role: "toolResult",
			content: "res",
			chars: 10,
			approxTokens: 2,
			inspection: {
				key: "res-noid",
				scope: "scope-noid",
				parts: [{ key: "res-noid:p0", kind: "text", text: "res" }],
				toolResult: { toolName: "read" },
			},
		},
	];
	const noIdRows = inspectionRows(missingIdSections);
	assert.equal(noIdRows[0].pairKey, undefined, "Missing callId must not pair");
	assert.equal(noIdRows[1].pairKey, undefined, "Missing callId must not pair");
});

test("argumentHint boundary handling: parses path safely, ignores non-path JSON, ignores invalid JSON, skips >65536 chars", () => {
	const sections: WebEditorPreviewSection[] = [
		{
			id: "asst-hint",
			title: "Assistant",
			role: "assistant",
			content: "various calls",
			chars: 100,
			approxTokens: 25,
			inspection: {
				key: "asst-hint-key",
				scope: "scope-hint",
				parts: [
					// Valid with path
					{ key: "c1", kind: "toolCall", toolName: "read", callId: "c1", text: '{"path":"src/foo/bar.ts"}' },
					// Valid without path
					{ key: "c2", kind: "toolCall", toolName: "bash", callId: "c2", text: '{"command":"ls -la"}' },
					// Non-string path
					{ key: "c3", kind: "toolCall", toolName: "read", callId: "c3", text: '{"path":12345}' },
					// Invalid JSON
					{ key: "c4", kind: "toolCall", toolName: "read", callId: "c4", text: 'not valid json {"path":"fail.ts"}' },
					// Oversized (>65536 chars)
					{ key: "c5", kind: "toolCall", toolName: "read", callId: "c5", text: `{"path":"huge.ts","pad":"${"x".repeat(70000)}"}` },
				],
			},
		},
		{
			id: "r1",
			title: "R1",
			role: "toolResult",
			content: "ok1",
			chars: 3,
			approxTokens: 1,
			inspection: { key: "r1", scope: "scope-hint", parts: [{ key: "r1:p0", kind: "text", text: "ok1" }], toolResult: { callId: "c1" } },
		},
		{
			id: "r2",
			title: "R2",
			role: "toolResult",
			content: "ok2",
			chars: 3,
			approxTokens: 1,
			inspection: { key: "r2", scope: "scope-hint", parts: [{ key: "r2:p0", kind: "text", text: "ok2" }], toolResult: { callId: "c2" } },
		},
		{
			id: "r3",
			title: "R3",
			role: "toolResult",
			content: "ok3",
			chars: 3,
			approxTokens: 1,
			inspection: { key: "r3", scope: "scope-hint", parts: [{ key: "r3:p0", kind: "text", text: "ok3" }], toolResult: { callId: "c3" } },
		},
		{
			id: "r4",
			title: "R4",
			role: "toolResult",
			content: "ok4",
			chars: 3,
			approxTokens: 1,
			inspection: { key: "r4", scope: "scope-hint", parts: [{ key: "r4:p0", kind: "text", text: "ok4" }], toolResult: { callId: "c4" } },
		},
		{
			id: "r5",
			title: "R5",
			role: "toolResult",
			content: "ok5",
			chars: 3,
			approxTokens: 1,
			inspection: { key: "r5", scope: "scope-hint", parts: [{ key: "r5:p0", kind: "text", text: "ok5" }], toolResult: { callId: "c5" } },
		},
	];

	const rows = inspectionRows(sections);
	const resultMap = new Map(rows.filter((r) => r.kind === "result").map((r) => [r.callId, r]));

	assert.equal(resultMap.get("c1")?.argumentHint, "src/foo/bar.ts", "String path extracted");
	assert.equal(resultMap.get("c2")?.argumentHint, undefined, "Non-path JSON yields undefined hint");
	assert.equal(resultMap.get("c3")?.argumentHint, undefined, "Numeric path yields undefined hint");
	assert.equal(resultMap.get("c4")?.argumentHint, undefined, "Malformed JSON does not throw, yields undefined hint");
	assert.equal(resultMap.get("c5")?.argumentHint, undefined, ">65536 text skips JSON.parse safely");
});

test("unknown role and custom message are preserved truthfully without normalization to 'message'", () => {
	const sections: WebEditorPreviewSection[] = [
		{
			id: "sec-eval",
			title: "Evaluator Audit Turn",
			role: "evaluator-audit",
			content: "Score: 0.98",
			chars: 11,
			approxTokens: 3,
			inspection: {
				key: "insp-eval-1",
				scope: "scope-eval",
				parts: [{ key: "insp-eval-1:p0", kind: "text", text: "Score: 0.98" }],
			},
		},
		{
			id: "sec-moderator",
			title: "Moderator Review",
			role: "moderator",
			content: "Content flagged: false",
			chars: 22,
			approxTokens: 5,
		},
	];

	const rows = inspectionRows(sections);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].role, "evaluator-audit", "Custom evaluator-audit role preserved");
	assert.equal(rows[0].kind, "body");
	assert.equal(rows[1].role, "moderator", "Custom moderator role preserved");
	assert.equal(rows[1].kind, "body");
});

test("inspectionEntries groups contiguous tools of same owner into batch; body, system, otherowner, and orphan results break batch", () => {
	const sampleSection: WebEditorPreviewSection = {
		id: "sec",
		title: "Section",
		content: "content",
		chars: 10,
		approxTokens: 2,
	};

	const rows: readonly InspectionRow[] = Object.freeze([
		// 1. System barrier
		{ key: "r1", section: sampleSection, body: sampleSection, kind: "body", role: "system", scope: "s1", position: 1, text: "sys" },
		// 2. User barrier
		{ key: "r2", section: sampleSection, body: sampleSection, kind: "body", role: "user", scope: "s1", position: 2, text: "user" },
		// 3. Batch 1: Assistant A tools (calls and paired results)
		{ key: "r3", section: sampleSection, body: sampleSection, kind: "call", role: "assistant", scope: "s1", owner: "asst-A", position: 3, text: "{}" },
		{ key: "r4", section: sampleSection, body: sampleSection, kind: "call", role: "assistant", scope: "s1", owner: "asst-A", position: 4, text: "{}" },
		{ key: "r5", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s1", owner: "asst-A", position: 5, text: "res4" },
		{ key: "r6", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s1", owner: "asst-A", position: 6, text: "res3" },
		// 4. Orphan result barrier (unpaired, owner === undefined)
		{ key: "r7", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s1", owner: undefined, position: 7, text: "orphan" },
		// 5. Batch 2: Assistant B tools
		{ key: "r8", section: sampleSection, body: sampleSection, kind: "call", role: "assistant", scope: "s1", owner: "asst-B", position: 8, text: "{}" },
		{ key: "r9", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s1", owner: "asst-B", position: 9, text: "res8" },
		// 6. Immediate Assistant C tools without intermediate body (otherowner barrier)
		{ key: "r10", section: sampleSection, body: sampleSection, kind: "call", role: "assistant", scope: "s1", owner: "asst-C", position: 10, text: "{}" },
		// 7. Body barrier
		{ key: "r11", section: sampleSection, body: sampleSection, kind: "body", role: "assistant", scope: "s1", owner: undefined, position: 11, text: "Done!" },
	]);

	const entries = inspectionEntries(rows);
	assert.equal(entries.length, 7, "system + user + batch1 + orphan + batch2 + batch3 + body = 7 entries");

	// Entry 0: System (row)
	assert.ok(!isBatch(entries[0]));
	assert.equal((entries[0] as InspectionRow).key, "r1");

	// Entry 1: User (row)
	assert.ok(!isBatch(entries[1]));
	assert.equal((entries[1] as InspectionRow).key, "r2");

	// Entry 2: Batch 1 (asst-A with 4 tool items)
	assert.ok(isBatch(entries[2]));
	const b1 = entries[2] as InspectionBatch;
	assert.equal(b1.owner, "asst-A");
	assert.equal(b1.rows.length, 4);
	assert.deepEqual(b1.rows.map((r) => r.key), ["r3", "r4", "r5", "r6"]);

	// Entry 3: Orphan result (breaks batch because owner is undefined)
	assert.ok(!isBatch(entries[3]));
	assert.equal((entries[3] as InspectionRow).key, "r7");

	// Entry 4: Batch 2 (asst-B with 2 tool items)
	assert.ok(isBatch(entries[4]));
	const b2 = entries[4] as InspectionBatch;
	assert.equal(b2.owner, "asst-B");
	assert.equal(b2.rows.length, 2);
	assert.deepEqual(b2.rows.map((r) => r.key), ["r8", "r9"]);

	// Entry 5: Batch 3 (asst-C immediately following asst-B separated by otherowner)
	assert.ok(isBatch(entries[5]));
	const b3 = entries[5] as InspectionBatch;
	assert.equal(b3.owner, "asst-C");
	assert.equal(b3.rows.length, 1);
	assert.equal(b3.rows[0].key, "r10");

	// Entry 6: Body text (row)
	assert.ok(!isBatch(entries[6]));
	assert.equal((entries[6] as InspectionRow).key, "r11");
});

test("pairedRows hoists paired results immediately after their calls in continuous interval, and respects orphan result barriers", () => {
	const sampleSection: WebEditorPreviewSection = {
		id: "sec",
		title: "Section",
		content: "content",
		chars: 10,
		approxTokens: 2,
	};

	// Sequence:
	// Call 1 (paired with Res 1)
	// Call 2 (paired with Res 2)
	// Res 2 (reversed execution arrival)
	// Res 1
	// Orphan Result (unpaired) -> BARRIER
	// Call 3 (paired with Res 3)
	// Res 3
	const rows: readonly InspectionRow[] = Object.freeze([
		{ key: "call-1", section: sampleSection, body: sampleSection, kind: "call", role: "assistant", scope: "s", owner: "A", position: 1, text: "c1", pairKey: "res-1" },
		{ key: "call-2", section: sampleSection, body: sampleSection, kind: "call", role: "assistant", scope: "s", owner: "A", position: 2, text: "c2", pairKey: "res-2" },
		{ key: "res-2", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s", owner: "A", position: 3, text: "r2", pairKey: "call-2" },
		{ key: "res-1", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s", owner: "A", position: 4, text: "r1", pairKey: "call-1" },
		{ key: "orphan-res", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s", owner: undefined, position: 5, text: "orphan" },
		{ key: "call-3", section: sampleSection, body: sampleSection, kind: "call", role: "assistant", scope: "s", owner: "B", position: 6, text: "c3", pairKey: "res-3" },
		{ key: "res-3", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s", owner: "B", position: 7, text: "r3", pairKey: "call-3" },
	]);

	const paired = pairedRows(rows);

	// In paired order:
	// Interval 1: call-1, res-1, call-2, res-2
	// Barrier: orphan-res
	// Interval 2: call-3, res-3
	assert.deepEqual(
		paired.map((r) => r.key),
		["call-1", "res-1", "call-2", "res-2", "orphan-res", "call-3", "res-3"],
		"Paired mode must put matching results right after calls and keep orphan result at its barrier position",
	);

	// Test barrier isolation: Call before orphan result CANNOT pair with result after orphan result
	const leakCheckRows: readonly InspectionRow[] = Object.freeze([
		{ key: "call-early", section: sampleSection, body: sampleSection, kind: "call", role: "assistant", scope: "s", owner: "A", position: 1, text: "c", pairKey: "res-late" },
		{ key: "orphan-barrier", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s", owner: undefined, position: 2, text: "bar" },
		{ key: "res-late", section: sampleSection, body: sampleSection, kind: "result", role: "toolResult", scope: "s", owner: "A", position: 3, text: "r", pairKey: "call-early" },
	]);
	const leakPaired = pairedRows(leakCheckRows);
	// When orphan-barrier is encountered, flush() happens: call-early is flushed without res-late.
	// Then orphan-barrier is pushed.
	// Then res-late is in interval 2.
	assert.deepEqual(
		leakPaired.map((r) => r.key),
		["call-early", "orphan-barrier", "res-late"],
		"Results cannot be hoisted across an orphan result barrier",
	);
});

test("parameterExcerpt preserves large integers, duplicate keys, spaces inside strings, escapes, and truncates cleanly", () => {
	// 1. Large integers (must never be parsed to double precision or exponent notation)
	const hugeInt = '{"id": 92233720368547758071234567890123456789}';
	assert.equal(parameterExcerpt(hugeInt), hugeInt);

	// 2. Duplicate keys (must never be dropped by JSON parser)
	const dupKeys = '{"target": "first", "target": "second"}';
	assert.equal(parameterExcerpt(dupKeys), dupKeys);

	// 3. Consecutive spaces inside strings preserved; outside strings normalized
	const spacesInput = '{\n  "query" :   "SELECT *    FROM   users WHERE   id = 1"  }';
	const spacesOutput = parameterExcerpt(spacesInput);
	assert.ok(spacesOutput.includes('"SELECT *    FROM   users WHERE   id = 1"'), "Spaces inside quotes must be strictly preserved");
	assert.ok(!spacesOutput.includes("  \"query\""), "Spaces outside quotes must be collapsed");

	// 4. Escaped quotes and backslashes inside strings
	const escaped = '{"msg": "Quote \\" and backslash \\\\ test"}';
	assert.equal(parameterExcerpt(escaped), escaped);

	// 5. Truncation at 220 characters with ellipsis
	const longArg = JSON.stringify({ longText: "A".repeat(300) });
	const excerpt = parameterExcerpt(longArg);
	assert.equal(excerpt.length, 221, "220 chars + 1 ellipsis character");
	assert.ok(excerpt.endsWith("…"), "Truncated output must end with ellipsis");

	// 6. Long input exceeding 2048 chars bounded correctly
	const hugePayload = "x".repeat(3000);
	const hugeExcerpt = parameterExcerpt(hugePayload);
	assert.ok(hugeExcerpt.endsWith("…"));
	assert.equal(hugeExcerpt.length, 221);
});

test("textExcerpt collapses whitespace and bounds length to 220 chars", () => {
	const raw = "Line 1\n\n   Line 2\t\t\tLine 3";
	assert.equal(textExcerpt(raw), "Line 1 Line 2 Line 3");

	const longText = "word ".repeat(100);
	const excerpt = textExcerpt(longText);
	assert.equal(excerpt.length, 221);
	assert.ok(excerpt.endsWith("…"));
});

test("rowMatches performs case-insensitive lexical matching across text, role, toolName, and metadata", () => {
	const sampleSection: WebEditorPreviewSection = {
		id: "sec-test",
		title: "Session History #2",
		content: "function run() {}",
		chars: 17,
		approxTokens: 5,
	};
	const row: InspectionRow = {
		key: "k1",
		section: sampleSection,
		body: sampleSection,
		kind: "call",
		role: "assistant",
		partKind: "toolCall",
		scope: "chat-history:hist",
		owner: "asst-msg-1",
		callId: "call_read_99",
		toolName: "read",
		argumentHint: "src/server/handler.ts",
		text: '{"path": "src/server/handler.ts", "limit": 200}',
		position: 4,
	};

	// Empty query matches all
	assert.equal(rowMatches(row, ""), true);
	assert.equal(rowMatches(row, "   "), true);

	// Match by toolName
	assert.equal(rowMatches(row, "READ"), true);

	// Match by callId
	assert.equal(rowMatches(row, "call_read_99"), true);

	// Match by argumentHint
	assert.equal(rowMatches(row, "handler.ts"), true);

	// Match by text snippet
	assert.equal(rowMatches(row, "limit"), true);

	// Match by scope
	assert.equal(rowMatches(row, "chat-history"), true);

	// Match by section title
	assert.equal(rowMatches(row, "session history"), true);

	// Non-matching query
	assert.equal(rowMatches(row, "nonexistent-query-string"), false);
});

test("end-to-end pipeline: real AgentMessage through buildPreview API down to inspectionRows, inspectionEntries, and pairedRows", () => {
	// Construct real Pi AgentMessage sequence:
	// 1. User query
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: "Please review tests and check build status." }],
		timestamp: 1000,
	};

	// 2. Assistant turn with thinking and two tool calls
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "I will check the test files and run the test suite." },
			{ type: "thinking", thinking: "First read tests/app.test.ts, then invoke bash." },
			{ type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "tests/app.test.ts", limit: 50 } },
			{ type: "toolCall", id: "call_bash_2", name: "bash", arguments: { command: "npm test" } },
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 2000,
	};

	// 3. Reversed results: Call 2 (bash) fails and arrives first; Call 1 (read) arrives second
	const bashResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_bash_2",
		toolName: "bash",
		isError: true,
		content: [{ type: "text", text: "Exit code 1: SyntaxError in tests/app.test.ts" }],
		timestamp: 3000,
	};

	const readResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_read_1",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "import { test } from 'node:test';\n// test file" }],
		timestamp: 3100,
	};

	// 4. Follow-up User message (acting as conversation barrier)
	const userFollowup: UserMessage = {
		role: "user",
		content: [{ type: "text", text: "Could you fix the syntax error?" }],
		timestamp: 4000,
	};

	const entries = [
		{ type: "message", id: "msg-user-1", message: userMessage },
		{ type: "message", id: "msg-asst-1", message: assistantMessage },
		{ type: "message", id: "msg-res-bash", message: bashResult },
		{ type: "message", id: "msg-res-read", message: readResult },
		{ type: "message", id: "msg-user-2", message: userFollowup },
	];

	const ctx = makeContext(entries);
	const stack = makeStackWithHistory();

	// Invoke real buildPreview API
	const previewResult = buildPreview(ctx, stack, defaultOptions);
	assert.ok(previewResult.preview.messages.length >= 6);

	// Feed real sections into inspectionRows
	const rows = inspectionRows(previewResult.preview.messages);

	// Locate rows
	const callReadRow = rows.find((r) => r.callId === "call_read_1" && r.kind === "call");
	const callBashRow = rows.find((r) => r.callId === "call_bash_2" && r.kind === "call");
	const resBashRow = rows.find((r) => r.callId === "call_bash_2" && r.kind === "result");
	const resReadRow = rows.find((r) => r.callId === "call_read_1" && r.kind === "result");

	assert.ok(callReadRow && callBashRow && resBashRow && resReadRow);

	// Verify pairing through real buildPreview metadata
	assert.equal(callReadRow.pairKey, resReadRow.key);
	assert.equal(resReadRow.pairKey, callReadRow.key);
	assert.equal(resReadRow.argumentHint, "tests/app.test.ts", "Real JSON args yielded argumentHint");

	assert.equal(callBashRow.pairKey, resBashRow.key);
	assert.equal(resBashRow.pairKey, callBashRow.key);
	assert.equal(resBashRow.isError, true, "isError flag preserved");

	// In original compiled projection order, bash result precedes read result
	assert.ok(resBashRow.position < resReadRow.position, "Bash result arrived before Read result");

	// Group into entries
	const entriesList = inspectionEntries(rows);

	// Find the tool batch
	const toolBatch = entriesList.find((e): e is InspectionBatch => isBatch(e) && e.rows.some((r) => r.callId === "call_read_1"));
	assert.ok(toolBatch, "Tool calls and results must form an InspectionBatch");
	assert.equal(toolBatch.rows.length, 4, "Batch contains callRead, callBash, resBash, resRead");

	// Verify user message barrier isolates the batch
	const user2Row = rows.find((r) => r.text.includes("Could you fix the syntax error?"));
	assert.ok(user2Row);
	assert.ok(
		entriesList.some((e) => !isBatch(e) && (e as InspectionRow).key === user2Row.key),
		"User followup message is outside the tool batch",
	);

	// Switch to pairedRows
	const batchPaired = pairedRows(toolBatch.rows);
	assert.deepEqual(
		batchPaired.map((r) => r.key),
		[callReadRow.key, resReadRow.key, callBashRow.key, resBashRow.key],
		"pairedRows successfully restored causal pairing: read call -> read result, bash call -> bash result",
	);
});
