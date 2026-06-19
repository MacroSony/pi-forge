import type { WebEditorPayloadCapture } from "./web-editor/index.ts";

export function createProviderPayloadCapture(value: unknown, options: { stackId?: string; savePath?: string } = {}): WebEditorPayloadCapture {
	const formatted = formatProviderPayload(value);
	return {
		capturedAt: new Date().toISOString(),
		stackId: options.stackId,
		savePath: options.savePath,
		payload: formatted.payload,
		text: formatted.text,
		chars: formatted.chars,
		approxTokens: formatted.approxTokens,
		truncated: formatted.truncated,
		error: formatted.error,
	};
}

export function formatProviderPayload(value: unknown): { payload?: unknown; text: string; chars: number; approxTokens: number; truncated: boolean; error?: string } {
	try {
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
		};
	} catch (error) {
		const text = `Failed to stringify provider payload: ${error instanceof Error ? error.message : String(error)}`;
		return {
			text,
			chars: text.length,
			approxTokens: estimatePayloadTokens(text),
			truncated: false,
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

function isSecretKey(key: string): boolean {
	return /(api[-_]?key|authorization|bearer|token|secret|password|cookie|credential)/i.test(key);
}

function redactLongString(value: string): string {
	if (/^data:image\//.test(value)) return "[image data omitted]";
	if (value.length > 8_000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) return `[base64-like data omitted: ${value.length} chars]`;
	if (value.length > 12_000) return `${value.slice(0, 12_000)}\n[pi-forge: string truncated from ${value.length} chars]`;
	return value;
}
