import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	appendProtectedTask,
	compileProtectedTaskMessages,
	computeSpikeToolPolicy,
	parseSpikeArgs,
	protectedTaskPreserved,
} from "../scripts/subagent-sdk-spike-lib.ts";
import { createPromptVariableStore } from "../src/compiler.ts";
import type { LoadedPromptStack } from "../src/types.ts";

function stack(overrides: Partial<LoadedPromptStack["stack"]> = {}): LoadedPromptStack {
	return {
		filePath: "/tmp/restrictive.json",
		diagnostics: [],
		stack: {
			schemaVersion: 1,
			id: "restrictive",
			tools: { allow: ["read", "paint_*"] },
			items: [{
				kind: "slot",
				id: "history",
				slot: "chat-history",
				role: "user",
				options: { includeLastUserMessage: false },
			}],
			...overrides,
		},
	};
}

function user(text: string, timestamp = 0): AgentMessage {
	return { role: "user", content: text, timestamp };
}

test("subagent SDK spike CLI is dry and no-access by default", () => {
	const parsed = parseSpikeArgs([], { cwd: "/tmp" });
	assert.equal(parsed.execute, false);
	assert.equal(parsed.access, "none");
	assert.equal(parsed.profileId, "default");
	assert.equal(parsed.timeoutMs, 60_000);

	const explicit = parseSpikeArgs([
		"--execute", "--profile", "reviewer", "--access", "read-only",
		"--timeout", "1234", "--task", "Review this", "--image", "sample.png",
		"--load-forge-extensions",
	], { cwd: "/workspace" });
	assert.equal(explicit.execute, true);
	assert.equal(explicit.profileId, "reviewer");
	assert.equal(explicit.access, "read-only");
	assert.equal(explicit.timeoutMs, 1234);
	assert.deepEqual(explicit.imagePaths, ["/workspace/sample.png"]);
	assert.equal(explicit.loadForgeExtensions, true);
	assert.throws(() => parseSpikeArgs(["--access", "root"]), /must be one of/);
	assert.throws(() => parseSpikeArgs(["--timeout", "0"]), /positive integer/);
});

test("tool negotiation intersects backend catalog, stack policy, and access", () => {
	const catalog = ["write", "paint_validate_workflow", "read", "bash", "paint_list_workflows"];
	const none = computeSpikeToolPolicy(catalog, stack(), "none");
	assert.deepEqual(none.stackSelected, ["paint_list_workflows", "paint_validate_workflow", "read"]);
	assert.deepEqual(none.effective, []);
	assert.equal(none.accessEnforceable, true);

	const readOnly = computeSpikeToolPolicy(catalog, stack(), "read-only");
	assert.deepEqual(readOnly.effective, ["read"]);
	assert.equal(readOnly.accessEnforceable, false);
	assert.match(readOnly.accessDiagnostic ?? "", /allowed-root/);

	const write = computeSpikeToolPolicy(catalog, stack(), "workspace-write");
	assert.deepEqual(write.effective, ["paint_list_workflows", "paint_validate_workflow", "read"]);
	assert.equal(write.accessEnforceable, false);

	const unmatched = computeSpikeToolPolicy(["read"], stack({ tools: { allow: ["missing_*"] } }), "none");
	assert.deepEqual(unmatched.unmatchedAllowPatterns, ["missing_*"]);
});

test("protected delegated task remains the final structured user message", () => {
	const task: AgentMessage = {
		role: "user",
		content: [
			{ type: "text", text: "Inspect the image" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
		timestamp: 2,
	};
	const result = appendProtectedTask([user("background", 1)], task);
	assert.equal(protectedTaskPreserved(result, task), true);
	assert.equal(protectedTaskPreserved(result, { ...task, timestamp: 999 }), true);
	assert.equal(protectedTaskPreserved([user("plain")], {
		role: "user",
		content: [{ type: "text", text: "plain" }],
		timestamp: 1,
	}), true);
	assert.notEqual(result.at(-1), task);
	assert.throws(() => appendProtectedTask([], { role: "assistant" } as AgentMessage), /user message/);
});

test("stack history filters cannot remove the protected delegated task", () => {
	const background = user("optional background", 1);
	const task = user("required task", 2);
	const result = compileProtectedTaskMessages(stack(), {
		options: { cwd: "/workspace", selectedTools: [] },
		latestUserMessage: "required task",
		now: new Date("2026-07-12T00:00:00Z"),
		variables: createPromptVariableStore(),
	}, [background, task]);

	assert.equal(result.messages.at(-1)?.role, "user");
	assert.equal((result.messages.at(-1) as { content?: unknown }).content, "required task");
	assert.equal(protectedTaskPreserved(result.messages, task), true);
});
