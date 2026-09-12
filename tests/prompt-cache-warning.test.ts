import assert from "node:assert/strict";
import test from "node:test";
import { calculatePromptCacheImpact, commonPrefixLength, formatPromptCacheWarning } from "../src/prompt-cache-warning.ts";

test("commonPrefixLength handles identical prompts", () => {
	assert.equal(commonPrefixLength("same prompt", "same prompt"), "same prompt".length);
});

test("commonPrefixLength handles a partial prefix", () => {
	assert.equal(commonPrefixLength("system OLD", "system NEW"), "system ".length);
});

test("commonPrefixLength handles completely different prompts", () => {
	assert.equal(commonPrefixLength("alpha", "omega"), 0);
});

test("commonPrefixLength handles an empty prompt", () => {
	assert.equal(commonPrefixLength("", "new prompt"), 0);
	assert.equal(commonPrefixLength("old prompt", ""), 0);
});

test("prompt cache warning decision suppresses identical prompts", () => {
	assert.equal(calculatePromptCacheImpact("unchanged", "unchanged"), undefined);
	assert.equal(formatPromptCacheWarning("unchanged", "unchanged"), undefined);
});

test("prompt cache warning decision quantifies a partial prefix and cache usage", () => {
	const warning = formatPromptCacheWarning("abcdefghijklmnopqrst", "abcdefghijDIFFERENT", {
		cacheRead: 42,
		cacheStatus: "reported",
	});
	assert.equal(warning, "Switching will change the system prompt. Common prefix with current prompt: ~3 tokens (50%). The remaining ~2 tokens of history will be re-processed. Last request read ~42 tokens from cache.");
});

test("prompt cache warning decision reports full replacement", () => {
	assert.equal(
		formatPromptCacheWarning("abcdefgh", "xyz"),
		"Switching replaces the system prompt entirely; the full prompt prefix (~2 tokens) will be re-processed.",
	);
});
