export const EDITOR_STYLES = String.raw `
:root {
  color-scheme: light;
  --bg: #f5f8f7;
  --pane: #ffffff;
  --line: #d7e3de;
  --line-strong: #a9bdb5;
  --text: #20312f;
  --muted: #657774;
  --accent: #176c5b;
  --accent-bg: #e9f4f0;
  --warning: #8b5d10;
  --warning-bg: #fff4dc;
  --error: #b42318;
  --error-bg: #fde8e7;
  --success: #20764b;
  --role-system: #7564a8;
  --role-user: #2f7d68;
  --role-assistant: #3e76ad;
  --role-tool-result: #b16b2e;
  --item-block: #4f6f9f;
  --item-slot: #8b5fa8;
  --slot-chat-history: #2f8a78;
  --slot-tools: #a36a2c;
  --slot-tool-guidelines: #ad7a32;
  --slot-skills: #4e7fa3;
  --slot-project-context: #6977a8;
  --slot-date: #8b6aa8;
  --slot-date-cwd: #7b6095;
  --slot-built-in: #5f7185;
  --slot-custom: #8a667d;
  --control: #ffffff;
  --control-muted: #f3f5f8;
  --pane-soft: #fbfcfe;
  --row: #ffffff;
  --code-bg: #111827;
  --code-text: #e5e7eb;
  --shadow: rgba(15, 23, 42, .24);
}
body[data-theme="dark"] {
  color-scheme: dark;
  --bg: #111716;
  --pane: #19211f;
  --line: #33413d;
  --line-strong: #536761;
  --text: #e7efeb;
  --muted: #a4b3ad;
  --accent: #3dbb99;
  --accent-bg: #173b33;
  --warning: #e4b75f;
  --warning-bg: #3a2d13;
  --error: #f06f64;
  --error-bg: #3c1d1a;
  --success: #69c98c;
  --role-system: #b8a8ec;
  --role-user: #65c6a9;
  --role-assistant: #82b9ef;
  --role-tool-result: #e5ad70;
  --item-block: #88a9dc;
  --item-slot: #c59be0;
  --slot-chat-history: #70d0ba;
  --slot-tools: #e5aa68;
  --slot-tool-guidelines: #e7bd74;
  --slot-skills: #8fc5e8;
  --slot-project-context: #a7b4eb;
  --slot-date: #c6a8e9;
  --slot-date-cwd: #b697dc;
  --slot-built-in: #a9bacb;
  --slot-custom: #d0a5c3;
  --control: #202a27;
  --control-muted: #25312e;
  --pane-soft: #151d1b;
  --row: #1c2623;
  --code-bg: #0b0d10;
  --code-text: #e8edf2;
  --shadow: rgba(0, 0, 0, .42);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
}
button, input, select, textarea {
  font: inherit;
  letter-spacing: 0;
}
button {
  border: 1px solid var(--line-strong);
  background: var(--control);
  color: var(--text);
  min-height: 32px;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
}
button[data-icon]::before {
  content: attr(data-icon);
  display: inline-block;
  min-width: 1em;
  margin-right: 6px;
  text-align: center;
  color: currentColor;
}
button.icon[data-icon]::before {
  margin:0; font-size:14px; line-height:30px;
}
button.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: white;
}
button.quiet-danger {
  background:transparent; border-color:transparent; color:var(--muted);
}
button.quiet-danger:hover, button.quiet-danger:focus-visible {
  border-color:var(--error); color:var(--error);
}
button.danger {
  border-color: var(--error);
  color: var(--error);
}
button.icon {
  width:32px; height:32px; min-height:32px; flex:0 0 32px; padding:0; font-size:0; overflow:hidden;
}
button:disabled {
  cursor: default;
  opacity: .55;
}
input, select, textarea {
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--control);
  color: var(--text);
  padding: 6px 8px;
  width: 100%;
}
textarea {
  min-height: 140px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
html, body {
  height: 100%;
  overflow: hidden;
}
#app {
  height: 100%;
  min-height: 0;
}
@media (max-width: 900px) {
  #app {
    height: auto;
    min-height: 100%;
  }
}
.topbar {
  display:flex; align-items:center; gap:8px; flex:none; min-height:32px; padding:3px 10px; border-top:1px solid var(--line); background:var(--pane); font-size:12px;
}
.brand {
  font-weight: 700;
  margin-right: 8px;
  white-space: nowrap;
}
.status {
  color: var(--muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dirty-badge {
  display: none;
  flex: 0 0 auto;
  border: 1px solid var(--warning);
  color: var(--warning);
  background: var(--warning-bg);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 12px;
}
.dirty-badge.visible {
  display: inline-block;
}
.shell {
  display: grid;
  grid-template-columns: 212px minmax(0, 1fr);
  height: calc(100vh - 48px);
  min-height: 0;
  transition: grid-template-columns .16s ease;
}
.shell.sidebar-collapsed {
  grid-template-columns: 0 minmax(0, 1fr);
}
.sidebar {
  border-right: 1px solid var(--line);
  background: var(--pane);
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.shell.sidebar-collapsed .sidebar {
  border-right: 0;
}
.side-head {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
}
.side-title {
  font-weight: 650;
}
.cwd {
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.stack-list {
  padding: 8px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.side-empty {
  color: var(--muted);
  font-size: 12px;
  padding: 8px;
}
.stack-row {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 4px;
}
.stack-row.active {
  background: var(--accent-bg);
  border-color: #9dccbf;
}
.stack-row.selected {
  border-color: var(--accent);
}
.stack-name {
  font-weight: 650;
  overflow-wrap: anywhere;
}
.stack-meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 7px;
  margin-left: 5px;
  font-size: 12px;
  border: 1px solid var(--line);
  color: var(--muted);
}
.badge.error {
  color: var(--error);
  background: var(--error-bg);
  border-color: #f2b8b5;
}
.badge.warning {
  color: var(--warning);
  background: var(--warning-bg);
  border-color: #efd28b;
}
.main {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.main-actions {
  display:flex; flex-wrap:wrap; align-items:center; gap:5px; position:relative; z-index:3; flex:0 1 auto; padding:0; border:0; background:transparent;
}
.new-stack-control {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
}
.new-stack-control select {
  width: auto;
  min-width: 88px;
  min-height: 30px;
  padding: 4px 8px;
  border-radius: 6px 0 0 6px;
}
.new-stack-control button {
  margin-left: -1px;
  border-radius: 0 6px 6px 0;
}
.main-actions button,
.main-actions .action-menu summary {
  min-height: 30px;
  padding: 4px 9px;
}
.action-menu {
  position: relative;
  flex: 0 0 auto;
}
.action-menu summary {
  display: flex;
  align-items: center;
  list-style: none;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--control);
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.action-menu summary::-webkit-details-marker {
  display: none;
}
.action-menu summary[data-icon]::before {
  content: attr(data-icon);
  display: inline-block;
  min-width: 1em;
  margin-right: 6px;
  text-align: center;
}
.action-menu[open] summary {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}
.action-menu-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 170px;
  display: grid;
  gap: 5px;
  padding: 7px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--pane);
  box-shadow: 0 10px 26px var(--shadow);
}
.action-menu-popover button {
  width: 100%;
  justify-self: stretch;
  text-align: left;
}
.view-tabs {
  display: flex;
  gap: 5px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--pane);
  flex-wrap: wrap;
}
.view-tabs button.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}
.action-spacer {
  flex: 1 1 auto;
  min-width: 12px;
}
.metadata-panel {
  border-bottom: 1px solid var(--line);
  background: var(--pane-soft);
}
.metadata-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
}
.metadata-head button,
.view-tabs button {
  min-height: 30px;
  padding: 4px 9px;
}
.metadata-head button {
  flex: 0 0 auto;
  white-space: nowrap;
}
.metadata-summary {
  color: var(--muted);
  font-size: 12px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings {
  display: grid;
  grid-template-columns: repeat(4, minmax(130px, 1fr));
  gap: 10px;
  padding: 12px;
  flex: 0 0 auto;
}
.settings textarea {
  min-height: 48px;
  max-height: 72px;
  resize: vertical;
}
.field label {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 4px;
}
.checkline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}
.checkline input {
  width: auto;
}
.workspace {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.tab-panel {
  display: none;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  background: var(--pane-soft);
}
.tab-panel.open {
  display: block;
}
.context-diff-panel {
  display: none;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  background: var(--pane-soft);
}
.context-diff-panel.open {
  display: block;
}
.editor-dock-area {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.editor-dock-area .workspace,
.editor-dock-area .tab-panel,
.editor-dock-area .context-diff-panel {
  min-width: 0;
  min-height: 0;
}
.tab-section {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--pane);
  padding: 10px;
  margin-bottom: 12px;
}
.tab-section-title {
  font-weight: 650;
  margin-bottom: 4px;
}
.tab-section-meta {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 10px;
}
.items-pane {
  border-right: 1px solid var(--line);
  background: var(--pane);
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  font-weight: 650;
}
.item-list {
  padding: 8px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.item-list.drag-active {
  background: var(--accent-bg);
}
.item-row {
  width:100%; text-align:left; border:1px solid transparent; border-left:2px solid var(--line); border-bottom-color:var(--line); background:transparent; border-radius:5px; padding:8px 7px 8px 20px; margin-bottom:3px; display:grid; grid-template-columns:minmax(0,1fr) 30px; gap:3px 6px; align-items:center; cursor:grab; position:relative;
}
.item-row:active {
  cursor: grabbing;
}
.item-row.kind-block {
  border-left-color: var(--item-block);
}
.item-row.kind-slot {
  border-left-color: var(--item-slot);
}
.item-row.selected {
  border-top-color: var(--accent);
  border-right-color: var(--accent);
  border-bottom-color: var(--accent);
  background: var(--accent-bg);
}
.item-row.selected.kind-block {
  border-left-color: var(--item-block);
}
.item-row.selected.kind-slot {
  border-left-color: var(--item-slot);
}
.item-row.disabled {
  opacity: .76;
}
.item-row.dragging {
  border-style: dashed;
  opacity: .58;
}
.item-row.drop-before::before,
.item-row.drop-after::after {
  content: "";
  position: absolute;
  left: 6px;
  right: 6px;
  height: 4px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
  pointer-events: none;
  z-index: 2;
}
.item-row.drop-before::before {
  top: -6px;
}
.item-row.drop-after::after {
  bottom: -6px;
}
.drag-handle {
  color: var(--muted);
  font-size: 20px;
  line-height: 1;
  text-align: center;
  user-select: none;
}
.item-toggle {
  width: 44px;
  min-height: 26px;
  padding: 2px 0;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
}
.item-toggle.enabled {
  border-color: var(--accent);
  background: var(--accent);
  color: white;
}
.item-toggle.disabled {
  border-color: var(--line-strong);
  background: var(--control-muted);
  color: var(--muted);
}
.item-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 0 6px;
  margin-left: 6px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid var(--line);
}
.item-badge.error {
  color: var(--error);
  background: var(--error-bg);
  border-color: var(--error);
}
.item-badge.warning {
  color: var(--warning);
  background: var(--warning-bg);
  border-color: var(--warning);
}
.item-title {
  font-size: 13px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.item-meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}
.editor-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--pane-soft);
}
.item-editor {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.item-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--line);
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.item-fields {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr));
  gap: 10px;
  flex: 0 0 auto;
}
.slot-flags { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:6px 24px; }
.item-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.item-body > .field {
  width: 100%;
}
.wide {
  grid-column: 1 / -1;
}
.content-field {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.content-field textarea {
  flex: 1;
  min-height: 0;
  height: 100%;
  resize: none;
}
.slot-options {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.segmented {
  display: inline-flex;
  gap: 4px;
  margin-bottom: 8px;
}
.segmented button {
  min-height: 28px;
  padding: 3px 9px;
}
.segmented button.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}
.options-grid {
  display:grid; grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr)); align-content:start; align-items:start; gap:14px 16px; overflow:auto; padding-right:4px; flex:1; min-height:0;
}
.option-note {
  color: var(--muted);
  font-size: 12px;
}
.json-options {
  flex: 1;
  min-height: 0;
  height: 100%;
  resize: none;
}
.empty {
  color: var(--muted);
  padding: 24px;
}
.empty-title {
  color: var(--text);
  font-weight: 650;
  margin-bottom: 4px;
}
.empty-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.diagnostics {
  border-top: 1px solid var(--line);
  background: var(--pane);
  flex: none;
  min-height: 0;
}
.diagnostics-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  text-align: left;
}
.diagnostics-head:hover {
  background: var(--control-muted);
}
.diagnostics-title {
  flex: 1;
  font-weight: 650;
}
.diagnostics-chevron {
  transition: transform .12s ease;
}
.diagnostics.collapsed .diagnostics-chevron {
  transform: rotate(-90deg);
}
.diagnostics-body {
  max-height: 128px;
  overflow: auto;
  border-top: 1px solid var(--line);
}
.diagnostics.collapsed .diagnostics-body {
  display: none;
}
.diagnostic {
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
}
.diagnostic.error {
  color: var(--error);
  background: var(--error-bg);
}
.diagnostic.warning {
  color: var(--warning);
  background: var(--warning-bg);
}
.diagnostic.info {
  color: var(--muted);
}
.preview {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 100;
  align-items: stretch;
  justify-content: center;
  background: rgba(15, 23, 42, .38);
  color: var(--text);
  margin: 0;
  padding: 24px;
  overflow: hidden;
}
.preview.open {
  display: flex;
}
.preview-dialog {
  width: min(1220px, calc(100vw - 48px));
  height: min(900px, calc(100vh - 48px));
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--pane-soft);
  box-shadow: 0 18px 60px var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--pane);
  flex: 0 0 auto;
}
.preview-body {
  padding: 10px 12px 14px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.preview-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.preview-title {
  font-weight: 650;
}
.preview-meta {
  color: var(--muted);
  font-size: 12px;
}
.preview-section {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--row);
  margin-bottom: 8px;
  overflow: hidden;
}
.preview-section summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  list-style: none;
  border-bottom: 1px solid transparent;
}
.preview-section[open] summary {
  border-bottom-color: var(--line);
}
.preview-section summary::-webkit-details-marker {
  display: none;
}
.preview-section summary::before {
  content: "▶";
  color: var(--muted);
  font-size: 10px;
}
.preview-section[open] summary::before {
  content: "▼";
}
.preview-text {
  margin: 0;
  padding: 10px;
  background: var(--code-bg);
  color: var(--code-text);
  overflow: auto;
  max-height: min(62vh, 680px);
  white-space: pre-wrap;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.preview-copy {
  min-height: 26px;
  padding: 2px 8px;
  font-size: 12px;
}
.modal {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 95;
  align-items: stretch;
  justify-content: center;
  background: rgba(15, 23, 42, .34);
  padding: 24px;
}
.modal.open {
  display: flex;
}
.modal-dialog {
  width: min(1280px, calc(100vw - 48px));
  height: min(860px, calc(100vh - 48px));
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--pane);
  box-shadow: 0 18px 60px var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}
.modal-title {
  font-weight: 650;
}
.modal-meta {
  color: var(--muted);
  font-size: 12px;
}
.modal-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.modal-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  background: var(--pane-soft);
}
.modal-dialog.resource-modal {
  align-self: center;
  width: min(560px, calc(100vw - 32px));
  height: auto;
  max-height: calc(100vh - 32px);
}
.resource-form {
  display: grid;
  gap: 6px;
  max-width: 480px;
  margin: 0 auto;
}
.resource-form label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}
.resource-form-note {
  margin: 6px 0 2px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--warning);
  background: var(--warning-bg);
  font-size: 12px;
}
.resource-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.modal-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}
.modal-body.json-modal {
  display: flex;
  flex-direction: column;
}
.modal-spacer {
  flex: 1;
}
.data-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.data-row {
  display: grid;
  gap: 8px;
  align-items: start;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--row);
}
.data-row.header {
  color: var(--muted);
  font-size: 12px;
  font-weight: 650;
  background: transparent;
  border-color: transparent;
  padding-top: 0;
  padding-bottom: 0;
}
.variable-row {
  grid-template-columns: minmax(160px, 260px) minmax(220px, 1fr) 86px;
}
.variable-row.parameter-row {
  grid-template-columns: minmax(160px, 260px) minmax(220px, 1fr) minmax(90px, 120px) 86px;
}
.extension-catalog-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.extension-catalog {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.extension-catalog-entry {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.extension-catalog-entry span {
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.definition-row {
  grid-template-columns: minmax(150px, 210px) minmax(100px, 140px) minmax(90px, 120px) minmax(180px, 1fr) minmax(190px, 260px) minmax(110px, 130px) minmax(110px, 130px) 86px;
}
.session-row {
  grid-template-columns: minmax(160px, 240px) minmax(220px, 1fr) minmax(180px, 260px) 168px;
}
.policy-row {
  grid-template-columns: minmax(110px, 150px) minmax(230px, 290px) minmax(220px, 1fr) minmax(220px, 1fr) minmax(150px, 220px);
}
.policy-title {
  font-weight: 650;
  margin-bottom: 3px;
}
.policy-row:not(.header) .field > label,
.policy-row:not(.header) .resource-picker > label {
  display: none;
}
.policy-mode {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 0;
}
.policy-patterns {
  min-height: 96px;
}
.selected-patterns {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.selected-pattern-chip {
  min-height: 26px;
  padding: 2px 7px;
  font-size: 12px;
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
  overflow-wrap: anywhere;
}
.selected-pattern-chip span {
  margin-left: 6px;
  color: var(--muted);
}
.selected-pattern-empty {
  color: var(--muted);
  font-size: 12px;
  min-height: 26px;
  display: inline-flex;
  align-items: center;
}
.policy-summary {
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.resource-picker label {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 4px;
}
.resource-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 132px;
  overflow: auto;
  padding-right: 2px;
}
.resource-filter {
  margin-bottom: 8px;
}
.resource-chip {
  max-width: 100%;
  min-height: 26px;
  padding: 2px 7px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.resource-chip.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}
.resource-chip.hidden {
  border-style: dashed;
  opacity: .72;
}
.resource-empty {
  color: var(--muted);
  font-size: 12px;
  border: 1px dashed var(--line);
  border-radius: 6px;
  padding: 8px;
}
.regex-row {
  grid-template-columns: 72px minmax(0, 1fr) 86px;
}
.regex-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.regex-fields {
  display: grid;
  grid-template-columns: repeat(6, minmax(110px, 1fr));
  gap: 8px;
}
.regex-fields .span-2 {
  grid-column: span 2;
}
.regex-fields .span-3 {
  grid-column: span 3;
}
.regex-fields .wide {
  grid-column: 1 / -1;
}
.regex-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  min-height: 32px;
  align-items: center;
}
.regex-checks label {
  color: var(--text);
  font-size: 13px;
  margin: 0;
}
.regex-checks input {
  width: auto;
}
.regex-warning {
  color: var(--warning);
  background: var(--warning-bg);
  border: 1px solid var(--warning);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}
.data-row textarea {
  min-height: 56px;
  resize: vertical;
}
.row-actions {
  display: flex;
  gap: 6px;
}
.raw-json-editor {
  flex: 1;
  min-height: 0;
  height: 100%;
  resize: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.tab-section .raw-json-editor {
  height: min(48vh, 520px);
  min-height: 280px;
}
@media (max-width: 960px) {
  .main-actions {
    flex-wrap: wrap;
  }
}
@media (max-width: 900px) {
  .shell, .settings {
    grid-template-columns: 1fr;
  }
  .workspace {
    display: block;
  }
        .item-form {
    height: auto;
    overflow: visible;
  }
  .item-fields {
    grid-template-columns: repeat(2, minmax(120px, 1fr));
  }
  .content-field textarea {
    height: auto;
    min-height: 220px;
    resize: vertical;
  }
  html, body {
    overflow: auto;
  }
  .shell {
    height: auto;
    min-height: calc(100vh - 80px);
  }
  .sidebar, .items-pane {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .shell.sidebar-collapsed { grid-template-columns:minmax(0,1fr); }
  .shell.sidebar-collapsed .sidebar { display:none; }
  .sidebar {
    min-height: 0;
    max-height: 240px;
  }
  .metadata-head {
    align-items: center;
    flex-direction: row;
  }
  .new-stack-control {
    flex: 1 1 180px;
  }
  .new-stack-control select {
    flex: 1 1 auto;
  }
  .item-list {
    max-height: 260px;
  }
  .variable-row, .definition-row, .session-row, .policy-row, .regex-row, .extension-catalog-grid {
    grid-template-columns: 1fr;
  }
  .policy-row:not(.header) .field > label,
  .policy-row:not(.header) .resource-picker > label {
    display: block;
  }
  .regex-fields {
    grid-template-columns: 1fr;
  }
  .regex-fields .span-2, .regex-fields .span-3 {
    grid-column: 1 / -1;
  }
}
@media (max-width: 700px) {
  .topbar .brand {
    display: none;
  }
  .topbar #reloadBtn,
  .topbar #disableBtn {
    width: 34px;
    padding-inline: 0;
    overflow: hidden;
    color: transparent;
    font-size: 0;
  }
  .topbar #reloadBtn::before,
  .topbar #disableBtn::before {
    margin-right: 0;
    color: var(--text);
    font-size: 14px;
  }
}

/* V4 workspace: the library owns creation/reload; the editor header owns identity. */
.topbar .brand {
  display: none;
}
.resource-header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
  padding: 4px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--pane);
}
.resource-identity,
.resource-title-line,
.resource-subline {
  min-width: 0;
}
.resource-title-line {
  display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; min-width:0;
}
.resource-title-line h1 {
  flex:0 1 auto; min-width:0; max-width:100%; margin:0; font-size:18px; line-height:1.3; font-weight:700; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
}
.resource-subline {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.resource-subline code {
  color: var(--accent);
  overflow-wrap: anywhere;
}
.resource-editing-label {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11px;
}
.runtime-badge {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.runtime-badge.active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-bg);
}
.side-head {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: space-between;
  gap: 8px;
}
.side-head-title {
  min-width: 0;
  flex: 1 1 auto;
}
.library-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
.library-actions select {
  width: auto;
  min-width: 74px;
  padding: 4px 6px;
  font-size: 12px;
}
.library-actions button {
  font-size: 12px;
  min-height: 30px;
  padding: 4px 7px;
  white-space: nowrap;
}
.library-actions #reloadBtn {
  width: 30px;
  padding-inline: 0;
  overflow: hidden;
  color: transparent;
  font-size: 0;
}
.library-actions #reloadBtn::before {
  margin-right: 0;
  color: var(--text);
  font-size: 14px;
}
.resource-header .resource-identity {
  flex:1 1 280px; min-width:min(280px,100%);
}
.resource-header .main-actions .action-spacer {
  min-width: 4px;
}
.item-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.item-row.selected {
  border-color: var(--accent);
}
.item-row.selected.kind-block,
.item-row.selected.kind-slot {
  border-left-color: var(--accent);
}
.item-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--text);
}
.item-meta {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: normal;
}
.item-form {
  gap: 8px;
  padding: 14px 16px;
}
.item-primary-field {
  flex: 0 0 auto;
}
.item-primary-field label {
  color: var(--text);
  font-weight: 650;
}
.item-primary-field input {
  min-height: 36px;
  font-size: 15px;
}
.item-technical-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
}
.role-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: var(--text);
  font-size: 12px;
}
.role-control select {
  width: auto;
  min-width: 88px;
  min-height: 30px;
  padding: 3px 22px 3px 5px;
  border: 1px solid transparent;
  background-color: transparent;
  color: var(--text);
  font-size: 14px;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23677770' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 7.5l5 5 5-5'/%3E%3C/svg%3E");
  background-position: right 3px center;
  background-size: 16px 16px;
  background-repeat: no-repeat;
}
.role-control select:hover,
.role-control select:focus-visible {
  border-color: var(--line);
  background: var(--accent-bg);
}
.item-properties {
  position: relative;
  flex: 0 0 auto;
}
.item-properties > summary {
  cursor: pointer;
  list-style: none;
  color: var(--muted);
  padding: 3px 5px;
  border-radius: 4px;
}
.item-properties > summary::-webkit-details-marker {
  display: none;
}
.item-properties > summary::after {
  content: "⌄";
  margin-left: 4px;
  font-size: 16px;
  line-height: 12px;
  vertical-align: -1px;
}
.item-properties[open] > summary::after {
  content: "⌃";
}
.item-properties > summary:hover,
.item-properties > summary:focus-visible {
  color: var(--accent);
  background: var(--accent-bg);
  outline: none;
}
.item-properties-popover {
  position:fixed; z-index:4; display:grid; grid-template-columns:1fr; gap:10px; width:min(330px,calc(100vw - 32px)); max-height:65vh; overflow:auto; padding:12px; border:1px solid var(--line); border-radius:6px; background:var(--pane); box-shadow:0 8px 24px var(--shadow);
}
.item-properties-popover .field:last-child {
  grid-column: 1 / -1;
}
.item-body {
  min-width: 0;
}
.content-field {
  min-width: 0;
}
.content-field textarea {
  color: var(--text);
  background: var(--control);
  line-height: 1.6;
}
.metadata-details > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 10px;
  cursor: pointer;
  list-style: none;
  color: var(--muted);
  font-size: 12px;
}
.metadata-details > summary::-webkit-details-marker {
  display: none;
}
.metadata-details > summary::before {
  content: "▸";
  color: var(--accent);
}
.metadata-details[open] > summary::before {
  content: "▾";
}
.metadata-summary-title {
  flex: 0 0 auto;
  color: var(--text);
  font-weight: 650;
}
.metadata-details .metadata-summary {
  margin: 0;
}
@media (max-width: 900px) {
  .resource-header {
    padding: 5px 10px;
  }
  .resource-header .main-actions {
    flex: 1 1 auto;
  }
  .resource-editing-label {
    display: none;
  }
  .library-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .library-actions select {
    max-width: 82px;
  }
}
@media (max-width: 520px) {
  .side-head {
    display: block;
  }
  .library-actions {
    margin-top: 7px;
    justify-content: flex-start;
  }
  .resource-title-line h1 {
    font-size: 16px;
  }
}

.item-row .drag-handle { position: absolute; left: 3px; top: 13px; font-size: 14px; width: 12px; }
.item-row .item-toggle { width: 30px; min-height: 24px; padding: 1px 0; font-size: 10px; border-radius: 5px; }
.item-row .item-toggle.enabled { background: var(--accent-bg); color: var(--accent); border-color: var(--line); }
.item-row > div:not(.drag-handle) { min-width: 0; }
.item-row .item-title { grid-column:1; grid-row:1; }
.item-row .item-toggle { grid-column:2; grid-row:1; }
.stack-row { display: flex; flex-direction: column; align-items: stretch; }
.stack-row .stack-meta:nth-child(2) { order: -1; font-size: 13px; color: var(--text); font-weight: 650; margin-top: 0; }
.stack-row .stack-name { font-size: 11px; color: var(--muted); margin-top: 4px; }
.view-tabs { gap: 18px; padding: 0 12px; }
.view-tabs button { border: 0; border-radius: 0; background: transparent; padding: 7px 2px; position: relative; }
.view-tabs button[data-icon]::before { display: none; }
.view-tabs button.active { background: transparent; color: var(--accent); }
.view-tabs button.active::after { content: ""; position: absolute; bottom: 0; height: 2px; left: 0; right: 0; background: var(--accent); }
.library-actions { flex-wrap: nowrap; }
@media(max-width:520px) { .view-tabs { gap: 14px; } }

.stack-list, .item-list { flex: 0 1 auto; }
.side-head { flex-direction: row; align-items: flex-start; }
.side-head .library-actions { flex: 0 0 auto; }
.side-head .cwd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Second-pass workspace polish: keep creation and item operations close to their
   owning list/editor, while the preview remains a separate dock column. */
.library-create {
  flex: 0 0 auto;
  display: grid;
  gap: 5px;
  padding: 10px 8px 12px;
  border-top: 1px solid var(--line);
  background: var(--pane-soft);
}
.library-create #newStackBtn {
  width: 100%;
  margin-top: 2px;
  border-style: dashed;
  justify-content: center;
}
.item-add-wrap {
  position: relative;
  flex: 0 0 auto;
  padding: 8px 12px 12px;
  border-top: 1px solid var(--line);
  background: var(--pane);
}
.item-add-wrap > .outline-add {
  width: 100%;
  border-style: dashed;
  color: var(--muted);
}
.add-content-menu {
  position: absolute;
  z-index: 5;
  left: 12px;
  right: 12px;
  bottom: calc(100% - 4px);
  display: grid;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--pane);
  box-shadow: 0 8px 24px var(--shadow);
}
.add-content-menu[hidden] {
  display: none;
}
.add-content-menu button {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  text-align: left;
  border-color: transparent;
}
.add-content-menu button small {
  grid-column: 2;
  color: var(--muted);
  font-size: 11px;
}
.view-tabs [data-dock-tab] {
  margin-left: auto;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--pane-soft);
  padding-inline: 10px;
  color: var(--muted);
  font-size: 12px;
}
.view-tabs [data-dock-tab].active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}
.view-tabs [data-dock-tab].active::after {
  display: none;
}


/* Navigation has one summary line, not a second miniature form. */
.item-row .item-meta { grid-column:1 / -1; margin:0; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.preset-properties-entry { flex:0 0 auto; }
`;
//# sourceMappingURL=styles.js.map