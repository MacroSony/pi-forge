import { createHash } from "node:crypto";
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
	 * carrying its type, length and a content hash. Other strings are kept
	 * verbatim.
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
	if (isBinary(value)) return elideBinary(value);
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
 * Where a value sits: the key that holds it, the `type` of the object that holds
 * that key, and whether it is inside ordinary data (tool arguments or tool
 * definitions) where no media inference is applied.
 */
interface MediaPath {
	key?: string;
	parentType?: unknown;
	ordinary?: boolean;
}

/**
 * Redact credentials and elide inline media while retaining the complete
 * JSON-compatible request structure. Bare base64 is recognised only at known
 * provider media paths, never by field names or character set alone, so tool
 * arguments and other ordinary data are kept verbatim.
 */
function redactPayloadFaithfully(value: unknown, ancestors = new Set<object>(), path: MediaPath = {}): unknown {
	if (typeof value === "string") return path.ordinary ? value : elideDataUrl(value) ?? value;
	if (value === null || typeof value !== "object") return value;
	if (isBinary(value)) return elideBinary(value);
	if (ancestors.has(value)) return "[pi-forge: circular reference]";
	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) return value.map((item) => redactPayloadFaithfully(item, nextAncestors, path));

	const record = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(record)) {
		if (isSecretKey(key)) {
			result[key] = "[redacted]";
			continue;
		}
		const mediaLabel = typeof raw === "string" && !path.ordinary ? base64MediaLabel(path, record, key) : undefined;
		if (mediaLabel !== undefined) {
			const elided = elideBase64Media(raw as string, mediaLabel);
			if (elided !== undefined) {
				result[key] = elided;
				continue;
			}
		}
		result[key] = redactPayloadFaithfully(raw, nextAncestors, {
			key,
			parentType: record.type,
			ordinary: path.ordinary || isOrdinarySubtree(path, record, key),
		});
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
/**
 * Subtrees that hold caller-defined data rather than request media: tool
 * definitions and tool-call arguments (Anthropic `tool_use.input`, Pi native
 * `toolCall.arguments`, Responses `custom_tool_call.input`, Gemini
 * `functionCall.args`, Bedrock `toolUse.input`). Their contents are kept
 * verbatim even when they happen to look like media blocks. Positions not
 * listed here may still be shown as a media placeholder, but the content hash
 * keeps every edit visible to the diff.
 */
function isOrdinarySubtree(path: MediaPath, record: Record<string, unknown>, key: string): boolean {
	if (TOOL_DEFINITION_KEYS.has(key)) return true;
	if ((key === "input" || key === "arguments") && typeof record.type === "string" && TOOL_CALL_TYPES.has(record.type)) return true;
	if (key === "args" && path.key === "functionCall") return true;
	if (key === "input" && path.key === "toolUse") return true;
	return false;
}

const TOOL_DEFINITION_KEYS = new Set(["tools", "toolsAdded", "functionDeclarations", "tool_config", "toolConfig"]);
/** Block types whose `input`/`arguments` hold tool-call arguments (Anthropic, Pi native, Responses/Codex). */
const TOOL_CALL_TYPES = new Set(["tool_use", "server_tool_use", "toolCall", "function_call", "custom_tool_call"]);

/**
 * Known provider request paths that carry bare base64 media. Returns a label
 * (MIME type when declared) or undefined for everything else:
 * - Anthropic image/document blocks: `{ type: "image", source: { type: "base64", media_type, data } }`
 * - Gemini parts: `{ inlineData: { mimeType, data } }` (also `inline_data` / `mime_type`)
 * - OpenAI chat audio: `{ type: "input_audio", input_audio: { data, format } }`
 * - image assets: `{ type: "image", format, data_base64 }`
 * - Pi's native image content (pi-messages providers): `{ type: "image", mimeType, data }`
 */
function base64MediaLabel(path: MediaPath, record: Record<string, unknown>, key: string): string | undefined {
	const text = (value: unknown, fallback: string) => typeof value === "string" && value ? value : fallback;
	if (key === "data") {
		if (path.key === "source" && record.type === "base64" && (path.parentType === "image" || path.parentType === "document")) return text(record.media_type, "base64");
		if (path.key === "inlineData" || path.key === "inline_data") return text(record.mimeType ?? record.mime_type, "base64");
		if (path.key === "input_audio" && path.parentType === "input_audio") return `audio/${text(record.format, "base64")}`;
		if (record.type === "image" && typeof record.mimeType === "string") return text(record.mimeType, "base64");
	}
	if (key === "data_base64" && record.type === "image") return text(record.format, "image");
	return undefined;
}

function isBinary(value: object): value is ArrayBufferView | ArrayBuffer | SharedArrayBuffer {
	return ArrayBuffer.isView(value)
		|| value instanceof ArrayBuffer
		|| (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer);
}

/** Replace a base64 data URL (OpenAI, Codex Responses, Mistral) with a bounded placeholder. */
function elideDataUrl(value: string): string | undefined {
	const dataUrl = DATA_URL_BASE64_PREFIX.exec(value.slice(0, 256));
	if (!dataUrl) return undefined;
	const mime = dataUrl[1] || "application/octet-stream";
	return `[pi-forge: ${mime} data omitted · ${value.length} chars · sha1 ${contentHash(value)}]`;
}

function elideBase64Media(value: string, label: string): string | undefined {
	if (!BASE64_CHARSET.test(value)) return undefined;
	return `[pi-forge: ${label} data omitted · ${value.length} chars · sha1 ${contentHash(value)}]`;
}

/** Binary payloads (for example Bedrock image `source.bytes`) would otherwise serialize index by index. */
function elideBinary(value: ArrayBufferView | ArrayBuffer | SharedArrayBuffer): string {
	const bytes = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
	return `[pi-forge: binary data omitted · ${bytes.length} bytes · sha1 ${contentHash(bytes)}]`;
}

/**
 * Content identity for elided media: SHA-1 over the complete content (native,
 * about 0.5 ms per MB), so any edit changes the placeholder and the diff sees
 * it. Not a security boundary.
 */
function contentHash(value: string | Uint8Array): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 16);
}
