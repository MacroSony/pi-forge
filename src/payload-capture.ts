import type { WebEditorPayloadCapture } from "./web-editor/index.ts";

const SAFE_TOKEN_METADATA_KEYS = new Set([
	"accepted_prediction_tokens",
	"audio_tokens",
	"cached_tokens",
	"completion_tokens",
	"input_tokens",
	"max_completion_tokens",
	"max_output_tokens",
	"max_tokens",
	"output_tokens",
	"prompt_tokens",
	"reasoning_tokens",
	"rejected_prediction_tokens",
	"token_budget",
	"token_count",
	"tokenizer",
	"total_tokens",
]);

export interface ProviderPayloadCaptureWithSerialization {
	capture: WebEditorPayloadCapture;
	/** Secret-redacted JSON without the display capture's lossy limits. */
	serializedPayload: string;
}

export function createProviderPayloadCapture(value: unknown, options: { stackId?: string; savePath?: string } = {}): WebEditorPayloadCapture {
	return createProviderPayloadCaptureWithSerialization(value, options).capture;
}

export function createProviderPayloadCaptureWithSerialization(
	value: unknown,
	options: { stackId?: string; savePath?: string } = {},
): ProviderPayloadCaptureWithSerialization {
	const formatted = formatProviderPayload(value);
	return {
		capture: {
			capturedAt: new Date().toISOString(),
			stackId: options.stackId,
			savePath: options.savePath,
			payload: formatted.payload,
			text: formatted.text,
			chars: formatted.chars,
			approxTokens: formatted.approxTokens,
			truncated: formatted.truncated,
			error: formatted.error,
		},
		serializedPayload: formatted.serializedPayload,
	};
}

export function formatProviderPayload(value: unknown): {
	payload?: unknown;
	text: string;
	chars: number;
	approxTokens: number;
	truncated: boolean;
	serializedPayload: string;
	error?: string;
} {
	try {
		const faithfulPayload = redactPayloadFaithfully(value);
		const serializedPayload = stringifyPayload(faithfulPayload);
		const payload = redactPayload(value);
		const renderedJson = JSON.stringify(payload, null, 2);
		const text = renderedJson === undefined ? String(payload) : renderedJson;
		const maxChars = 200_000;
		const truncated = text.length > maxChars;
		const rendered = truncated ? `${text.slice(0, maxChars)}\n\n[pi-forge: payload truncated after ${maxChars} chars]` : text;
		return {
			payload: truncated ? undefined : payload,
			text: rendered,
			chars: rendered.length,
			approxTokens: estimatePayloadTokens(rendered),
			truncated,
			serializedPayload,
		};
	} catch (error) {
		const text = `Failed to stringify provider payload: ${error instanceof Error ? error.message : String(error)}`;
		return {
			text,
			chars: text.length,
			approxTokens: estimatePayloadTokens(text),
			truncated: false,
			serializedPayload: text,
			error: text,
		};
	}
}

export function estimatePayloadTokens(payload: string): number {
	return Math.max(1, Math.ceil(payload.length / 4));
}

function redactPayload(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[pi-forge: max depth reached]";
	if (typeof value === "string") return redactLongString(value);
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		const maxItems = 80;
		const items = value.slice(0, maxItems).map((item) => redactPayload(item, depth + 1));
		if (value.length > maxItems) items.push(`[pi-forge: ${value.length - maxItems} more items omitted]`);
		return items;
	}

	const result: Record<string, unknown> = {};
	let count = 0;
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (++count > 120) {
			result["[pi-forge: omitted]"] = "object has more than 120 keys";
			break;
		}
		if (isSecretKey(key)) {
			result[key] = "[redacted]";
			continue;
		}
		result[key] = redactPayload(raw, depth + 1);
	}
	return result;
}

/** Redact credentials while retaining the complete JSON-compatible request. */
function redactPayloadFaithfully(value: unknown, ancestors = new Set<object>()): unknown {
	if (typeof value === "string" || value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) return "[pi-forge: circular reference]";
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) return value.map((item) => redactPayloadFaithfully(item, nextAncestors));

	const result: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		result[key] = isSecretKey(key) ? "[redacted]" : redactPayloadFaithfully(raw, nextAncestors);
	}
	return result;
}

function stringifyPayload(value: unknown): string {
	const rendered = JSON.stringify(value, null, 2);
	return rendered === undefined ? String(value) : rendered;
}

function isSecretKey(key: string): boolean {
	if (SAFE_TOKEN_METADATA_KEYS.has(normalizeSecretKey(key))) return false;
	return /(api[-_]?key|authorization|bearer|token|secret|password|cookie|credential)/i.test(key);
}

function normalizeSecretKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

function redactLongString(value: string): string {
	if (/^data:image\//.test(value)) return "[image data omitted]";
	if (value.length > 8_000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) return `[base64-like data omitted: ${value.length} chars]`;
	if (value.length > 12_000) return `${value.slice(0, 12_000)}\n[pi-forge: string truncated from ${value.length} chars]`;
	return value;
}
