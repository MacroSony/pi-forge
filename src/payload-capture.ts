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
	/**
	 * Secret-redacted JSON without the display capture's lossy limits. Inline
	 * media in standard provider fields (base64 data URLs, base64 `data` of
	 * media blocks, binary byte arrays) is replaced by a compact placeholder
	 * carrying its type, length and a sampled fingerprint. Other strings are
	 * kept verbatim.
	 */
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

/**
 * Redact credentials and elide inline media while retaining the complete
 * JSON-compatible request structure. Media is recognised by structure, never
 * by character set alone, so long identifiers, hex or URL-safe text in
 * ordinary messages are kept verbatim.
 */
function redactPayloadFaithfully(value: unknown, ancestors = new Set<object>()): unknown {
	if (typeof value === "string") return elideDataUrl(value) ?? value;
	if (value === null || typeof value !== "object") return value;
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return elideBinary(value);
	if (ancestors.has(value)) return "[pi-forge: circular reference]";
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) return value.map((item) => redactPayloadFaithfully(item, nextAncestors));

	const record = value as Record<string, unknown>;
	const containerMime = mediaContainerMime(record);
	const result: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(record)) {
		if (isSecretKey(key)) {
			result[key] = "[redacted]";
			continue;
		}
		if (typeof raw === "string" && (ALWAYS_BASE64_MEDIA_KEYS.has(key) || (containerMime !== undefined && CONTAINER_BASE64_MEDIA_KEYS.has(key)))) {
			const elided = elideBase64Media(raw, containerMime || "base64");
			if (elided !== undefined) {
				result[key] = elided;
				continue;
			}
		}
		result[key] = redactPayloadFaithfully(raw, nextAncestors);
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

const DATA_URL_BASE64_PREFIX = /^data:([^;,]*)(?:;[^;,]*)*;base64,/i;
const BASE64_CHARSET = /^[A-Za-z0-9+/=_\-\r\n]*$/;
const MEDIA_FINGERPRINT_SAMPLES = 4_096;
/** Keys that hold base64 media wherever they appear. */
const ALWAYS_BASE64_MEDIA_KEYS = new Set(["data_base64", "b64_json"]);
/** Keys that hold base64 media inside a media block (see mediaContainerMime). */
const CONTAINER_BASE64_MEDIA_KEYS = new Set(["data", "bytes"]);
const MEDIA_TYPE_KEYS = ["media_type", "mediaType", "mime_type", "mimeType", "format"] as const;

/**
 * Media blocks carry base64 next to a type marker: Anthropic
 * `{ type: "base64", media_type, data }`, Gemini `inlineData: { mimeType, data }`,
 * OpenAI chat `input_audio: { data, format }`. Returns the declared type ("" if
 * only `type: "base64"` marks it), or undefined for ordinary objects.
 */
function mediaContainerMime(record: Record<string, unknown>): string | undefined {
	for (const key of MEDIA_TYPE_KEYS) {
		if (typeof record[key] === "string") return record[key] as string;
	}
	return record.type === "base64" ? "" : undefined;
}

/** Replace a base64 data URL (OpenAI, Codex Responses, Mistral) with a bounded placeholder. */
function elideDataUrl(value: string): string | undefined {
	const dataUrl = DATA_URL_BASE64_PREFIX.exec(value.slice(0, 256));
	if (!dataUrl) return undefined;
	const mime = dataUrl[1] || "application/octet-stream";
	return `[pi-forge: ${mime} data omitted · ${value.length} chars · fp ${fingerprint(value.length, (index) => value.charCodeAt(index))}]`;
}

function elideBase64Media(value: string, label: string): string | undefined {
	if (!BASE64_CHARSET.test(value)) return undefined;
	return `[pi-forge: ${label} data omitted · ${value.length} chars · fp ${fingerprint(value.length, (index) => value.charCodeAt(index))}]`;
}

/** Binary payloads (for example Bedrock image `source.bytes`) would otherwise serialize index by index. */
function elideBinary(value: ArrayBufferView | ArrayBuffer): string {
	const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	return `[pi-forge: binary data omitted · ${bytes.length} bytes · fp ${fingerprint(bytes.length, (index) => bytes[index]!)}]`;
}

/**
 * Approximate content fingerprint: FNV-1a over an evenly spaced sample plus
 * the tail (exact for inputs up to 8192 units). Different images practically
 * always differ at sampled positions; a same-length edit that touches only
 * unsampled positions is not detected. Hashing every byte of every image on
 * every request would cost tens of millions of iterations per turn in long
 * screenshot sessions.
 */
function fingerprint(length: number, at: (index: number) => number): string {
	let hash = 0x811c9dc5;
	const mix = (code: number) => {
		hash ^= code;
		hash = Math.imul(hash, 0x01000193);
	};
	if (length <= MEDIA_FINGERPRINT_SAMPLES * 2) {
		for (let index = 0; index < length; index++) mix(at(index));
	} else {
		const stride = length / MEDIA_FINGERPRINT_SAMPLES;
		for (let sample = 0; sample < MEDIA_FINGERPRINT_SAMPLES; sample++) mix(at(Math.floor(sample * stride)));
		for (let index = length - 64; index < length; index++) mix(at(index));
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
