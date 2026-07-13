import assert from "node:assert/strict";
import test from "node:test";
import { formatProviderPayload } from "../src/payload-capture.ts";

test("provider payload redaction preserves token accounting and tokenizer metadata", () => {
	const result = formatProviderPayload({
		max_tokens: 4096,
		maxOutputTokens: 2048,
		input_tokens: 120,
		output_tokens: 42,
		total_tokens: 162,
		tokenBudget: 8192,
		tokenizer: "qwen",
	});

	assert.deepEqual(result.payload, {
		max_tokens: 4096,
		maxOutputTokens: 2048,
		input_tokens: 120,
		output_tokens: 42,
		total_tokens: 162,
		tokenBudget: 8192,
		tokenizer: "qwen",
	});
});

test("provider payload redaction still hides credential-shaped token fields", () => {
	const result = formatProviderPayload({
		token: "generic-secret",
		access_token: "access-secret",
		refreshToken: "refresh-secret",
		id_token: "identity-secret",
		sessionToken: "session-secret",
		Authorization: "Bearer auth-secret",
		apiKey: "api-secret",
	});

	assert.deepEqual(result.payload, {
		token: "[redacted]",
		access_token: "[redacted]",
		refreshToken: "[redacted]",
		id_token: "[redacted]",
		sessionToken: "[redacted]",
		Authorization: "[redacted]",
		apiKey: "[redacted]",
	});
});
