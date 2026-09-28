import type { WebEditorPreviewSection } from "../types.ts";
import { hashText } from "../../context-diff.ts";
import { previewSectionText } from "../../preview-text.ts";

export interface InspectionRow {
 key: string;
 section: WebEditorPreviewSection;
 body: WebEditorPreviewSection;
 kind: "body" | "call" | "result";
 partKind?: string;
 role: string;
 scope: string;
 owner?: string;
 callId?: string;
 toolName?: string;
 isError?: boolean;
 pairKey?: string;
 argumentHint?: string;
 text: string;
 position: number;
}
export interface InspectionBatch { key: string; owner: string; rows: InspectionRow[]; }
export type InspectionEntry = InspectionRow | InspectionBatch;
export function isBatch(entry: InspectionEntry): entry is InspectionBatch { return "rows" in entry; }

/** No message reconstruction: flatten the read-only sidecar in compiled/part order. */
export function inspectionRows(sections: readonly WebEditorPreviewSection[]): InspectionRow[] {
 const rows: InspectionRow[] = [];
 for (const section of sections) {
  const data = section.inspection;
  const identity = data?.key ?? `legacy:${section.diffKey ?? section.id}:${hashText(previewSectionText(section))}`;
  const scope = data?.scope ?? `legacy:${identity}`;
  const role = section.role || (section.id === "system" ? "system" : "message");
  const base = { section, role, scope, position: 0 };
  if (role === "toolResult") {
   const meta = data?.toolResult;
   const text = data?.parts.length ? data.parts.map(part => part.text).join("\n") : section.content;
   rows.push({ ...base, key: identity, body: section, kind: "result", text, callId: meta?.callId, toolName: meta?.toolName, isError: meta?.isError });
  } else if (role === "assistant" && data?.parts.length) {
   for (const part of data.parts) {
    rows.push({ ...base, key: part.key, body: { ...section, content: part.text, sections: undefined, toolChanges: undefined }, kind: part.kind === "toolCall" ? "call" : "body", partKind: part.kind, owner: part.kind === "toolCall" ? identity : undefined, text: part.text, callId: part.callId, toolName: part.toolName });
   }
  } else {
   // Preserve native System section operations and historical tool declarations intact.
   const body = role !== "system" && data?.parts.length ? { ...section, content: data.parts.map(part => part.text).join("\n") } : section;
   rows.push({ ...base, key: identity, body, kind: "body", text: previewSectionText(body) });
  }
 }
 const calls = new Map<string, InspectionRow[]>(), results = new Map<string, InspectionRow[]>();
 rows.forEach((row, i) => {
  row.position = i + 1;
  if (row.kind === "body" || !row.callId) return;
  const map = row.kind === "call" ? calls : results, key = JSON.stringify([row.scope, row.callId]);
  const list = map.get(key) ?? []; list.push(row); map.set(key, list);
 });
 for (const [key, list] of calls) {
  const returns = results.get(key);
  if (list.length !== 1 || returns?.length !== 1) continue;
  const call = list[0]!, result = returns[0]!;
  // A result preceding its purported call or conflicting explicit names is not a safe association.
  if (result.position <= call.position || (result.toolName && call.toolName && result.toolName !== call.toolName)) continue;
  call.pairKey = result.key; result.pairKey = call.key; result.owner = call.owner;
  result.toolName ||= call.toolName;
  if (call.text.length <= 65536) {
   try { const args = JSON.parse(call.text); if (typeof args?.path === "string") result.argumentHint = args.path; } catch { /* optional hint only */ }
  }
 }
 return rows;
}

/** Only uninterrupted tools belonging to the same explicit assistant message share a fold. */
export function inspectionEntries(rows: readonly InspectionRow[]): InspectionEntry[] {
 const entries: InspectionEntry[] = [];
 let batch: InspectionBatch | undefined;
 for (const row of rows) {
  if (row.kind === "body" || !row.owner) { batch = undefined; entries.push(row); continue; }
  if (!batch || batch.owner !== row.owner || batch.rows[0]?.scope !== row.scope) {
   batch = { key: `tools:${row.owner}:${row.key}`, owner: row.owner, rows: [] }; entries.push(batch);
  }
  batch.rows.push(row);
 }
 return entries;
}

/** A display-only permutation. Cross-interval returns are barriers, never moved across. */
export function pairedRows(rows: readonly InspectionRow[]): InspectionRow[] {
 const keys = new Set(rows.map(row => row.key));
 const output: InspectionRow[] = [], run: InspectionRow[] = [];
 function flush() {
  const available = new Map(run.map(row => [row.key, row]));
  const moved = new Set<string>();
  for (const row of run) {
   if (moved.has(row.key)) continue;
   output.push(row);
   if (row.kind === "call" && row.pairKey) {
    const result = available.get(row.pairKey);
    if (result) { output.push(result); moved.add(result.key); }
   }
  }
  run.length = 0;
 }
 for (const row of rows) {
  if (row.kind === "result" && (!row.pairKey || !keys.has(row.pairKey))) { flush(); output.push(row); }
  else run.push(row);
 }
 flush(); return output;
}

export function rowMatches(row: InspectionRow, query: string): boolean {
 const q = query.trim().toLocaleLowerCase();
 return !q || [row.text, row.role, row.partKind, row.section.title, row.scope, row.toolName, row.callId, row.owner, row.argumentHint].join(" ").toLocaleLowerCase().includes(q);
}

/** Bounded lexical excerpt: never parse/re-serialize numeric lexemes or duplicate keys. */
export function parameterExcerpt(text: string): string {
 const prefix = text.slice(0, 2048); let quoted = false, escaped = false, out = "";
 for (const ch of prefix) {
  if (quoted) { out += ch; if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; }
  else if (ch === '"') { quoted = true; out += ch; }
  else if (/\s/.test(ch)) { if (out && !out.endsWith(" ")) out += " "; }
  else out += ch;
 }
 return out.slice(0, 220) + (out.length > 220 || text.length > prefix.length ? "…" : "");
}
export function textExcerpt(text: string): string {
 const prefix = text.slice(0, 2048).replace(/\s+/g, " ");
 return prefix.slice(0, 220) + (prefix.length > 220 || text.length > 2048 ? "…" : "");
}
