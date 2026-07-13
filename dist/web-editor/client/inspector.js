import { attr, el, escapeHtml } from "./dom.js";
export function createInspector(deps) {
    const { api, stackForSubmit, renderDiagnostics, renderItemList, setStatus } = deps;
    const selectedId = deps.getSelectedId;
    let payloadSnapshot = { status: "idle" };
    let previewCopyTexts = [];
    async function validateStack() {
        const stack = stackForSubmit();
        const data = await api("/api/stacks/" + encodeURIComponent(selectedId()) + "/validate", { method: "POST", body: { stack } });
        renderDiagnostics(data.diagnostics || []);
        renderItemList();
        hidePreview();
        setStatus("Validation complete", "success");
    }
    async function previewStack() {
        const stack = stackForSubmit();
        const data = await api("/api/stacks/" + encodeURIComponent(selectedId()) + "/preview", { method: "POST", body: { stack } });
        renderDiagnostics(data.diagnostics || []);
        renderItemList();
        renderPreviewInspector(data);
        setStatus("Preview rendered", "success");
    }
    async function refreshPayloadCapture(options = {}) {
        const previousCapturedAt = payloadSnapshot.status === "captured" ? payloadSnapshot.capture?.capturedAt : "";
        const data = await api("/api/payload");
        payloadSnapshot = data;
        updatePayloadButton();
        const nextCapturedAt = payloadSnapshot.status === "captured" ? payloadSnapshot.capture?.capturedAt : "";
        if (options.open || (options.autoOpen && nextCapturedAt && nextCapturedAt !== previousCapturedAt)) {
            renderPayloadInspector(payloadSnapshot);
        }
    }
    async function armPayloadCapture(showInspector = false) {
        const data = await api("/api/payload/arm", { method: "POST" });
        payloadSnapshot = data;
        updatePayloadButton();
        setStatus("Payload capture armed; send the next Pi prompt");
        if (showInspector)
            renderPayloadInspector(payloadSnapshot);
    }
    async function clearPayloadCapture() {
        const data = await api("/api/payload", { method: "DELETE" });
        payloadSnapshot = data;
        updatePayloadButton();
        hidePreview();
        setStatus("Payload capture cleared", "success");
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
        if (!button)
            return;
        button.classList.remove("primary");
        if (payloadSnapshot.status === "armed") {
            button.textContent = "Payload armed";
            button.classList.add("primary");
            button.title = "Waiting for the next provider payload";
            return;
        }
        if (payloadSnapshot.status === "captured") {
            button.textContent = "View payload";
            button.title = "Open the latest captured provider payload";
            return;
        }
        button.textContent = "Arm payload";
        button.title = "Capture the next provider payload in this editor";
    }
    function hidePreview() {
        const pane = el("preview");
        pane.classList.remove("open");
        pane.innerHTML = "";
        previewCopyTexts = [];
    }
    function renderPreviewInspector(data) {
        const pane = el("preview");
        const preview = data.preview;
        if (!preview) {
            previewCopyTexts = [data.text || ""];
            pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Prompt preview">' +
                '<div class="preview-head"><div><div class="preview-title">Preview</div><div class="preview-meta">Plain text fallback</div></div>' +
                '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="Copy the full preview text">Copy</button><button data-preview-close="true" data-icon="×" title="Close the preview">Close</button></div></div>' +
                '<div class="preview-body"><pre class="preview-text">' + escapeHtml(data.text || "") + '</pre></div></div>';
            pane.classList.add("open");
            return;
        }
        const sections = [preview.system, ...(preview.messages || [])];
        previewCopyTexts = [data.text || "", ...sections.map((section) => section.content || "")];
        const sectionHtml = sections.map((section, index) => {
            const open = index === 0 ? " open" : "";
            const label = section.role ? section.role + " · " : "";
            return '<details class="preview-section"' + open + '>' +
                '<summary><span class="preview-title">' + escapeHtml(section.title || section.id) + '</span>' +
                '<span class="preview-meta">' + escapeHtml(label + formatCount(section.chars) + " chars · ~" + formatCount(section.approxTokens) + " tokens") + '</span>' +
                '<button class="preview-copy" data-copy-index="' + attr(index + 1) + '" data-icon="□" title="Copy this preview section" onclick="event.preventDefault()">Copy</button></summary>' +
                '<pre class="preview-text">' + escapeHtml(section.content || "") + '</pre>' +
                '</details>';
        }).join("");
        pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Prompt preview">' +
            '<div class="preview-head"><div><div class="preview-title">Prompt preview: ' + escapeHtml(preview.stackId || selectedId()) + '</div>' +
            '<div class="preview-meta">' + escapeHtml(formatCount(preview.totalChars) + " chars · ~" + formatCount(preview.approxTokens) + " tokens · " + (preview.messages || []).length + " messages") + '</div></div>' +
            '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="Copy the full prompt preview">Copy full</button><button data-preview-close="true" data-icon="×" title="Close the preview">Close</button></div></div>' +
            '<div class="preview-body">' + sectionHtml + '</div></div>';
        pane.classList.add("open");
    }
    function renderPayloadInspector(snapshot) {
        const pane = el("preview");
        if (snapshot.status === "idle") {
            previewCopyTexts = [];
            pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
                '<div class="preview-head"><div><div class="preview-title">Provider payload</div><div class="preview-meta">No payload captured.</div></div>' +
                '<div class="preview-actions"><button data-payload-arm="true" data-icon="◆" title="Capture the next provider payload">Arm next</button><button data-preview-close="true" data-icon="×" title="Close the payload inspector">Close</button></div></div>' +
                '<div class="preview-body"><div class="empty">Arm capture, then send the next prompt in Pi. The provider payload will appear here before it is sent.</div></div></div>';
            pane.classList.add("open");
            return;
        }
        if (snapshot.status === "armed") {
            const meta = snapshot.armedAt ? "Armed at " + snapshot.armedAt : "Waiting for next provider request";
            previewCopyTexts = [];
            pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
                '<div class="preview-head"><div><div class="preview-title">Payload capture armed</div><div class="preview-meta">' + escapeHtml(meta) + '</div></div>' +
                '<div class="preview-actions"><button class="danger" data-payload-clear="true" data-icon="×" title="Clear the armed payload capture">Clear</button><button data-preview-close="true" data-icon="×" title="Close the payload inspector">Close</button></div></div>' +
                '<div class="preview-body"><div class="empty">Send the next prompt in Pi. The exact provider payload will be captured here and redacted before display.</div></div></div>';
            pane.classList.add("open");
            return;
        }
        const capture = snapshot.capture || {};
        const sections = payloadSections(capture);
        previewCopyTexts = [capture.text || "", ...sections.map((section) => section.content || "")];
        const sectionHtml = sections.map((section, index) => {
            const open = index === 0 ? " open" : "";
            return '<details class="preview-section"' + open + '>' +
                '<summary><span class="preview-title">' + escapeHtml(section.title) + '</span>' +
                '<span class="preview-meta">' + escapeHtml(section.meta) + '</span>' +
                '<button class="preview-copy" data-copy-index="' + attr(index + 1) + '" data-icon="□" title="Copy this payload section" onclick="event.preventDefault()">Copy</button></summary>' +
                '<pre class="preview-text">' + escapeHtml(section.content || "") + '</pre>' +
                '</details>';
        }).join("");
        const metaParts = [
            formatCount(capture.chars) + " chars",
            "~" + formatCount(capture.approxTokens) + " tokens",
            capture.stackId ? "stack " + capture.stackId : undefined,
            capture.truncated ? "truncated" : undefined,
        ].filter(Boolean);
        pane.innerHTML = '<div class="preview-dialog" role="dialog" aria-modal="true" aria-label="Provider payload capture">' +
            '<div class="preview-head"><div><div class="preview-title">Provider payload</div>' +
            '<div class="preview-meta">' + escapeHtml(metaParts.join(" · ") + (capture.capturedAt ? " · " + capture.capturedAt : "")) + '</div></div>' +
            '<div class="preview-actions"><button class="preview-copy" data-copy-index="0" data-icon="□" title="Copy the full redacted payload">Copy full</button><button data-payload-arm="true" data-icon="◆" title="Capture the next provider payload">Arm again</button><button class="danger" data-payload-clear="true" data-icon="×" title="Clear the captured payload">Clear</button><button data-preview-close="true" data-icon="×" title="Close the payload inspector">Close</button></div></div>' +
            '<div class="preview-body">' + sectionHtml + '</div></div>';
        pane.classList.add("open");
    }
    function payloadSections(capture) {
        const value = capture.payload;
        if (value && typeof value === "object") {
            if (Array.isArray(value)) {
                return value.map((item, index) => payloadSection(String(index), item));
            }
            const entries = Object.entries(value);
            if (entries.length)
                return entries.map(([key, item]) => payloadSection(key, item));
        }
        return [{
                title: capture.error ? "Stringify error" : capture.truncated ? "Raw truncated payload" : "Raw payload",
                meta: formatCount((capture.text || "").length) + " chars",
                content: capture.text || "",
            }];
    }
    function payloadSection(title, value) {
        const rendered = JSON.stringify(value, null, 2);
        const content = rendered === undefined ? String(value) : rendered;
        const meta = describePayloadValue(value) + " · " + formatCount(content.length) + " chars";
        return { title, meta, content };
    }
    function describePayloadValue(value) {
        if (Array.isArray(value))
            return "array[" + value.length + "]";
        if (value && typeof value === "object")
            return "object{" + Object.keys(value).length + "}";
        if (value === null)
            return "null";
        return typeof value;
    }
    function formatCount(value) {
        return Number(value || 0).toLocaleString();
    }
    async function copyPreviewText(index) {
        const text = previewCopyTexts[index] || "";
        if (!text)
            return;
        await copyTextToClipboard(text);
        setStatus("Copied text", "success");
    }
    async function copyTextToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        }
        else {
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
//# sourceMappingURL=inspector.js.map