export type EditorViewId = string;

type EditorViewListener = (viewId: EditorViewId) => void;

let activeViewId: EditorViewId = "items";
const listeners = new Set<EditorViewListener>();

/**
 * Synchronously announces the next editor view before its host mounts.
 *
 * The stack editor is temporarily split across legacy, dock, and contribution
 * hosts. A single activation signal lets every previous host unmount from the
 * shared panel before the next host claims it.
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
