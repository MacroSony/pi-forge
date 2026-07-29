import { createApp, type App } from "vue";

import PolicyEditor from "./components/PolicyEditor.vue";
import RegexEditor from "./components/RegexEditor.vue";
import type {
	EditorPromptStack,
	WebEditorPolicyResource,
} from "./types.ts";

type VueTabKind = "policy" | "regex";

export interface VueTabHostDependencies {
	getStack(): EditorPromptStack | null;
	getResources(): {
		tools: WebEditorPolicyResource[];
		skills: WebEditorPolicyResource[];
	};
	markDirty(): void;
	setStatus(text: string, tone?: string): void;
	validateStack(): void | Promise<void>;
}

export function createVueTabHost(deps: VueTabHostDependencies) {
	let app: App<Element> | undefined;
	let draft: EditorPromptStack | undefined;
	const errors: Record<VueTabKind, string> = {
		policy: "",
		regex: "",
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
			app = createApp(RegexEditor, {
				stack: draft,
				onChange,
				onValidate: deps.validateStack,
			});
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
		} else {
			copyOptionalField(stack, plainDraft, "regex");
		}
	}

	return {
		mountPolicy: (root: Element) => mount("policy", root),
		mountRegex: (root: Element) => mount("regex", root),
		unmount,
		resetErrors,
		getError,
	};
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function copyOptionalField(
	target: EditorPromptStack,
	source: EditorPromptStack,
	key: "tools" | "skills" | "regex",
): void {
	if (key in source) target[key] = source[key];
	else delete target[key];
}
