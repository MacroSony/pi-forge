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
export function createProviderPayloadCapture(value, options = {}) {
    return createProviderPayloadCaptureWithSerialization(value, options).capture;
}
export function createProviderPayloadCaptureWithSerialization(value, options = {}) {
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
export function formatProviderPayload(value) {
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
    }
    catch (error) {
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
export function estimatePayloadTokens(payload) {
    return Math.max(1, Math.ceil(payload.length / 4));
}
function redactPayload(value, depth = 0) {
    if (depth > 8)
        return "[pi-forge: max depth reached]";
    if (typeof value === "string")
        return redactLongString(value);
    if (value === null || typeof value !== "object")
        return value;
    if (Array.isArray(value)) {
        const maxItems = 80;
        const items = value.slice(0, maxItems).map((item) => redactPayload(item, depth + 1));
        if (value.length > maxItems)
            items.push(`[pi-forge: ${value.length - maxItems} more items omitted]`);
        return items;
    }
    const result = {};
    let count = 0;
    for (const [key, raw] of Object.entries(value)) {
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
 * JSON-compatible request structure. Every other string is kept verbatim.
 */
function redactPayloadFaithfully(value, ancestors = new Set()) {
    if (typeof value === "string")
        return elideInlineMedia(value) ?? value;
    if (value === null || typeof value !== "object")
        return value;
    if (ancestors.has(value))
        return "[pi-forge: circular reference]";
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    if (Array.isArray(value))
        return value.map((item) => redactPayloadFaithfully(item, nextAncestors));
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
        result[key] = isSecretKey(key) ? "[redacted]" : redactPayloadFaithfully(raw, nextAncestors);
    }
    return result;
}
function stringifyPayload(value) {
    const rendered = JSON.stringify(value, null, 2);
    return rendered === undefined ? String(value) : rendered;
}
function isSecretKey(key) {
    if (SAFE_TOKEN_METADATA_KEYS.has(normalizeSecretKey(key)))
        return false;
    return /(api[-_]?key|authorization|bearer|token|secret|password|cookie|credential)/i.test(key);
}
function normalizeSecretKey(key) {
    return key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
}
function redactLongString(value) {
    if (/^data:image\//.test(value))
        return "[image data omitted]";
    if (value.length > 8_000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value))
        return `[base64-like data omitted: ${value.length} chars]`;
    if (value.length > 12_000)
        return `${value.slice(0, 12_000)}\n[pi-forge: string truncated from ${value.length} chars]`;
    return value;
}
const DATA_URL_BASE64_PREFIX = /^data:([^;,]*)(?:;[^;,]*)*;base64,/i;
const BASE64_LIKE = /^[A-Za-z0-9+/=_\-\r\n]+$/;
const INLINE_BASE64_MIN_CHARS = 8_000;
const MEDIA_FINGERPRINT_SAMPLES = 4_096;
/**
 * Replace inline binary payloads with a bounded placeholder. Returns undefined
 * for ordinary strings. Provider payloads carry images, audio and files as
 * `data:<mime>;base64,...` URLs (OpenAI, Codex Responses) or as bare base64
 * (Anthropic `source.data`, Gemini `inlineData.data`).
 */
export function elideInlineMedia(value) {
    const dataUrl = DATA_URL_BASE64_PREFIX.exec(value.slice(0, 256));
    if (dataUrl) {
        const mime = dataUrl[1] || "application/octet-stream";
        return `[pi-forge: ${mime} data omitted · ${value.length} chars · fp ${mediaFingerprint(value)}]`;
    }
    if (value.length >= INLINE_BASE64_MIN_CHARS && BASE64_LIKE.test(value)) {
        return `[pi-forge: base64 data omitted · ${value.length} chars · fp ${mediaFingerprint(value)}]`;
    }
    return undefined;
}
/**
 * Cheap content fingerprint for large blobs: FNV-1a over an evenly spaced
 * sample plus the tail. Hashing every byte of every image on every request
 * would cost tens of millions of iterations per turn in long screenshot
 * sessions; a sample is enough to tell different media apart for diffing.
 */
function mediaFingerprint(value) {
    let hash = 0x811c9dc5;
    const mix = (code) => {
        hash ^= code;
        hash = Math.imul(hash, 0x01000193);
    };
    if (value.length <= MEDIA_FINGERPRINT_SAMPLES * 2) {
        for (let index = 0; index < value.length; index++)
            mix(value.charCodeAt(index));
    }
    else {
        const stride = value.length / MEDIA_FINGERPRINT_SAMPLES;
        for (let sample = 0; sample < MEDIA_FINGERPRINT_SAMPLES; sample++)
            mix(value.charCodeAt(Math.floor(sample * stride)));
        for (let index = value.length - 64; index < value.length; index++)
            mix(value.charCodeAt(index));
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
//# sourceMappingURL=payload-capture.js.map