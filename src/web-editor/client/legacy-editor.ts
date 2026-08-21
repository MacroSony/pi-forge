// Temporary behavior-preserving bridge while the stack editor is migrated to Vue components.
import { createEditorApi, EditorApiError } from "./api.ts";
import { attr, el, escapeHtml, eventElement, query, queryAll, type EditorElement } from "./dom.ts";
import { createInspector } from "./inspector.ts";
import { createVueItemHost } from "./vue-item-host.ts";
import { createVueMetadataHost } from "./vue-metadata-host.ts";
import { applyEditorTheme, editorTheme } from "./theme.ts";
import { createVueTabHost } from "./vue-tab-host.ts";
import { activateEditorView, currentEditorView, subscribeEditorView } from "./editor-view-coordinator.ts";
import type {
  EditorPromptStack,
  PromptStackDiagnostic,
  WebEditorPolicyResource,
  WebEditorStackSummary,
} from "./types.ts";

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);
let stacks: WebEditorStackSummary[] = [];
let cwd = "";
let selectedId = "";
let currentStack: EditorPromptStack | null = null;
let currentFilePath = "";
let selectedItemIndex = -1;
let dirty = false;
let dragIndex = -1;
let dragDropIndex = -1;
let dragScrollFrame = 0;
let dragScrollSpeed = 0;
let dragClientY = 0;
let sidebarCollapsed = false;
let policyResources: { tools: WebEditorPolicyResource[]; skills: WebEditorPolicyResource[] } = { tools: [], skills: [] };
let latestDiagnostics: PromptStackDiagnostic[] = [];
// null = automatic: expand when errors or warnings exist, collapse when clean.
let diagnosticsCollapsed: boolean | null = null;
let activeTab: "items" | "regex" | "policy" | "stack" = "items";
let metadataCollapsed = true;
let editorStarted = false;
let editorIsActive = () => true;
const draftListeners = new Set<() => void>();

export interface LegacyEditorDraft {
  selector: string;
  stack: EditorPromptStack;
}

export function getLegacyEditorDraft(): LegacyEditorDraft | undefined {
  if (!currentStack || !selectedId) return undefined;
  return { selector: selectedId, stack: structuredClone(currentStack) };
}

export function subscribeLegacyEditorDraft(listener: () => void): () => void {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
}

function notifyDraftChanged() {
  for (const listener of [...draftListeners]) listener();
}

const slotNames = [
  "chat-history", "tools", "tool-guidelines", "skills", "project-context",
  "append-system-prompt", "date", "cwd", "date-cwd",
  "active-model", "pi-docs"
];
const roles = ["", "system", "user", "assistant", "custom"];

const {
  validateStack,
  previewStack,
  refreshPayloadCapture,
  armPayloadCapture,
  clearPayloadCapture,
  openPayloadCapture,
  hidePreview,
  copyPreviewText,
  copyTextToClipboard,
} = createInspector({
  api,
  getSelectedId: () => selectedId,
  stackForSubmit,
  renderDiagnostics,
  renderItemList,
  setStatus,
});
const vueTabHost = createVueTabHost({
  getStack: () => currentStack,
  getResources: () => policyResources,
  markDirty,
  setStatus,
  validateStack: () => run(validateStack),
  applyStack: applyStackFromVue,
  copyText: copyTextToClipboard,
});
const vueMetadataHost = createVueMetadataHost({
  getStack: () => currentStack,
  getFilePath: () => currentFilePath,
  getCollapsed: () => metadataCollapsed,
  setCollapsed: (collapsed) => {
    metadataCollapsed = collapsed;
  },
  markDirty,
  setStatus,
});
const vueItemHost = createVueItemHost({
  getStack: () => currentStack,
  getSelectedIndex: () => selectedItemIndex,
  slotNames,
  roles,
  markDirty,
  renderItemList,
  setStatus,
});

function setStatus(text: string, tone: any = "") {
  el("status").textContent = text;
  el("status").style.color = tone === "error" ? "var(--error)" : tone === "success" ? "var(--success)" : "var(--muted)";
}

function markDirty() {
  dirty = true;
  renderDirtyState();
  setStatus("Unsaved changes");
  notifyDraftChanged();
}

function renderDirtyState() {
  const badge = el("dirtyBadge");
  if (!badge) return;
  badge.classList.toggle("visible", dirty);
  updateActionState();
}

function updateActionState() {
  const hasStack = !!currentStack;
  for (const id of ["activateBtn", "saveBtn", "validateBtn", "previewBtn", "forkBtn", "exportBtn", "deleteStackBtn", "addItemBtn", "addSlotBtn"]) {
    const button = el(id);
    if (button) button.disabled = !hasStack;
  }
  const deleteItemButton = el("deleteItemBtn");
  if (deleteItemButton) deleteItemButton.disabled = !hasStack || selectedItemIndex < 0;
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.disabled = !hasStack;
  });
}

async function loadStacks(preferId: any = selectedId) {
  const [data, resources] = await Promise.all([
    api("/api/stacks"),
    api("/api/resources"),
  ]);
  if (!editorStarted) return;
  stacks = data.stacks || [];
  policyResources = normalizePolicyResources(resources);
  cwd = data.cwd || "";
  el("cwd").textContent = cwd;
  renderStackList();
  const next = stacks.find((stack: any) => (stack.selector || stack.id) === preferId) || stacks.find((stack: any) => stack.active) || stacks[0];
  if (next) await selectStack(next.selector || next.id, { keepDirty: false });
  else renderEmpty();
}

async function refreshStackRuntimeState() {
  const [data, resources] = await Promise.all([
    api("/api/stacks"),
    api("/api/resources"),
  ]);
  if (!editorStarted) return;
  stacks = data.stacks || [];
  policyResources = normalizePolicyResources(resources);
  cwd = data.cwd || "";
  el("cwd").textContent = cwd;
  renderStackList();
  updateActionState();
  if (activeTab === "policy") renderActiveTab();
}

function handleProfileApplied() {
  run(refreshStackRuntimeState);
}

async function selectStack(id: any, options: any = {}) {
  if (dirty && !options.keepDirty && !confirm("Discard unsaved changes?")) return;
  const data = await api("/api/stacks/" + encodeURIComponent(id));
  if (!editorStarted) return;
  selectedId = id;
  const loadedStack = structuredClone(data.stack) as EditorPromptStack;
  currentStack = loadedStack;
  currentFilePath = data.filePath || "";
  selectedItemIndex = loadedStack.items.length ? 0 : -1;
  dirty = false;
  vueTabHost.resetErrors();
  vueItemHost.reset();
  renderDirtyState();
  renderAll(data.diagnostics || []);
  setStatus("Loaded " + loadedStack.id);
  notifyDraftChanged();
}

function renderAll(diagnostics: any = []) {
  latestDiagnostics = diagnostics;
  renderStackList();
  renderSettings();
  renderActiveTab();
  renderDiagnostics(diagnostics);
  hidePreview();
  updateActionState();
}

function renderActiveTab() {
  if (currentEditorView() === "preview") {
    renderItemList();
    renderItemEditor();
    return;
  }
  vueTabHost.unmount();
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.classList.toggle("active", button.dataset.tab === activeTab);
  });
  const workspace = el("workspace");
  const panel = el("tabPanel");
  if (activeTab === "items") {
    workspace.style.display = "";
    panel.classList.remove("open");
    panel.innerHTML = "";
    renderItemList();
    renderItemEditor();
    return;
  }
  workspace.style.display = "none";
  panel.classList.add("open");
  if (activeTab === "regex") vueTabHost.mountRegex(panel);
  else if (activeTab === "policy") vueTabHost.mountPolicy(panel);
  else if (activeTab === "stack") vueTabHost.mountStack(panel);
}

function renderStackList() {
  const list = el("stackList");
  list.innerHTML = "";
  if (!stacks.length) {
    list.innerHTML = '<div class="side-empty">No prompt stacks in this project.</div>';
    return;
  }
  for (const stack of stacks) {
    const row = document.createElement("button");
    row.className = "stack-row" + (stack.active ? " active" : "") + ((stack.selector || stack.id) === selectedId ? " selected" : "");
    const diag = stack.errors ? '<span class="badge error">' + stack.errors + ' error</span>' : stack.warnings ? '<span class="badge warning">' + stack.warnings + ' warning</span>' : "";
    const scopeBadge = stack.scope === "global" ? '<span class="badge">global</span>' : '';
    row.innerHTML = '<div class="stack-name">' + escapeHtml(stack.id) + (stack.active ? '<span class="badge">active</span>' : '') + scopeBadge + diag + '</div>' +
      '<div class="stack-meta">' + escapeHtml(stack.name || "(unnamed)") + '</div>' +
      '<div class="stack-meta">' + stack.itemCount + ' items | ' + escapeHtml(stack.mode || "replace") + '</div>';
    row.onclick = () => selectStack(stack.selector || stack.id);
    list.appendChild(row);
  }
}

function normalizePolicyResources(value: any) {
  return {
    tools: normalizeResourceList(value?.tools),
    skills: normalizeResourceList(value?.skills),
  };
}

function normalizeResourceList(value: any) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((resource: any) => resource && typeof resource === "object" && typeof resource.name === "string" && resource.name.trim())
    .map((resource: any) => ({
      name: resource.name.trim(),
      description: typeof resource.description === "string" ? resource.description : "",
      source: typeof resource.source === "string" ? resource.source : "",
      active: resource.active === true,
      hidden: resource.hidden === true,
    }));
}

function renderSettings() {
  if (!currentStack) {
    vueMetadataHost.unmount();
    return;
  }
  el("metadataPanel").style.display = "";
  vueMetadataHost.mount(el("metadataHost"));
}

function renderItemList() {
  const list = el("itemList");
  list.innerHTML = "";
  list.classList.toggle("drag-active", dragIndex !== -1);
  if (!currentStack) return;
  el("itemCount").textContent = currentStack.items.length + " total";
  list.ondragover = handleItemListDragOver;
  list.ondrop = handleItemListDrop;
  const diagnosticsByItem = diagnosticsForItems();
  currentStack.items.forEach((item: any, index: any) => {
    const row = document.createElement("div");
    row.className = "item-row" + (index === selectedItemIndex ? " selected" : "") + (item.enabled === false ? " disabled" : "");
    row.dataset.itemIndex = String(index);
    row.draggable = true;
    const enabled = item.enabled !== false;
    const itemDiagnostics = diagnosticsByItem[item.id] || [];
    const errors = itemDiagnostics.filter((diag: any) => diag.level === "error").length;
    const warnings = itemDiagnostics.filter((diag: any) => diag.level === "warning").length;
    const diagBadge = errors
      ? '<span class="item-badge error" title="' + attr(diagnosticTitle(itemDiagnostics)) + '">' + errors + 'E</span>'
      : warnings
        ? '<span class="item-badge warning" title="' + attr(diagnosticTitle(itemDiagnostics)) + '">' + warnings + 'W</span>'
        : "";
    row.innerHTML = '<div class="drag-handle" title="Drag to reorder">≡</div>' +
      '<div><div class="item-title">' + escapeHtml(displayItemName(item)) + diagBadge + '</div>' +
      '<div class="item-meta">' + escapeHtml(item.kind) + ' | id: ' + escapeHtml(item.id) + (item.role ? " | " + escapeHtml(item.role) : "") + (item.kind === "slot" ? " | " + escapeHtml(item.slot || "") : "") + '</div></div>' +
      '<button type="button" class="item-toggle ' + (enabled ? "enabled" : "disabled") + '" title="Toggle item">' + (enabled ? "On" : "Off") + '</button>';
    row.onclick = (event: any) => {
      if (event.target?.classList?.contains("item-toggle")) return;
      selectedItemIndex = index;
      renderItemList();
      renderItemEditor();
    };
    query<EditorElement>(row, ".item-toggle")!.onclick = (event: any) => {
      event.stopPropagation();
      item.enabled = item.enabled === false;
      selectedItemIndex = index;
      markDirty();
      renderItemList();
      renderItemEditor();
    };
    row.ondragstart = (event: any) => {
      dragIndex = index;
      dragDropIndex = index;
      row.classList.add("dragging");
      list.classList.add("drag-active");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", item.id || String(index));
      }
      updateItemDropIndicator();
    };
    row.ondragend = finishItemDrag;
    row.ondragover = handleItemListDragOver;
    row.ondrop = handleItemListDrop;
    list.appendChild(row);
  });
  updateItemDropIndicator();
}

function handleItemListDragOver(event: any) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dragClientY = event.clientY;
  updateItemDragAutoScroll(event.clientY);
  setItemDropIndex(dropIndexFromClientY(event.clientY));
}

function handleItemListDrop(event: any) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dropDraggedItem();
}

function dropDraggedItem() {
  if (!currentStack || dragIndex < 0 || dragIndex >= currentStack.items.length) {
    finishItemDrag();
    return;
  }
  let insertIndex = dragDropIndex;
  if (insertIndex < 0) insertIndex = dragIndex;
  insertIndex = Math.max(0, Math.min(insertIndex, currentStack.items.length));
  const [moved] = currentStack.items.splice(dragIndex, 1);
  if (!moved) {
    finishItemDrag();
    return;
  }
  if (dragIndex < insertIndex) insertIndex--;
  insertIndex = Math.max(0, Math.min(insertIndex, currentStack.items.length));
  currentStack.items.splice(insertIndex, 0, moved);
  selectedItemIndex = insertIndex;
  const changed = dragIndex !== insertIndex;
  finishItemDrag(false);
  if (changed) markDirty();
  renderItemList();
  renderItemEditor();
}

function setItemDropIndex(index: any) {
  if (!currentStack) return;
  const next = Math.max(0, Math.min(index, currentStack.items.length));
  if (dragDropIndex === next) return;
  dragDropIndex = next;
  updateItemDropIndicator();
}

function dropIndexFromClientY(clientY: any) {
  const list = el("itemList");
  const rows = [...queryAll<HTMLElement>(list, ".item-row")];
  if (!rows.length) return 0;
  const listRect = list.getBoundingClientRect();
  if (clientY <= listRect.top) return 0;
  if (clientY >= listRect.bottom) return rows.length;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const index = Number(row.dataset.itemIndex);
    if (clientY < rect.top + rect.height / 2) return index;
  }
  return rows.length;
}

function updateItemDropIndicator() {
  const list = el("itemList");
  const rows = [...list.querySelectorAll(".item-row")];
  for (const row of rows) row.classList.remove("drop-before", "drop-after");
  list.classList.toggle("drag-active", dragIndex !== -1);
  if (dragIndex === -1 || dragDropIndex === -1 || !rows.length) return;
  if (dragDropIndex <= 0) rows[0].classList.add("drop-before");
  else if (dragDropIndex >= rows.length) rows[rows.length - 1].classList.add("drop-after");
  else rows[dragDropIndex].classList.add("drop-before");
}

function updateItemDragAutoScroll(clientY: any) {
  const list = el("itemList");
  const rect = list.getBoundingClientRect();
  const edge = Math.min(72, Math.max(36, rect.height / 5));
  let speed = 0;
  if (clientY < rect.top) speed = -Math.min(30, 8 + (rect.top - clientY) / 3);
  else if (clientY < rect.top + edge) speed = -Math.min(22, (rect.top + edge - clientY) / 3);
  else if (clientY > rect.bottom) speed = Math.min(30, 8 + (clientY - rect.bottom) / 3);
  else if (clientY > rect.bottom - edge) speed = Math.min(22, (clientY - (rect.bottom - edge)) / 3);
  dragScrollSpeed = speed;
  if (speed !== 0 && !dragScrollFrame) dragScrollFrame = requestAnimationFrame(runItemDragAutoScroll);
}

function runItemDragAutoScroll() {
  dragScrollFrame = 0;
  if (dragIndex === -1 || dragScrollSpeed === 0) return;
  const list = el("itemList");
  list.scrollTop += dragScrollSpeed;
  setItemDropIndex(dropIndexFromClientY(dragClientY));
  dragScrollFrame = requestAnimationFrame(runItemDragAutoScroll);
}

function finishItemDrag(clearIndicator: any = true) {
  dragIndex = -1;
  dragDropIndex = -1;
  dragScrollSpeed = 0;
  dragClientY = 0;
  if (dragScrollFrame) {
    cancelAnimationFrame(dragScrollFrame);
    dragScrollFrame = 0;
  }
  if (clearIndicator) updateItemDropIndicator();
}

function handleDocumentItemDragOver(event: any) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dragClientY = event.clientY;
  updateItemDragAutoScroll(event.clientY);
  setItemDropIndex(dropIndexFromClientY(event.clientY));
}

function handleDocumentItemDrop(event: any) {
  if (dragIndex === -1 || !currentStack) return;
  event.preventDefault();
  dropDraggedItem();
}

function diagnosticsForItems(): Record<string, PromptStackDiagnostic[]> {
  const grouped: Record<string, PromptStackDiagnostic[]> = {};
  for (const diagnostic of latestDiagnostics || []) {
    if (!diagnostic.itemId) continue;
    if (!grouped[diagnostic.itemId]) grouped[diagnostic.itemId] = [];
    grouped[diagnostic.itemId].push(diagnostic);
  }
  return grouped;
}

function diagnosticTitle(diagnostics: any) {
  return diagnostics.map((diag: any) => (diag.level || "info").toUpperCase() + ": " + (diag.message || "")).join("\n");
}

function renderItemEditor() {
  const editor = el("itemEditor");
  if (!vueItemHost.mount(editor)) {
    editor.innerHTML = '<div class="empty">No item selected.</div>';
    el("deleteItemBtn").disabled = true;
    return;
  }
  el("deleteItemBtn").disabled = false;
}

function showStackModal(title: any, meta: any, body: any, options: any = {}) {
  const pane = el("stackModal");
  pane.innerHTML = '<div class="modal-dialog" role="dialog" aria-modal="true" aria-label="' + attr(title) + '">' +
    '<div class="modal-head"><div><div class="modal-title">' + escapeHtml(title) + '</div><div class="modal-meta">' + escapeHtml(meta || "") + '</div></div>' +
    '<div class="modal-actions"><button data-modal-close="true" data-icon="×" title="Close this dialog">Close</button></div></div>' +
    '<div class="modal-body ' + attr(options.bodyClass || "") + '">' + body + '</div></div>';
  pane.classList.add("open");
}

function closeStackModal() {
  const pane = el("stackModal");
  pane.classList.remove("open");
  pane.innerHTML = "";
}

function applyStackFromVue(stack: EditorPromptStack) {
  currentStack = stack;
  if (!stack.schemaVersion) stack.schemaVersion = 1;
  if (!stack.type) stack.type = "pi-forge.prompt-stack";
  selectedItemIndex = stack.items.length ? Math.min(Math.max(selectedItemIndex, 0), stack.items.length - 1) : -1;
  vueItemHost.reset();
  vueTabHost.resetErrors();
  markDirty();
  renderAll(latestDiagnostics);
  setStatus("Applied stack JSON to editor", "success");
}

function addItem(kind: any) {
  if (!currentStack) return;
  const id = nextNumericItemId();
  const insertIndex = selectedItemIndex >= 0 && selectedItemIndex < currentStack.items.length
    ? selectedItemIndex + 1
    : currentStack.items.length;
  currentStack.items.splice(insertIndex, 0, kind === "slot"
    ? { kind: "slot", id, enabled: true, slot: "chat-history" }
    : { kind: "block", id, enabled: true, role: "user", content: "" });
  selectedItemIndex = insertIndex;
  markDirty();
  renderItemList();
  renderItemEditor();
}

function nextNumericItemId() {
  const existing = new Set((currentStack?.items || []).map((item: any) => String(item.id)));
  let index = 1;
  while (existing.has(String(index))) index++;
  return String(index);
}

function deleteSelectedItem() {
  if (!currentStack || selectedItemIndex < 0) return;
  const item = currentStack.items[selectedItemIndex];
  if (!confirm("Delete item " + item.id + "?")) return;
  currentStack.items.splice(selectedItemIndex, 1);
  selectedItemIndex = Math.min(selectedItemIndex, currentStack.items.length - 1);
  markDirty();
  renderItemList();
  renderItemEditor();
}

async function saveStack() {
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId), { method: "PUT", body: { stack } });
  stacks = data.stacks || stacks;
  selectedId = data.stack?.selector || data.stack?.id || stack.id;
  currentStack = structuredClone(stack);
  dirty = false;
  renderDirtyState();
  renderAll(data.stack?.diagnostics || []);
  setStatus("Saved " + selectedId, "success");
  await selectStack(selectedId, { keepDirty: true });
}

async function createStackRemote(stack: any, options: any = {}) {
  try {
    return await api("/api/stacks", { method: "POST", body: { stack, ...options } });
  } catch (error) {
    if (error instanceof EditorApiError && error.status === 409 && !options.overwrite && confirm((error.message || "Stack already exists.") + "\n\nOverwrite it?")) {
      return await api("/api/stacks", { method: "POST", body: { stack, ...options, overwrite: true } });
    }
    throw error;
  }
}

function chooseCreateScope(): "global" | "project" {
  const select = el("stackCreateScope") as HTMLSelectElement | null;
  return select?.value === "global" ? "global" : "project";
}

async function createAndOpenStack(stack: any, activate: any, actionLabel: any, extraOptions: any = {}) {
  const data = await createStackRemote(stack, { ...extraOptions, activate });
  stacks = data.stacks || stacks;
  selectedId = data.stack?.selector || data.stack?.id || stack.id;
  dirty = false;
  renderDirtyState();
  await selectStack(selectedId, { keepDirty: true });
  const displayId = data.stack?.id || stack.id;
  setStatus(actionLabel + " " + displayId, "success");
}

async function createNewStack() {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const promptedId = prompt("New stack id", uniqueStackId("new-stack"));
  if (promptedId === null) return;
  const id = sanitizeStackId(promptedId);
  if (!id) throw new Error("Stack id must not be empty.");
  if (id !== promptedId.trim() && !confirm("Use stack id '" + id + "'?")) return;
  const promptedName = prompt("Stack display name", "Default Pi Prompt Mirror");
  if (promptedName === null) return;
  const stack = defaultNewStack(id, promptedName.trim() || id);
  const scope = chooseCreateScope();
  const activate = stacks.length === 0 || confirm("Activate new stack now?");
  await createAndOpenStack(stack, activate, "Created", { scope });
}

function defaultNewStack(id: any, name: any) {
  return {
    schemaVersion: 1,
    type: "pi-forge.prompt-stack",
    id,
    name,
    description: "Recreates Pi's built-in prompt layout with pi-forge slots, exposing tools, guidelines, docs, append-system-prompt, project context, skills, date/cwd, and chat history as movable pieces.",
    autoActivate: stacks.length === 0,
    mode: "replace",
    defaults: {
      syntheticMessagesVisible: false,
      unresolvedMacroPolicy: "warn",
    },
    context: {
      allowDuplicateChatHistory: false,
    },
    tools: {
      allow: ["*"],
    },
    skills: {
      allow: ["*"],
    },
    items: [
      {
        kind: "block",
        id: "main-role",
        name: "Pi Default Role",
        enabled: true,
        role: "system",
        source: {
          package: "@earendil-works/pi-coding-agent",
          file: "dist/core/system-prompt.js",
        },
        content: "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
      },
      {
        kind: "slot",
        id: "tools",
        name: "Available Tools",
        enabled: true,
        role: "system",
        slot: "tools",
        options: {
          format: "plain",
          onlyWithSnippets: true,
        },
      },
      {
        kind: "block",
        id: "custom-tools-note",
        name: "Custom Tools Note",
        enabled: true,
        role: "system",
        content: "In addition to the tools above, you may have access to other custom tools depending on the project.",
      },
      {
        kind: "slot",
        id: "tool-guidelines",
        name: "Guidelines",
        enabled: true,
        role: "system",
        slot: "tool-guidelines",
        options: {
          format: "plain",
          heading: "Guidelines:",
          includePiDefaultGuidelines: true,
          piStyle: true,
        },
      },
      {
        kind: "slot",
        id: "pi-docs",
        name: "Pi Documentation Guidance",
        enabled: true,
        role: "system",
        slot: "pi-docs",
      },
      {
        kind: "slot",
        id: "append-system-prompt",
        name: "User Append System Prompt",
        enabled: true,
        role: "system",
        slot: "append-system-prompt",
      },
      {
        kind: "slot",
        id: "project-context",
        name: "Project Context",
        enabled: true,
        role: "system",
        slot: "project-context",
      },
      {
        kind: "slot",
        id: "skills",
        name: "Available Skills",
        enabled: true,
        role: "system",
        slot: "skills",
        options: {
          requireReadTool: true,
        },
      },
      {
        kind: "slot",
        id: "date-cwd",
        name: "Date and Working Directory",
        enabled: true,
        role: "system",
        slot: "date-cwd",
      },
      {
        kind: "slot",
        id: "chat-history",
        name: "Chat History",
        enabled: true,
        slot: "chat-history",
      },
    ],
  };
}

async function importStackJson() {
  el("importFileInput").value = "";
  el("importFileInput").click();
}

async function handleImportFile(event: any) {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const imported = JSON.parse(text);
  if (!imported || typeof imported !== "object" || Array.isArray(imported)) throw new Error("Imported JSON must be an object.");
  const stack = imported;
  if (!stack.id || typeof stack.id !== "string") {
    const promptedId = prompt("Stack id", sanitizeStackId(file.name.replace(/\.json$/i, "")));
    if (!promptedId) return;
    stack.id = promptedId.trim();
  }
  if (!Array.isArray(stack.items)) throw new Error("Imported stack must contain an items array.");
  if (!stack.schemaVersion) stack.schemaVersion = 1;
  if (!stack.type) stack.type = "pi-forge.prompt-stack";
  const scope = chooseCreateScope();
  const activate = confirm("Activate imported stack now?");
  await createAndOpenStack(stack, activate, "Imported", { scope });
}

async function forkStack() {
  const source = stackForSubmit();
  const forkId = prompt("New fork stack id", uniqueForkId(source.id || "stack"));
  if (!forkId) return;
  const forkName = prompt("Fork display name", ((source.name || source.id || "Prompt stack") + " fork"));
  const fork = structuredClone(source);
  fork.id = forkId.trim();
  if (forkName && forkName.trim()) fork.name = forkName;
  fork.autoActivate = false;
  const scope = chooseCreateScope();
  const activate = confirm("Activate fork now?");
  await createAndOpenStack(fork, activate, "Forked", { scope });
}

async function exportStackJson() {
  const stack = stackForSubmit();
  const json = JSON.stringify(stack, null, 2) + "\n";
  const downloaded = downloadTextFile(sanitizeStackId(stack.id || "prompt-stack") + ".json", json, "application/json");
  if (downloaded) {
    setStatus("Exported " + (stack.id || "prompt stack"), "success");
    return;
  }
  await copyTextToClipboard(json);
  setStatus("Copied " + (stack.id || "prompt stack") + " JSON", "success");
}

function downloadTextFile(filename: any, text: any, type: any) {
  if (typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return false;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  if (!("download" in link)) {
    URL.revokeObjectURL(url);
    return false;
  }
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

function uniqueForkId(baseId: any) {
  const base = sanitizeStackId(baseId || "stack") || "stack";
  const existing = new Set(stacks.map((stack: any) => stack.id));
  let candidate = base + "-fork";
  let index = 2;
  while (existing.has(candidate)) candidate = base + "-fork-" + index++;
  return candidate;
}

function uniqueStackId(baseId: any) {
  const base = sanitizeStackId(baseId || "stack") || "stack";
  const existing = new Set(stacks.map((stack: any) => stack.id));
  let candidate = base;
  let index = 2;
  while (existing.has(candidate)) candidate = base + "-" + index++;
  return candidate;
}

function sanitizeStackId(value: any) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

async function activateStack() {
  if (!currentStack) return;
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId) + "/activate", { method: "POST" });
  stacks = data.stacks || stacks;
  renderStackList();
  setStatus("Activated " + selectedId, "success");
}

async function disableStacks() {
  const data = await api("/api/disable", { method: "POST" });
  stacks = data.stacks || stacks;
  renderStackList();
  setStatus("Prompt stack disabled", "success");
}

async function deleteCurrentStack() {
  if (!currentStack) return;
  const routeId = selectedId;
  const displayId = currentStack.id;
  const message = "Delete prompt stack '" + displayId + "'?\n\nThis removes its JSON file from prompt-stack storage.";
  if (!confirm(message)) return;
  const data = await api("/api/stacks/" + encodeURIComponent(routeId), { method: "DELETE" });
  stacks = data.stacks || [];
  dirty = false;
  renderDirtyState();
  const next = stacks.find((stack: any) => stack.active) || stacks[0];
  if (next) {
    await selectStack(next.selector || next.id, { keepDirty: true });
    setStatus("Deleted " + displayId, "success");
  } else {
    renderStackList();
    renderEmpty();
    setStatus("Deleted " + displayId + "; no stacks remain", "success");
  }
}

async function reloadFromDisk() {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  const data = await api("/api/reload", { method: "POST" });
  stacks = data.stacks || [];
  renderStackList();
  await loadStacks(selectedId);
  setStatus("Reloaded from disk", "success");
}

function stackForSubmit() {
  if (!currentStack) throw new Error("No stack selected.");
  const itemOptionsError = vueItemHost.getError();
  if (itemOptionsError) throw new Error("Invalid item options JSON: " + itemOptionsError);
  const stackError = vueTabHost.getError("stack");
  if (stackError) throw new Error(stackError);
  const regexError = vueTabHost.getError("regex");
  if (regexError) throw new Error(regexError);
  const policyError = vueTabHost.getError("policy");
  if (policyError) throw new Error(policyError);
  const clone = structuredClone(currentStack);
  if (!clone.type) clone.type = "pi-forge.prompt-stack";
  if (!clone.schemaVersion) clone.schemaVersion = 1;
  return clone;
}

function renderDiagnostics(diagnostics: any) {
  latestDiagnostics = diagnostics || [];
  const errors = latestDiagnostics.filter((diag: any) => (diag.level || "info") === "error").length;
  const warnings = latestDiagnostics.filter((diag: any) => diag.level === "warning").length;
  const collapsed = diagnosticsCollapsed ?? (errors === 0 && warnings === 0);
  const summary = !latestDiagnostics.length
    ? "none"
    : [
      errors ? errors + " error" + (errors === 1 ? "" : "s") : "",
      warnings ? warnings + " warning" + (warnings === 1 ? "" : "s") : "",
    ].filter(Boolean).join(" · ") || latestDiagnostics.length + " note" + (latestDiagnostics.length === 1 ? "" : "s");
  const body = !latestDiagnostics.length
    ? '<div class="diagnostic info">No diagnostics.</div>'
    : latestDiagnostics.map((diag: any) => {
      const level = diag.level || "info";
      const item = diag.itemId ? " [" + escapeHtml(diag.itemId) + "]" : "";
      return '<div class="diagnostic ' + attr(level) + '"><strong>' + escapeHtml(level.toUpperCase()) + item + '</strong>: ' + escapeHtml(diag.message || "") + '</div>';
    }).join("");
  const pane = el("diagnostics");
  pane.classList.toggle("collapsed", collapsed);
  pane.innerHTML =
    '<button type="button" id="diagnosticsToggleBtn" class="diagnostics-head" aria-expanded="' + String(!collapsed) + '" title="Toggle the diagnostics panel">' +
    '<span class="diagnostics-title">Diagnostics · ' + escapeHtml(summary) + '</span>' +
    '<span class="diagnostics-chevron">▾</span>' +
    '</button>' +
    '<div class="diagnostics-body">' + body + '</div>';
  el("diagnosticsToggleBtn").onclick = () => {
    diagnosticsCollapsed = !collapsed;
    renderDiagnostics(latestDiagnostics);
  };
}

function renderEmpty() {
  vueTabHost.unmount();
  currentStack = null;
  selectedId = "";
  dirty = false;
	notifyDraftChanged();
  activeTab = "items";
  vueTabHost.resetErrors();
  renderDirtyState();
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.classList.toggle("active", button.dataset.tab === activeTab);
  });
  el("workspace").style.display = "";
  el("metadataPanel").style.display = "none";
  vueMetadataHost.unmount();
  el("itemCount").textContent = "";
  el("itemList").innerHTML = "";
  el("itemEditor").innerHTML =
    '<div class="empty">' +
    '<div class="empty-title">No prompt stacks found.</div>' +
    '<div>Create a stack in this project, or import an existing pi-forge JSON file.</div>' +
    '<div class="empty-actions">' +
    '<button id="emptyNewStackBtn" class="primary" data-icon="+" title="Create a new prompt stack">New stack</button>' +
    '<button id="emptyImportBtn" data-icon="⇪" title="Import pi-forge stack JSON">Import JSON</button>' +
    '</div>' +
    '</div>';
  el("tabPanel").classList.remove("open");
  el("tabPanel").innerHTML = "";
  renderDiagnostics([]);
  el("emptyNewStackBtn").onclick = () => run(createNewStack);
  el("emptyImportBtn").onclick = () => run(importStackJson);
  setStatus("No prompt stacks found");
  updateActionState();
}

function displayItemName(item: any) {
  if (item.name) return item.name;
  if (item.source && typeof item.source.previousName === "string" && item.source.previousName.trim()) return item.source.previousName;
  if (item.kind === "slot" && item.slot) return item.slot;
  if (item.kind === "block" && item.content) {
    const firstLine = item.content.trim().split(/\n/)[0]?.trim();
    if (firstLine) return firstLine.length > 46 ? firstLine.slice(0, 43) + "..." : firstLine;
  }
  return item.id || "(unnamed)";
}

async function run(action: any) {
  try {
    await action();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  el("shell").classList.toggle("sidebar-collapsed", sidebarCollapsed);
  el("sidebarToggleBtn").title = sidebarCollapsed ? "Show prompt stacks sidebar" : "Hide prompt stacks sidebar";
  setStatus(sidebarCollapsed ? "Prompt stacks sidebar hidden" : "Prompt stacks sidebar shown");
}

function handleStackModalClick(event: any) {
  if (event.target === el("stackModal") || event.target.closest?.("[data-modal-close]")) {
    closeStackModal();
  }
}

function handlePreviewClick(event: any) {
  if (event.target === el("preview") || event.target.closest?.("[data-preview-close]")) {
    hidePreview();
    return;
  }
  if (event.target.closest?.("[data-payload-arm]")) {
    event.preventDefault();
    event.stopPropagation();
    run(() => armPayloadCapture(true));
    return;
  }
  if (event.target.closest?.("[data-payload-clear]")) {
    event.preventDefault();
    event.stopPropagation();
    run(clearPayloadCapture);
    return;
  }
  const button = event.target.closest?.("[data-copy-index]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  run(() => copyPreviewText(Number(button.dataset.copyIndex)));
}

function handleEditorShortcut(event: any) {
  if (!editorIsActive()) return;

  if (event.key === "Escape") {
    if (el("preview").classList.contains("open")) hidePreview();
    else if (el("stackModal").classList.contains("open")) closeStackModal();
    return;
  }

  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier || event.altKey) return;
  const key = event.key.toLowerCase();

  if (key === "n") {
    event.preventDefault();
    run(createNewStack);
    return;
  }
  if (key === "s") {
    event.preventDefault();
    if (currentStack) run(saveStack);
    return;
  }
  if (key === "enter" && event.shiftKey) {
    event.preventDefault();
    if (currentStack) run(validateStack);
    return;
  }
  if (key === "enter") {
    event.preventDefault();
    if (currentStack) run(previewStack);
  }
}

export function startLegacyEditor(options: { isActive?: () => boolean } = {}): () => void {
  resetEditorState();
  editorIsActive = options.isActive ?? (() => true);
  editorStarted = true;
  applyEditorTheme(editorTheme.value);

  el("sidebarToggleBtn").onclick = toggleSidebar;
  el("newStackBtn").onclick = () => run(createNewStack);
  el("reloadBtn").onclick = () => run(reloadFromDisk);
  el("disableBtn").onclick = () => run(disableStacks);
  el("activateBtn").onclick = () => run(activateStack);
  el("saveBtn").onclick = () => run(saveStack);
  el("validateBtn").onclick = () => run(validateStack);
  el("previewBtn").onclick = () => run(previewStack);
  el("payloadBtn").onclick = () => run(openPayloadCapture);
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.onclick = () => {
      activateEditorView(button.dataset.tab || "items");
      activeTab = button.dataset.tab || "items";
      renderActiveTab();
      hidePreview();
    };
  });
  el("forkBtn").onclick = () => run(forkStack);
  el("importBtn").onclick = () => run(importStackJson);
  el("exportBtn").onclick = () => run(exportStackJson);
  el("importFileInput").onchange = (event: any) => run(() => handleImportFile(event));
  el("deleteStackBtn").onclick = () => run(deleteCurrentStack);
  el("stackModal").onclick = handleStackModalClick;
  el("preview").onclick = handlePreviewClick;
  el("addItemBtn").onclick = () => addItem("block");
  el("addSlotBtn").onclick = () => addItem("slot");
  el("deleteItemBtn").onclick = deleteSelectedItem;

  document.addEventListener("dragover", handleDocumentItemDragOver);
  document.addEventListener("drop", handleDocumentItemDrop);
  window.addEventListener("keydown", handleEditorShortcut);
  window.addEventListener("pi-forge:profile-applied", handleProfileApplied);
  const stopEditorView = subscribeEditorView((viewId) => {
    if (["items", "regex", "policy", "stack"].includes(viewId)) return;
    vueTabHost.unmount();
  });
  const previousBeforeUnload = window.onbeforeunload;
  const beforeUnload = () => dirty ? "Unsaved changes" : undefined;
  window.onbeforeunload = beforeUnload;
  let payloadPoll: number | undefined;

  void run(async () => {
    await loadStacks();
    if (!editorStarted) return;
    await refreshPayloadCapture();
    if (!editorStarted) return;
    payloadPoll = window.setInterval(() => run(() => refreshPayloadCapture({ autoOpen: true })), 2000);
  });

  return () => {
    if (!editorStarted) return;
    editorStarted = false;
    if (payloadPoll !== undefined) window.clearInterval(payloadPoll);
    finishItemDrag();
    document.removeEventListener("dragover", handleDocumentItemDragOver);
    document.removeEventListener("drop", handleDocumentItemDrop);
    window.removeEventListener("keydown", handleEditorShortcut);
    window.removeEventListener("pi-forge:profile-applied", handleProfileApplied);
    stopEditorView();
    if (window.onbeforeunload === beforeUnload) window.onbeforeunload = previousBeforeUnload;
    vueTabHost.unmount();
    vueMetadataHost.unmount();
    vueItemHost.unmount();
    editorIsActive = () => true;
    draftListeners.clear();
  };
}

function resetEditorState(): void {
  if (dragScrollFrame) cancelAnimationFrame(dragScrollFrame);
  stacks = [];
  cwd = "";
  selectedId = "";
  currentStack = null;
  currentFilePath = "";
  selectedItemIndex = -1;
  dirty = false;
  dragIndex = -1;
  dragDropIndex = -1;
  dragScrollFrame = 0;
  dragScrollSpeed = 0;
  dragClientY = 0;
  sidebarCollapsed = false;
  vueItemHost.reset();
  policyResources = { tools: [], skills: [] };
  latestDiagnostics = [];
  activeTab = "items";
  metadataCollapsed = true;
  vueTabHost.resetErrors();
}
