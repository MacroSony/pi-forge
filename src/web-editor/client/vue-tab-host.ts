import { createApp, type App } from "vue";

import PolicyEditor from "./components/PolicyEditor.vue";
import RegexEditor from "./components/RegexEditor.vue";
import StackEditor from "./components/StackEditor.vue";
import type {
	EditorPromptStack,
	WebEditorPolicyResource,
} from "./types.ts";

type VueTabKind = "policy" | "regex" | "stack";

export interface VueTabHostDependencies {
	getStack(): EditorPromptStack | null;
	getResources(): {
		tools: WebEditorPolicyResource[];
		skills: WebEditorPolicyResource[];
	};
	markDirty(): void;
	setStatus(text: string, tone?: string): void;
	validateStack(): void | Promise<void>;
	applyStack(stack: EditorPromptStack): void;
	copyText(text: string): void | Promise<void>;
}

export function createVueTabHost(deps: VueTabHostDependencies) {
	let app: App<Element> | undefined;
	let draft: EditorPromptStack | undefined;
	const errors: Record<VueTabKind, string> = {
		policy: "",
		regex: "",
		stack: "",
	};

	function mount(kind: VueTabKind, root: Element): void {
		unmount();
		const stack = deps.getStack();
		if (!stack) return;
		draft = cloneJson(stack);

		const onChange = (error: string) => {
			syncDraft(kind);
			errors[kind] = error;
			deps.markDirty();
			if (errors[kind]) deps.setStatus(errors[kind], "error");
		};

		if (kind === "policy") {
			app = createApp(PolicyEditor, {
				stack: draft,
				resources: deps.getResources(),
				onChange,
				onStatus: deps.setStatus,
			});
		} else {
			if (kind === "regex") {
				app = createApp(RegexEditor, {
					stack: draft,
					onChange,
					onValidate: deps.validateStack,
				});
			} else {
				app = createApp(StackEditor, {
					stack: draft,
					copyText: deps.copyText,
					onApply: () => {
						if (draft) deps.applyStack(cloneJson(draft));
					},
					onChange,
					onStatus: deps.setStatus,
				});
			}
		}

		app.mount(root);
	}

	function unmount(): void {
		app?.unmount();
		app = undefined;
		draft = undefined;
	}

	function resetErrors(): void {
		errors.policy = "";
		errors.regex = "";
		errors.stack = "";
	}

	function getError(kind: VueTabKind): string {
		return errors[kind];
	}

	function syncDraft(kind: VueTabKind): void {
		const stack = deps.getStack();
		if (!stack || !draft) return;
		const plainDraft = cloneJson(draft);
		if (kind === "policy") {
			copyOptionalField(stack, plainDraft, "tools");
			copyOptionalField(stack, plainDraft, "skills");
		} else if (kind === "regex") {
			copyOptionalField(stack, plainDraft, "regex");
		} else {
			copyOptionalField(stack, plainDraft, "context");
			copyOptionalField(stack, plainDraft, "variables");
		}
	}

	return {
		mountPolicy: (root: Element) => mount("policy", root),
		mountRegex: (root: Element) => mount("regex", root),
		mountStack: (root: Element) => mount("stack", root),
		unmount,
		resetErrors,
		getError,
	};
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function copyOptionalField<K extends "tools" | "skills" | "regex" | "context" | "variables">(
	target: EditorPromptStack,
	source: EditorPromptStack,
	key: K,
): void {
	if (key in source) target[key] = source[key];
	else delete target[key];
}
