// Temporary behavior-preserving bridge while the stack editor is migrated to Vue components.
import { createEditorApi, EditorApiError } from "./api.ts";
import { attr, el, escapeHtml, eventElement, query, queryAll, type EditorElement } from "./dom.ts";
import { createInspector } from "./inspector.ts";
import { createVueItemHost } from "./vue-item-host.ts";
import { createVueMetadataHost } from "./vue-metadata-host.ts";
import { applyEditorTheme, editorTheme } from "./theme.ts";
import { createVueTabHost } from "./vue-tab-host.ts";
import { activateEditorView, subscribeEditorView } from "./editor-view-coordinator.ts";
import { t, type MessageKey } from "./i18n.ts";
import type {
  EditorPromptStack,
  PromptStackDiagnostic,
  WebEditorResources,
  WebEditorStackSummary,
} from "./types.ts";

const token = new URLSearchParams(location.search).get("token") || "";
const api = createEditorApi(token);
let stacks: WebEditorStackSummary[] = [];
let cwd = "";
let selectedId = "";
let currentStack: EditorPromptStack | null = null;
let currentFilePath = "";
let currentSourceRevision = "";
let selectedItemIndex = -1;
let dirty = false;
let dragIndex = -1;
let dragDropIndex = -1;
let dragScrollFrame = 0;
let dragScrollSpeed = 0;
let dragClientY = 0;
let sidebarCollapsed = false;
let editorResources: WebEditorResources = { tools: [], skills: [], macros: [], slots: [] };
let latestDiagnostics: PromptStackDiagnostic[] = [];
// null = automatic: expand when errors or warnings exist, collapse when clean.
let diagnosticsCollapsed: boolean | null = null;
let activeTab: "items" | "regex" | "policy" | "bindings" | "stack" = "items";
let addContentMenuOpen = false;
let currentPresetSelector = "";
let stackLoadGeneration = 0;
let resourceLoadGeneration = 0;
let currentPresetScope: "project" | "global" = "project";
let metadataCollapsed = true;
let statusKey: MessageKey | undefined;
let statusParams: Record<string, string | number> = {};
let statusTone = "";
let editorStarted = false;
let editorIsActive = () => true;
let stackModalResolver: ((value: any) => void) | null = null;
let stackModalRestoreFocus: HTMLElement | null = null;
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

const builtInSlotNames = [
  "chat-history", "tools", "tool-guidelines", "skills", "project-context",
  "append-system-prompt", "date", "cwd", "date-cwd",
  "active-model", "pi-docs"
];
const roles = ["", "system", "user", "assistant", "custom"];

const {
  validateStack,
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
  getResources: () => editorResources,
  refreshResources: () => run(refreshStackRuntimeState),
  getPresetSelector: () => currentPresetSelector,
  getPresetScope: () => currentPresetScope,
  markDirty,
  setStatus,
  validateStack: () => run(validateStack),
  applyStack: applyStackFromVue,
  copyText: copyTextToClipboard,
});
function getCurrentPresetSelector(): string {
  return currentPresetSelector;
}

function getCurrentPresetScope(): "project" | "global" {
  return currentPresetScope;
}

const vueMetadataHost = createVueMetadataHost({
  getStack: () => currentStack,
  getFilePath: () => currentFilePath,
  getPresetSelector: () => getCurrentPresetSelector(),
  getPresetScope: () => getCurrentPresetScope(),
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
  getSlotNames: () => editorResources.slots.length > 0
    ? editorResources.slots.map((slot) => slot.name)
    : builtInSlotNames,
  roles,
  markDirty,
  renderItemList,
  setStatus,
  deleteSelectedItem,
  copyText: copyTextToClipboard,
});

function setStatus(text: string, tone: any = "", semantic?: { key: MessageKey; params?: Record<string, string | number> }) {
  statusKey = semantic?.key;
  statusParams = semantic?.params || {};
  statusTone = tone;
  const status = el("status");
  status.textContent = text;
  status.style.color = tone === "error" ? "var(--error)" : tone === "success" ? "var(--success)" : "var(--muted)";
}

function setSemanticStatus(key: MessageKey, params: Record<string, string | number> = {}, tone: any = "") {
  setStatus(t(key, params), tone, { key, params });
}

function renderResourceHeader() {
  const name = el("resourceName");
  const selector = el("resourceSelector");
  const mode = el("resourceMode");
  const runtime = el("runtimeBadge");
  if (!name || !selector || !mode || !runtime) return;
  if (!currentStack) {
    name.textContent = t("nav.stacks");
    name.title = "";
    selector.textContent = "";
    mode.textContent = "";
    runtime.textContent = "";
    runtime.className = "runtime-badge";
    return;
  }
  const summary = stacks.find((stack: any) => (stack.selector || stack.id) === selectedId);
  name.textContent = currentStack.name || currentStack.id || t("stackList.unnamed");
  name.title = name.textContent;
  selector.textContent = currentPresetSelector;
  mode.textContent = ` · ${currentStack.mode || "replace"}`;
  runtime.textContent = summary?.active ? t("polish.workspace.runtimeActive") : t("polish.workspace.savedVersion");
  runtime.className = "runtime-badge" + (summary?.active ? " active" : "");
}

function markDirty() {
  dirty = true;
  renderDirtyState();
  setSemanticStatus("status.unsavedChanges");
  notifyDraftChanged();
}

function renderDirtyState() {
  const badge = el("dirtyBadge");
  if (badge) badge.classList.toggle("visible", dirty);
  renderResourceHeader();
  updateActionState();
}

function updateActionState() {
  const hasStack = !!currentStack;
  for (const id of ["saveBtn", "validateBtn", "forkBtn", "exportBtn", "deleteStackBtn", "addContentBtn", "addItemBtn", "addSlotBtn"]) {
    const button = el(id);
    if (button) button.disabled = !hasStack;
  }
  const activateButton = el("activateBtn");
  if (activateButton) {
    activateButton.disabled = !hasStack || dirty;
    activateButton.title = dirty ? t("polish.workspace.activateSavedFirst") : t("chrome.activateTitle");
  }
  const deleteItemButton = document.querySelector<HTMLButtonElement>("#deleteItemBtn");
  if (deleteItemButton) deleteItemButton.disabled = !hasStack || selectedItemIndex < 0;
  document.querySelectorAll("[data-tab], [data-dock-tab]").forEach((button: any) => {
    button.disabled = !hasStack;
  });
}

async function loadStacks(preferId: any = selectedId) {
  const generation = ++resourceLoadGeneration;
  const selectionGeneration = stackLoadGeneration;
  const [data, resources] = await Promise.all([
    api("/api/stacks"),
    api("/api/resources"),
  ]);
  if (!editorStarted || generation !== resourceLoadGeneration) return;
  stacks = data.stacks || [];
  editorResources = normalizeEditorResources(resources);
  cwd = data.cwd || "";
  el("cwd").textContent = cwd;
  el("cwd").title = cwd;
  renderStackList();
  const next = stacks.find((stack: any) => (stack.selector || stack.id) === preferId) || stacks.find((stack: any) => stack.active) || stacks[0];
  if (selectionGeneration !== stackLoadGeneration) return;
  if (next) await selectStack(next.selector || next.id, { keepDirty: false });
  else renderEmpty();
}

async function refreshStackRuntimeState() {
  const generation = ++resourceLoadGeneration;
  const [data, resources] = await Promise.all([
    api("/api/stacks"),
    api("/api/resources"),
  ]);
  if (!editorStarted || generation !== resourceLoadGeneration) return;
  stacks = data.stacks || [];
  editorResources = normalizeEditorResources(resources);
  cwd = data.cwd || "";
  el("cwd").textContent = cwd;
  renderStackList();
  renderResourceHeader();
  updateActionState();
  if (activeTab !== "items") renderActiveTab();
}

function handleProfileApplied() {
  run(refreshStackRuntimeState);
}

async function selectStack(id: any, options: any = {}) {
  if (dirty && !options.keepDirty && !confirm(t("confirm.discardChanges"))) return;
  const generation = ++stackLoadGeneration;
  const data = await api("/api/stacks/" + encodeURIComponent(id));
  if (!editorStarted || generation !== stackLoadGeneration) return;
  selectedId = id;
  const loadedStack = structuredClone(data.stack) as EditorPromptStack;
  currentStack = loadedStack;
  currentFilePath = data.filePath || "";
  currentSourceRevision = typeof data.sourceRevision === "string" ? data.sourceRevision : "";

  // Prefer the resolved resource identity returned by the host. The fallback
  // supports existing host fixtures, never guesses scope from a filesystem path
  // or picks a same-id resource before looking for the exact scoped selector.
  const summary = stacks.find((s: any) => (s.selector || s.id) === id);
  const qualified = typeof data.selector === "string" ? data.selector
    : typeof id === "string" && /^(global|project):/.test(id) ? id
    : summary?.selector;
  currentPresetScope = data.scope === "global" || data.scope === "project" ? data.scope
    : qualified?.startsWith("global:") ? "global"
    : summary?.scope === "global" ? "global" : "project";
  currentPresetSelector = qualified || `${currentPresetScope}:${loadedStack.id}`;
  selectedItemIndex = loadedStack.items.length
    ? typeof options.selectedItemIndex === "number"
      ? Math.min(Math.max(options.selectedItemIndex, 0), loadedStack.items.length - 1)
      : 0
    : -1;
  dirty = false;
  vueTabHost.resetErrors();
  vueItemHost.reset(options.itemMode);
  renderDirtyState();
  renderAll(data.diagnostics || []);
  setSemanticStatus("status.loaded", { id: loadedStack.id });
  notifyDraftChanged();
}

function renderAll(diagnostics: any = []) {
  latestDiagnostics = diagnostics;
  renderResourceHeader();
  renderStackList();
  renderSettings();
  renderActiveTab();
  renderDiagnostics(diagnostics);
  hidePreview();
  updateActionState();
}

function renderActiveTab() {
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
  vueTabHost.mount(activeTab, panel);
}

function renderStackList() {
  const list = el("stackList");
  list.innerHTML = "";
  if (!stacks.length) {
    list.innerHTML = '<div class="side-empty">' + escapeHtml(t("stackList.empty")) + '</div>';
    return;
  }
  for (const stack of stacks) {
    const row = document.createElement("button");
    row.className = "stack-row" + (stack.active ? " active" : "") + ((stack.selector || stack.id) === selectedId ? " selected" : "");
    const diag = stack.errors ? '<span class="badge error">' + escapeHtml(t("stackList.errorCount", { count: stack.errors })) + '</span>' : stack.warnings ? '<span class="badge warning">' + escapeHtml(t("stackList.warningCount", { count: stack.warnings })) + '</span>' : "";
    const scopeBadge = stack.scope === "global" ? '<span class="badge">' + escapeHtml(t("stackList.global")) + '</span>' : '';
    row.innerHTML = '<div class="stack-name">' + escapeHtml(stack.id) + (stack.active ? '<span class="badge">' + escapeHtml(t("stackList.active")) + '</span>' : '') + scopeBadge + diag + '</div>' +
      '<div class="stack-meta">' + escapeHtml(stack.name || t("stackList.unnamed")) + '</div>' +
      '<div class="stack-meta">' + escapeHtml(t("stackList.itemCount", { count: stack.itemCount })) + ' | ' + escapeHtml(stack.mode || "replace") + '</div>';
    row.onclick = () => selectStack(stack.selector || stack.id);
    list.appendChild(row);
  }
}

function normalizeEditorResources(value: any): WebEditorResources {
  return {
    tools: normalizeResourceList(value?.tools),
    skills: normalizeResourceList(value?.skills),
    macros: normalizeExtensionResourceList(value?.macros),
    slots: normalizeExtensionResourceList(value?.slots),
  };
}

function normalizeExtensionResourceList(value: any) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((resource: any) => resource && typeof resource === "object" && typeof resource.name === "string" && resource.name.trim())
    .map((resource: any) => ({
      name: resource.name.trim(),
      description: typeof resource.description === "string" ? resource.description : "",
      source: typeof resource.source === "string" ? resource.source : "",
      dependencies: Array.isArray(resource.dependencies)
        ? resource.dependencies.filter((dependency: unknown): dependency is string => typeof dependency === "string")
        : [],
    }));
}

function normalizeResourceList(value: any) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((resource: any) => resource && typeof resource === "object" && typeof resource.name === "string" && resource.name.trim())
    .map((resource: any) => ({
      name: resource.name.trim(),
      description: typeof resource.description === "string" ? resource.description : "",
      source: typeof resource.source === "string" ? resource.source : "",
      group: resource.group && typeof resource.group.id === "string" && typeof resource.group.label === "string"
        ? { id: resource.group.id, label: resource.group.label } : undefined,
      baselineActive: typeof resource.baselineActive === "boolean" ? resource.baselineActive : undefined,
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
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("chrome.items"));
  list.classList.toggle("drag-active", dragIndex !== -1);
  if (!currentStack) return;
  el("itemCount").textContent = t("itemList.total", { count: currentStack.items.length });
  list.ondragover = handleItemListDragOver;
  list.ondrop = handleItemListDrop;
  const diagnosticsByItem = diagnosticsForItems();
  currentStack.items.forEach((item: any, index: any) => {
    const row = document.createElement("div");
    row.className = "item-row kind-" + (item.kind === "slot" ? "slot" : "block") + (index === selectedItemIndex ? " selected" : "") + (item.enabled === false ? " disabled" : "");
    row.dataset.itemIndex = String(index);
    row.tabIndex = 0;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === selectedItemIndex));
    row.setAttribute("aria-label", displayItemName(item));
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
    const name = displayItemName(item);
    const summary = item.kind === "slot"
      ? ["slot", item.slot || "custom"].join(" · ")
      : [item.role, name === item.id ? "" : item.id].filter(Boolean).join(" · ");
    row.title = [name, item.kind, item.role, item.slot, "ID: " + item.id].filter(Boolean).join(" · ");
    row.innerHTML = '<div class="drag-handle" title="' + attr(t("itemList.dragToReorder")) + '">≡</div>' +
      '<div class="item-title" title="' + attr(name) + '">' + escapeHtml(name) + diagBadge + '</div>' +
      '<button type="button" class="item-toggle ' + (enabled ? "enabled" : "disabled") + '" title="' + attr(t("itemList.toggleItem")) + '" aria-label="' + attr(t("itemList.toggleItem") + ': ' + name) + '" aria-pressed="' + enabled + '">' + escapeHtml(enabled ? t("itemList.on") : t("itemList.off")) + '</button>' +
      '<div class="item-meta" title="' + attr(summary + ' · ID: ' + item.id) + '">' + escapeHtml(summary) + '</div>';
    const selectRow = (event?: any) => {
      if (event?.target?.classList?.contains("item-toggle")) return;
      const retainFocus = event?.type === "keydown" && document.activeElement === row;
      selectedItemIndex = index;
      renderItemList();
      renderItemEditor();
      if (retainFocus) {
        const selectedRow = query<HTMLElement>(el("itemList"), `[data-item-index="${index}"]`);
        selectedRow?.focus();
      }
    };
    row.onclick = selectRow;
    row.onkeydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if ((event.target as HTMLElement)?.classList?.contains("item-toggle")) return;
      event.preventDefault();
      selectRow(event);
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
    editor.innerHTML = '<div class="empty">' + escapeHtml(t("itemEditor.none")) + '</div>';
    return;
  }
}

function showStackModal(title: any, meta: any, body: any, options: any = {}): Promise<any> {
  const pane = el("stackModal");
  closeStackModal();
  stackModalRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  pane.innerHTML = '<div class="modal-dialog ' + attr(options.dialogClass || "") + '" role="dialog" aria-modal="true" aria-labelledby="stackModalTitle">' +
    '<div class="modal-head"><div><div id="stackModalTitle" class="modal-title">' + escapeHtml(title) + '</div><div class="modal-meta">' + escapeHtml(meta || "") + '</div></div>' +
    '<div class="modal-actions"><button type="button" data-modal-close="true" data-icon="×" title="' + attr(t("modal.closeTitle")) + '">' + escapeHtml(t("modal.close")) + '</button></div></div>' +
    '<div class="modal-body ' + attr(options.bodyClass || "") + '">' + body + '</div></div>';
  pane.classList.add("open");
  pane.onkeydown = handleStackModalKeydown;
  pane.onsubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const result = options.onSubmit?.(event.target as HTMLFormElement);
    closeStackModal(result);
  };
  const promise = new Promise((resolve) => {
    stackModalResolver = resolve;
  });
  const focusTarget = pane.querySelector<HTMLElement>(options.initialFocus || "input, button, select, textarea");
  focusTarget?.focus({ preventScroll: true });
  return promise;
}

function closeStackModal(result: any = null) {
  const pane = el("stackModal");
  const resolver = stackModalResolver;
  const restoreFocus = stackModalRestoreFocus;
  stackModalResolver = null;
  stackModalRestoreFocus = null;
  pane.onsubmit = null;
  pane.onkeydown = null;
  pane.classList.remove("open");
  pane.innerHTML = "";
  if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  resolver?.(result);
}

function handleStackModalKeydown(event: KeyboardEvent): void {
  const pane = el("stackModal");
  if (!pane.classList.contains("open")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeStackModal();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...pane.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey ? active === first || !pane.contains(active) : active === last || !pane.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
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
  setSemanticStatus("status.appliedStack", {}, "success");
}

function setAddContentMenu(open: boolean): void {
  addContentMenuOpen = open;
  const menu = document.getElementById("addContentMenu");
  const button = document.getElementById("addContentBtn") as HTMLButtonElement | null;
  if (menu) menu.hidden = !open;
  button?.setAttribute("aria-expanded", String(open));
}

function toggleAddContentMenu(): void {
  if (!currentStack) return;
  setAddContentMenu(!addContentMenuOpen);
}

function closeAddContentMenuOnDocumentClick(event: MouseEvent): void {
  const wrapper = document.querySelector<HTMLElement>(".item-add-wrap");
  if (addContentMenuOpen && wrapper && !wrapper.contains(event.target as Node)) setAddContentMenu(false);
}

function addItem(kind: any) {
  if (!currentStack) return;
  setAddContentMenu(false);
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
  if (!confirm(t("polish.workspace.deleteItemConfirm", { id: item.id, name: displayItemName(item) }))) return;
  currentStack.items.splice(selectedItemIndex, 1);
  selectedItemIndex = Math.min(selectedItemIndex, currentStack.items.length - 1);
  markDirty();
  renderItemList();
  renderItemEditor();
}

async function saveStack() {
  const savedItemIndex = selectedItemIndex;
  const savedItemMode = vueItemHost.getMode();
  const stack = stackForSubmit();
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId), {
    method: "PUT",
    body: { stack, expectedSourceRevision: currentSourceRevision },
  });
  stacks = data.stacks || stacks;
  selectedId = data.stack?.selector || data.stack?.id || stack.id;
  currentStack = structuredClone(stack);
  dirty = false;
  renderDirtyState();
  renderAll(data.stack?.diagnostics || []);
  setSemanticStatus("status.saved", { id: selectedId }, "success");
  await selectStack(selectedId, {
    keepDirty: true,
    selectedItemIndex: savedItemIndex,
    itemMode: savedItemMode,
  });
}

async function createStackRemote(stack: any, options: any = {}) {
  try {
    return await api("/api/stacks", { method: "POST", body: { stack, ...options } });
  } catch (error) {
    if (error instanceof EditorApiError && error.status === 409 && !options.overwrite && confirm(t("confirm.overwriteStack", { message: error.message || "Preset already exists." }))) {
      return await api("/api/stacks", { method: "POST", body: { stack, ...options, overwrite: true } });
    }
    throw error;
  }
}

async function createAndOpenStack(stack: any, activate: any, actionLabel: any, extraOptions: any = {}) {
  const data = await createStackRemote(stack, { ...extraOptions, activate });
  stacks = data.stacks || stacks;
  selectedId = data.stack?.selector || data.stack?.id || stack.id;
  dirty = false;
  renderDirtyState();
  await selectStack(selectedId, { keepDirty: true });
  const displayId = data.stack?.id || stack.id;
  setSemanticStatus(actionLabel, { id: displayId }, "success");
}

function resourceFormHtml(kind: "new" | "import" | "fork", id: string, name: string, firstPreset: boolean): string {
  const submitKey = kind === "import" ? "polish.workspace.resourceImportSubmit" : kind === "fork" ? "polish.workspace.resourceForkSubmit" : "polish.workspace.resourceSubmit";
  return '<form id="stackResourceForm" class="resource-form">' +
    '<label for="stackResourceName">' + escapeHtml(t("polish.workspace.resourceName")) + '</label>' +
    '<input id="stackResourceName" name="name" type="text" value="' + attr(name) + '" autocomplete="off" required>' +
    '<label for="stackResourceId">' + escapeHtml(t("polish.workspace.resourceId")) + '</label>' +
    '<input id="stackResourceId" name="id" type="text" value="' + attr(id) + '" autocomplete="off" spellcheck="false" required>' +
    '<label for="stackResourceScope">' + escapeHtml(t("polish.workspace.resourceScope")) + '</label>' +
    '<select id="stackResourceScope" name="scope">' +
    '<option value="project">' + escapeHtml(t("chrome.scopeProject")) + '</option>' +
    '<option value="global">' + escapeHtml(t("chrome.scopeGlobal")) + '</option>' +
    '</select>' +
    (firstPreset ? '<p class="resource-form-note">' + escapeHtml(t("polish.workspace.firstPresetActivation")) + '</p>' : "") +
    '<div class="resource-form-actions">' +
    '<button type="button" data-modal-close="true">' + escapeHtml(t("polish.workspace.resourceCancel")) + '</button>' +
    '<button type="submit" class="primary">' + escapeHtml(t(submitKey)) + '</button>' +
    '</div></form>';
}

async function collectResourceTarget(kind: "new" | "import" | "fork", id: string, name: string): Promise<{ id: string; name: string; scope: "project" | "global" } | null> {
  const result = await showStackModal(
    t(kind === "new" ? "polish.workspace.newResourceTitle" : kind === "import" ? "polish.workspace.importResourceTitle" : "polish.workspace.forkResourceTitle"),
    t("polish.workspace.resourceMeta"),
    resourceFormHtml(kind, id, name, kind === "new" && stacks.length === 0),
    {
      dialogClass: "resource-modal",
      initialFocus: "#stackResourceName",
      onSubmit: (form: HTMLFormElement) => {
        const fields = new FormData(form);
        return {
          id: String(fields.get("id") || ""),
          name: String(fields.get("name") || ""),
          scope: fields.get("scope") === "global" ? "global" : "project",
        };
      },
    },
  );
  return result;
}

function normalizeResourceId(value: string): string | null {
  const id = sanitizeStackId(value);
  if (!id) throw new Error(t("error.stackIdEmpty"));
  if (id !== value.trim() && !confirm(t("confirm.useStackId", { id }))) return null;
  return id;
}

async function createNewStack() {
  if (dirty && !confirm(t("confirm.discardChanges"))) return;
  const target = await collectResourceTarget("new", uniqueStackId("new-preset"), "Default Pi Prompt Mirror");
  if (!target) return;
  const id = normalizeResourceId(target.id);
  if (!id) return;
  const stack = defaultNewStack(id, target.name.trim() || id);
  const activate = stacks.length === 0 || confirm(t("confirm.activateNewStack"));
  await createAndOpenStack(stack, activate, "status.created", { scope: target.scope });
}

function defaultNewStack(id: any, name: any) {
  return {
    schemaVersion: 2,
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
  if (!imported || typeof imported !== "object" || Array.isArray(imported)) throw new Error(t("error.importNotObject"));
  if (!Array.isArray(imported.items)) throw new Error(t("error.importNoItems"));
  // Keep the parsed object untouched until the resource form is submitted;
  // unknown imported fields travel through the clone unchanged.
  const stack = structuredClone(imported);
  const fallbackId = sanitizeStackId(file.name.replace(/\.json$/i, "")) || uniqueStackId("imported-preset");
  const initialId = typeof stack.id === "string" ? stack.id : fallbackId;
  const initialName = typeof stack.name === "string" ? stack.name : initialId;
  const target = await collectResourceTarget("import", initialId, initialName);
  if (!target) return;
  const id = normalizeResourceId(target.id);
  if (!id) return;
  stack.id = id;
  stack.name = target.name.trim() || id;
  if (!stack.schemaVersion) stack.schemaVersion = 1;
  if (!stack.type) stack.type = "pi-forge.prompt-stack";
  const activate = confirm(t("confirm.activateImportedStack"));
  await createAndOpenStack(stack, activate, "status.imported", { scope: target.scope });
}

async function forkStack() {
  const source = stackForSubmit();
  const target = await collectResourceTarget("fork", uniqueForkId(source.id || "preset"), ((source.name || source.id || "Preset") + " fork"));
  if (!target) return;
  const id = normalizeResourceId(target.id);
  if (!id) return;
  const fork = structuredClone(source);
  fork.id = id;
  fork.name = target.name.trim() || id;
  fork.autoActivate = false;
  const activate = confirm(t("confirm.activateFork"));
  await createAndOpenStack(fork, activate, "status.forked", { scope: target.scope });
}

async function exportStackJson() {
  const stack = stackForSubmit();
  const json = JSON.stringify(stack, null, 2) + "\n";
  const downloaded = downloadTextFile(sanitizeStackId(stack.id || "preset") + ".json", json, "application/json");
  if (downloaded) {
    setSemanticStatus("status.exported", { id: stack.id || "preset" }, "success");
    return;
  }
  await copyTextToClipboard(json);
  setSemanticStatus("status.copiedJson", { id: stack.id || "preset" }, "success");
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
  if (dirty) {
    setSemanticStatus("polish.workspace.activateSavedFirst", {}, "error");
    updateActionState();
    return;
  }
  const data = await api("/api/stacks/" + encodeURIComponent(selectedId) + "/activate", { method: "POST" });
  stacks = data.stacks || stacks;
  renderStackList();
  await refreshStackRuntimeState();
  setSemanticStatus("status.activated", { id: selectedId }, "success");
}

async function disableStacks() {
  const data = await api("/api/disable", { method: "POST" });
  stacks = data.stacks || stacks;
  renderStackList();
  await refreshStackRuntimeState();
  setSemanticStatus("status.stackDisabled", {}, "success");
}

async function deleteCurrentStack() {
  if (!currentStack) return;
  const routeId = selectedId;
  const displayId = currentStack.id;
  const message = t("confirm.deleteStack", { id: displayId });
  if (!confirm(message)) return;
  const data = await api("/api/stacks/" + encodeURIComponent(routeId), { method: "DELETE" });
  stacks = data.stacks || [];
  dirty = false;
  renderDirtyState();
  const next = stacks.find((stack: any) => stack.active) || stacks[0];
  if (next) {
    await selectStack(next.selector || next.id, { keepDirty: true });
    setSemanticStatus("status.deleted", { id: displayId }, "success");
  } else {
    renderStackList();
    renderEmpty();
    setSemanticStatus("status.deletedNoneRemain", { id: displayId }, "success");
  }
}

async function reloadFromDisk() {
  if (dirty && !confirm(t("confirm.discardChanges"))) return;
  const data = await api("/api/reload", { method: "POST" });
  stacks = data.stacks || [];
  renderStackList();
  await loadStacks(selectedId);
  setSemanticStatus("status.reloaded", {}, "success");
}

function stackForSubmit() {
  if (!currentStack) throw new Error(t("error.noStackSelected"));
  const itemOptionsError = vueItemHost.getError();
  if (itemOptionsError) throw new Error(t("error.invalidItemOptions", { message: itemOptionsError }));
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
  const countText = (one: any, many: any, count: any) => count === 1 ? t(one, { count }) : t(many, { count });
  const summary = !latestDiagnostics.length
    ? t("diag.none")
    : [
      errors ? countText("diag.errorOne", "diag.errorMany", errors) : "",
      warnings ? countText("diag.warningOne", "diag.warningMany", warnings) : "",
    ].filter(Boolean).join(" · ") || countText("diag.noteOne", "diag.noteMany", latestDiagnostics.length);
  const body = !latestDiagnostics.length
    ? '<div class="diagnostic info">' + escapeHtml(t("diag.noDiagnostics")) + '</div>'
    : latestDiagnostics.map((diag: any) => {
      const level = diag.level || "info";
      const item = diag.itemId ? " [" + escapeHtml(diag.itemId) + "]" : "";
      return '<div class="diagnostic ' + attr(level) + '"><strong>' + escapeHtml(level.toUpperCase()) + item + '</strong>: ' + escapeHtml(diag.message || "") + '</div>';
    }).join("");
  const pane = el("diagnostics");
  pane.classList.toggle("collapsed", collapsed);
  pane.innerHTML =
    '<button type="button" id="diagnosticsToggleBtn" class="diagnostics-head" aria-expanded="' + String(!collapsed) + '" title="' + attr(t("diag.toggle")) + '">' +
    '<span class="diagnostics-title">' + escapeHtml(t("diag.title", { summary })) + '</span>' +
    '<span class="diagnostics-chevron">▾</span>' +
    '</button>' +
    '<div class="diagnostics-body">' + body + '</div>';
  el("diagnosticsToggleBtn").onclick = () => {
    diagnosticsCollapsed = !collapsed;
    renderDiagnostics(latestDiagnostics);
  };
}

function renderEmpty() {
  setAddContentMenu(false);
  activateEditorView("items");
  vueTabHost.unmount();
  vueItemHost.unmount();
  currentStack = null;
  selectedId = "";
  currentSourceRevision = "";
  dirty = false;
	notifyDraftChanged();
  activeTab = "items";
  vueTabHost.resetErrors();
  renderDirtyState();
  document.querySelectorAll("[data-tab]").forEach((button: any) => {
    button.classList.toggle("active", button.dataset.tab === activeTab);
  });
  el("workspace").style.display = "";
  renderResourceHeader();
  el("metadataPanel").style.display = "none";
  vueMetadataHost.unmount();
  el("itemCount").textContent = "";
  el("itemList").innerHTML = "";
  el("itemEditor").innerHTML =
    '<div class="empty">' +
    '<div class="empty-title">' + escapeHtml(t("empty.title")) + '</div>' +
    '<div>' + escapeHtml(t("empty.body")) + '</div>' +
    '<div class="empty-actions">' +
    '<button id="emptyNewStackBtn" class="primary" data-icon="+" title="' + attr(t("chrome.newStackTitle")) + '">' + escapeHtml(t("chrome.newStack")) + '</button>' +
    '<button id="emptyImportBtn" data-icon="⇪" title="' + attr(t("chrome.importTitle")) + '">' + escapeHtml(t("chrome.import")) + '</button>' +
    '</div>' +
    '</div>';
  el("tabPanel").classList.remove("open");
  el("tabPanel").innerHTML = "";
  renderDiagnostics([]);
  el("emptyNewStackBtn").onclick = () => run(createNewStack);
  el("emptyImportBtn").onclick = () => run(importStackJson);
  setSemanticStatus("status.noStacks");
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
  return item.id || t("stackList.unnamed");
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
  el("sidebarToggleBtn").title = sidebarCollapsed ? t("chrome.showSidebar") : t("chrome.hideSidebar");
  setSemanticStatus(sidebarCollapsed ? "status.sidebarHidden" : "status.sidebarShown");
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
  // Native properties/session dialogs own focus; never save the background draft.
  if (document.querySelector("dialog[open]")) {
    if ((event.ctrlKey || event.metaKey) && ["s", "n", "enter"].includes(event.key.toLowerCase())) event.preventDefault();
    return;
  }


  if (el("stackModal").classList.contains("open")) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeStackModal();
    }
    // Do not let editor shortcuts save or trigger actions behind the form.
    if ((event.ctrlKey || event.metaKey) && ["s", "n", "enter"].includes(event.key.toLowerCase())) event.preventDefault();
    return;
  }

  if (event.key === "Escape") {
    if (addContentMenuOpen) {
      setAddContentMenu(false);
      el("addContentBtn").focus();
    }
    else if (el("preview").classList.contains("open")) hidePreview();
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
    if (currentStack) el("previewTabBtn").click();
  }
}

/**
 * Re-render all legacy surfaces after a locale switch. State is already in
 * memory; this simply regenerates the imperative DOM with the new strings.
 */
export function refreshLegacyEditorLocale(): void {
  if (!editorStarted) return;
  el("sidebarToggleBtn").title = sidebarCollapsed ? t("chrome.showSidebar") : t("chrome.hideSidebar");
  if (currentStack) {
    renderAll(latestDiagnostics);
    if (statusKey) setStatus(t(statusKey, statusParams), statusTone, { key: statusKey, params: statusParams });
  } else if (!stacks.length) {
    renderEmpty();
  } else {
    renderStackList();
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
  el("payloadBtn").onclick = () => run(openPayloadCapture);
  const moreActions = el("moreActions") as HTMLDetailsElement;
  moreActions.onclick = (event) => {
    if ((event.target as HTMLElement).closest("button")) moreActions.open = false;
  };
  const closeMoreActions = (event: MouseEvent) => {
    if (moreActions.open && !moreActions.contains(event.target as Node)) moreActions.open = false;
  };
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
  el("addContentBtn").onclick = toggleAddContentMenu;
  el("addItemBtn").onclick = () => addItem("block");
  el("addSlotBtn").onclick = () => addItem("slot");

  document.addEventListener("dragover", handleDocumentItemDragOver);
  document.addEventListener("drop", handleDocumentItemDrop);
  document.addEventListener("click", closeMoreActions);
  document.addEventListener("click", closeAddContentMenuOnDocumentClick);
  window.addEventListener("keydown", handleEditorShortcut);
  window.addEventListener("pi-forge:profile-applied", handleProfileApplied);
  const stopEditorView = subscribeEditorView((viewId) => {
    if (["items", "regex", "policy", "bindings", "stack"].includes(viewId)) return;
    vueTabHost.unmount();
  });
  const previousBeforeUnload = window.onbeforeunload;
  const beforeUnload = () => dirty ? t("status.unsavedChanges") : undefined;
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
    closeStackModal();
    editorStarted = false;
    if (payloadPoll !== undefined) window.clearInterval(payloadPoll);
    finishItemDrag();
    document.removeEventListener("dragover", handleDocumentItemDragOver);
    document.removeEventListener("drop", handleDocumentItemDrop);
    document.removeEventListener("click", closeMoreActions);
    document.removeEventListener("click", closeAddContentMenuOnDocumentClick);
    window.removeEventListener("keydown", handleEditorShortcut);
    window.removeEventListener("pi-forge:profile-applied", handleProfileApplied);
    moreActions.onclick = null;
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
  stackLoadGeneration++;
  resourceLoadGeneration++;
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
  editorResources = { tools: [], skills: [], macros: [], slots: [] };
  latestDiagnostics = [];
  statusKey = undefined;
  statusParams = {};
  statusTone = "";
  activeTab = "items";
  addContentMenuOpen = false;
  currentPresetSelector = "";
  currentPresetScope = "project";
  metadataCollapsed = true;
  vueTabHost.resetErrors();
}
