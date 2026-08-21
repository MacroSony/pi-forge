export type EditorViewId = string;

type EditorViewListener = (viewId: EditorViewId) => void;

let activeViewId: EditorViewId = "items";
const listeners = new Set<EditorViewListener>();

/**
 * Synchronously announces the next editor view before its host mounts.
 *
 * The stack editor is split across legacy tab and Preview dock hosts. A single
 * activation signal lets the inactive Vue host unmount before view state changes.
 */
export function activateEditorView(viewId: EditorViewId): void {
	activeViewId = viewId;
	for (const listener of [...listeners]) listener(viewId);
}

export function currentEditorView(): EditorViewId {
	return activeViewId;
}

export function subscribeEditorView(listener: EditorViewListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function resetEditorViewCoordinator(): void {
	activeViewId = "items";
	listeners.clear();
}
