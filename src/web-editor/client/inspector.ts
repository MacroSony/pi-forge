import { attr, el, escapeHtml } from "./dom.ts";
import { t } from "./i18n.ts";
import type { EditorRequestInit } from "./api.ts";
import type { EditorPayloadRefreshOptions, EditorPromptStack, PromptStackDiagnostic, WebEditorPayloadSnapshot } from "./types.ts";

export interface InspectorDependencies {
	api<T = any>(path: string, options?: EditorRequestInit): Promise<T>;
	getSelectedId(): string;
	stackForSubmit(): EditorPromptStack;
	renderDiagnostics(diagnostics: PromptStackDiagnostic[]): void;
	renderItemList(): void;
	setStatus(text: string, tone?: string): void;
}

export function createInspector(deps: InspectorDependencies) {
	const { api, stackForSubmit, renderDiagnostics, renderItemList, setStatus } = deps;
	const selectedId = deps.getSelectedId;
	let payloadSnapshot: WebEditorPayloadSnapshot = { status: "idle" };
	let previewCopyTexts: string[] = [];

async function validateStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId()) + "/validate", { method: "POST", body: { stack } });
  renderDiagnostics(data.diagnostics || []);
  renderItemList();
  hidePreview();
  setStatus(t("inspector.validationComplete"), "success");
}

async function previewStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId()) + "/preview", { method: "POST", body: { stack } });
  renderDiagnostics(data.diagnostics || []);
  renderItemList();
  renderPreviewInspector(data);
  setStatus(t("inspector.previewRendered"), "success");
}

async function refreshPayloadCapture(options: any = {}) {
  const previousCapturedAt = payloadSnapshot.status === "captured" ? payloadSnapshot.capture?.capturedAt : "";
  const data = await api("/api/payload");
  payloadSnapshot = data;
  updatePayloadButton();
  const nextCapturedAt = payloadSnapshot.status === "captured" ? payloadSnapshot.capture?.capturedAt : "";
  if (options.open || (options.autoOpen && nextCapturedAt && nextCapturedAt !== previousCapturedAt)) {
    renderPayloadInspector(payloadSnapshot);
  }
}

async function armPayloadCapture(showInspector: any = false) {
  const data = await api("/api/payload/arm", { method: "POST" });
  payloadSnapshot = data;
  updatePayloadButton();
  setStatus(t("inspector.armed"));
  if (showInspector) renderPayloadInspector(payloadSnapshot);
}

async function clearPayloadCapture() {
  const data = await api("/api/payload", { method: "DELETE" });
  payloadSnapshot = data;
  updatePayloadButton();
  hidePreview();
  setStatus(t("inspector.cleared"), "success");
}

async function openPayloadCapture() {
  await refreshPayloadCapture();
  if (payloadSnapshot.status === "captured" || payloadSnapshot.status === "armed") {
    renderPayloadInspector(payloadSnapshot);
    return;
  }
  await armPayloadCapture();
}

function updatePayloadButton() {
  const button = el("payloadBtn");
  if (!button) return;
  button.classList.remove("primary");
  if (payloadSnapshot.status === "armed") {
    button.textContent = t("inspector.armedButton");
    button.classList.add("primary");
    button.title = t("inspector.armedButtonTitle");
    return;
  }
  if (payloadSnapshot.status === "captured") {
    button.textContent = t("inspector.viewPayload");
    button.title = t("inspector.viewPayloadTitle");
    return;
  }
  button.textContent = t("chrome.armPayload");
  button.title = t("inspector.armTitle");
}

function hidePreview() {
  const pane = el("preview");
  pane.classList.remove("open");
  pane.innerHTML = "";
  previewCopyTexts = [];
}

function renderPreviewInspector(data: any) {
  const pane = el("preview");
  const preview = data.preview;
  if (!preview) {
    previewCopyTexts = [data.text || ""];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="' + attr(t("inspector.previewAria")) + '">' +
      '<div class="preview-head"><div><div class="preview-title">' + escapeHtml(t("chrome.preview")) + '</div><div class="preview-meta">' + escapeHtml(t("inspector.plainTextFallback")) + '</div></div>' +
      '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="' + attr(t("inspector.copyFullTitle")) + '">' + escapeHtml(t("inspector.copy")) + '</button><button data-preview-close="true" data-icon="×" title="' + attr(t("inspector.closePreview")) + '">' + escapeHtml(t("modal.close")) + '</button></div></div>' +
      '<div class="preview-body"><pre class="preview-text">' + escapeHtml(data.text || "") + '</pre></div></div>';
    pane.classList.add("open");
    return;
  }

  const sections = [preview.system, ...(preview.messages || [])];
  previewCopyTexts = [data.text || "", ...sections.map((section: any) => section.content || "")];
  const sectionHtml = sections.map((section: any, index: any) => {
    const open = index === 0 ? " open" : "";
    const label = section.role ? section.role + " · " : "";
    return '<details class="preview-section"' + open + '>' +
      '<summary><span class="preview-title">' + escapeHtml(section.title || section.id) + '</span>' +
      '<span class="preview-meta">' + escapeHtml(label + t("inspector.sectionMeta", { chars: formatCount(section.chars), tokens: formatCount(section.approxTokens) })) + '</span>' +
      '<button class="preview-copy" data-copy-index="' + attr(index + 1) + '" data-icon="□" title="' + attr(t("inspector.copySectionTitle")) + '" onclick="event.preventDefault()">' + escapeHtml(t("inspector.copy")) + '</button></summary>' +
      '<pre class="preview-text">' + escapeHtml(section.content || "") + '</pre>' +
      '</details>';
  }).join("");

  pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="' + attr(t("inspector.previewAria")) + '">' +
    '<div class="preview-head"><div><div class="preview-title">' + escapeHtml(t("inspector.previewTitleId", { id: preview.stackId || selectedId() })) + '</div>' +
    '<div class="preview-meta">' + escapeHtml(t("inspector.previewMeta", { chars: formatCount(preview.totalChars), tokens: formatCount(preview.approxTokens), count: (preview.messages || []).length })) + '</div></div>' +
    '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="' + attr(t("inspector.copyFullPromptTitle")) + '">' + escapeHtml(t("inspector.copyFull")) + '</button><button data-preview-close="true" data-icon="×" title="' + attr(t("inspector.closePreview")) + '">' + escapeHtml(t("modal.close")) + '</button></div></div>' +
    '<div class="preview-body">' + sectionHtml + '</div></div>';
  pane.classList.add("open");
}

function renderPayloadInspector(snapshot: any) {
  const pane = el("preview");
  if (snapshot.status === "idle") {
    previewCopyTexts = [];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="' + attr(t("inspector.payloadTitle")) + '">' +
      '<div class="preview-head"><div><div class="preview-title">' + escapeHtml(t("inspector.payloadTitle")) + '</div><div class="preview-meta">' + escapeHtml(t("inspector.noPayload")) + '</div></div>' +
      '<div class="preview-actions"><button data-payload-arm="true" data-icon="◆" title="' + attr(t("inspector.armNextTitle")) + '">' + escapeHtml(t("inspector.armNext")) + '</button><button data-preview-close="true" data-icon="×" title="' + attr(t("inspector.closePayload")) + '">' + escapeHtml(t("modal.close")) + '</button></div></div>' +
      '<div class="preview-body"><div class="empty">' + escapeHtml(t("inspector.armEmptyBody")) + '</div></div></div>';
    pane.classList.add("open");
    return;
  }

  if (snapshot.status === "armed") {
    const meta = snapshot.armedAt ? t("inspector.armedAt", { time: snapshot.armedAt }) : t("inspector.armedWaiting");
    previewCopyTexts = [];
    pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="' + attr(t("inspector.payloadTitle")) + '">' +
      '<div class="preview-head"><div><div class="preview-title">' + escapeHtml(t("inspector.armedTitle")) + '</div><div class="preview-meta">' + escapeHtml(meta) + '</div></div>' +
      '<div class="preview-actions"><button class="danger" data-payload-clear="true" data-icon="×" title="' + attr(t("inspector.clearArmedTitle")) + '">' + escapeHtml(t("inspector.clear")) + '</button><button data-preview-close="true" data-icon="×" title="' + attr(t("inspector.closePayload")) + '">' + escapeHtml(t("modal.close")) + '</button></div></div>' +
      '<div class="preview-body"><div class="empty">' + escapeHtml(t("inspector.armedBody")) + '</div></div></div>';
    pane.classList.add("open");
    return;
  }

  const capture = snapshot.capture || {};
  const sections = payloadSections(capture);
  previewCopyTexts = [capture.text || "", ...sections.map((section: any) => section.content || "")];
  const sectionHtml = sections.map((section: any, index: any) => {
    const open = index === 0 ? " open" : "";
    return '<details class="preview-section"' + open + '>' +
      '<summary><span class="preview-title">' + escapeHtml(section.title) + '</span>' +
      '<span class="preview-meta">' + escapeHtml(section.meta) + '</span>' +
      '<button class="preview-copy" data-copy-index="' + attr(index + 1) + '" data-icon="□" title="' + attr(t("inspector.copySectionTitle")) + '" onclick="event.preventDefault()">' + escapeHtml(t("inspector.copy")) + '</button></summary>' +
      '<pre class="preview-text">' + escapeHtml(section.content || "") + '</pre>' +
      '</details>';
  }).join("");
  const metaParts = [
    t("inspector.chars", { count: formatCount(capture.chars) }),
    "~" + formatCount(capture.approxTokens) + " tokens",
    capture.stackId ? t("inspector.stackId", { id: capture.stackId }) : undefined,
    capture.truncated ? t("inspector.truncated") : undefined,
  ].filter(Boolean);
  pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="' + attr(t("inspector.payloadTitle")) + '">' +
    '<div class="preview-head"><div><div class="preview-title">' + escapeHtml(t("inspector.payloadTitle")) + '</div>' +
    '<div class="preview-meta">' + escapeHtml(metaParts.join(" · ") + (capture.capturedAt ? " · " + capture.capturedAt : "")) + '</div></div>' +
    '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="' + attr(t("inspector.copyPayloadTitle")) + '">' + escapeHtml(t("inspector.copyFull")) + '</button><button data-payload-arm="true" data-icon="◆" title="' + attr(t("inspector.armNextTitle")) + '">' + escapeHtml(t("inspector.armAgain")) + '</button><button class="danger" data-payload-clear="true" data-icon="×" title="' + attr(t("inspector.clearCapturedTitle")) + '">' + escapeHtml(t("inspector.clear")) + '</button><button data-preview-close="true" data-icon="×" title="' + attr(t("inspector.closePayload")) + '">' + escapeHtml(t("modal.close")) + '</button></div></div>' +
    '<div class="preview-body">' + sectionHtml + '</div></div>';
  pane.classList.add("open");
}

function payloadSections(capture: any) {
  const value = capture.payload;
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      return value.map((item: any, index: any) => payloadSection(String(index), item));
    }
    const entries = Object.entries(value);
    if (entries.length) return entries.map(([key, item]: any) => payloadSection(key, item));
  }
  return [{
    title: capture.error ? t("inspector.stringifyError") : capture.truncated ? t("inspector.rawTruncated") : t("inspector.rawPayload"),
    meta: t("inspector.chars", { count: formatCount((capture.text || "").length) }),
    content: capture.text || "",
  }];
}

function payloadSection(title: any, value: any) {
  const rendered = JSON.stringify(value, null, 2);
  const content = rendered === undefined ? String(value) : rendered;
  const meta = describePayloadValue(value) + " · " + t("inspector.chars", { count: formatCount(content.length) });
  return { title, meta, content };
}

function describePayloadValue(value: any) {
  if (Array.isArray(value)) return "array[" + value.length + "]";
  if (value && typeof value === "object") return "object{" + Object.keys(value).length + "}";
  if (value === null) return "null";
  return typeof value;
}

function formatCount(value: any) {
  return Number(value || 0).toLocaleString();
}

async function copyPreviewText(index: any) {
  const text = previewCopyTexts[index] || "";
  if (!text) return;
  await copyTextToClipboard(text);
  setStatus(t("inspector.copiedText"), "success");
}

async function copyTextToClipboard(text: any) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}


	return {
		validateStack,
		previewStack,
		refreshPayloadCapture,
		armPayloadCapture,
		clearPayloadCapture,
		openPayloadCapture,
		hidePreview,
		copyPreviewText,
		copyTextToClipboard,
	};
}
