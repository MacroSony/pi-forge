import assert from "node:assert/strict";
import test from "node:test";
import { createInspector } from "../src/web-editor/client/inspector.ts";

function fixture() {
	const previous = globalThis.document;
	const elements = new Map<string, any>();
	for (const id of ["payloadBtn", "preview"]) elements.set(id, { innerHTML: "", textContent: "", title: "", classList: { add() {}, remove() {} } });
	globalThis.document = { getElementById: (id: string) => elements.get(id) } as any;
	const pending: Array<{ path: string; resolve: (value: any) => void }> = [];
	const inspector = createInspector({
		api: (path: string) => new Promise<any>(resolve => pending.push({ path, resolve })),
		getSelectedId: () => "project:demo", stackForSubmit: () => ({ id: "demo", schemaVersion: 1, items: [] }),
		renderDiagnostics() {}, renderItemList() {}, setStatus() {},
	});
	return { inspector, pending, pane: elements.get("preview"), restore() { globalThis.document = previous; } };
}
const captured = (label: string) => ({ status: "captured", capture: { capturedAt: label, text: label, chars: label.length, approxTokens: 2 } });

test("payload inspection ignores an older poll arriving after the latest capture", async () => {
	const f = fixture();
	try {
		const old = f.inspector.refreshPayloadCapture({ autoOpen: true });
		const latest = f.inspector.refreshPayloadCapture({ autoOpen: true });
		f.pending[1].resolve(captured("LATEST_CAPTURE")); await latest;
		f.pending[0].resolve(captured("OLD_CAPTURE")); await old;
		assert.match(f.pane.innerHTML, /LATEST_CAPTURE/);
		assert.doesNotMatch(f.pane.innerHTML, /OLD_CAPTURE/);
	} finally { f.restore(); }
});

test("payload clear supersedes outstanding GET and blocks polling until mutation settles", async () => {
	const f = fixture();
	try {
		const old = f.inspector.refreshPayloadCapture({ autoOpen: true });
		const clear = f.inspector.clearPayloadCapture();
		const during = f.inspector.refreshPayloadCapture({ autoOpen: true });
		assert.equal(f.pending.length, 2, "no GET starts during an outstanding mutation");
		await during;
		f.pending[1].resolve({ status: "idle" }); await clear;
		f.pending[0].resolve(captured("STALE_AFTER_CLEAR")); await old;
		assert.equal(f.pane.innerHTML, "");
	} finally { f.restore(); }
});
