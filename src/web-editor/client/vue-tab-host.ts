import { createApp, type App, type Component } from "vue";

import PolicyEditor from "./components/PolicyEditor.vue";
import RegexEditor from "./components/RegexEditor.vue";
import StackEditor from "./components/StackEditor.vue";
import { copyStackFields, getEditorTab } from "./tab-registry.ts";
import type {
	EditorPromptStack,
	WebEditorPolicyResource,
} from "./types.ts";

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

/** Per-tab mount input shared by every Vue tab's props factory. */
interface VueTabMountInput {
	stack: EditorPromptStack;
	resources: {
		tools: WebEditorPolicyResource[];
		skills: WebEditorPolicyResource[];
	};
	onChange(error: string): void;
	onStatus(text: string, tone?: string): void;
	copyText(text: string): void | Promise<void>;
	applyStack(stack: EditorPromptStack): void;
	validateStack(): void | Promise<void>;
}

type VueTabMountFactory = (input: VueTabMountInput) => {
	component: Component;
	props: Record<string, unknown>;
};

// Component wiring keyed by string tab id. The registry itself stays pure and
// data-driven; this map carries the Vue component + props factory per tab.
const vueTabMounts: Record<string, VueTabMountFactory> = {
	regex: (input) => ({
		component: RegexEditor,
		props: {
			stack: input.stack,
			onChange: input.onChange,
			onValidate: input.validateStack,
		},
	}),
	policy: (input) => ({
		component: PolicyEditor,
		props: {
			stack: input.stack,
			resources: input.resources,
			onChange: input.onChange,
			onStatus: input.onStatus,
		},
	}),
	stack: (input) => ({
		component: StackEditor,
		props: {
			stack: input.stack,
			copyText: input.copyText,
			onApply: () => input.applyStack(cloneJson(input.stack)),
			onChange: input.onChange,
			onStatus: input.onStatus,
		},
	}),
};

export function createVueTabHost(deps: VueTabHostDependencies) {
	let app: App<Element> | undefined;
	let draft: EditorPromptStack | undefined;
	const errors: Record<string, string> = {};

	function mount(kind: string, root: Element): void {
		unmount();
		const stack = deps.getStack();
		const definition = getEditorTab(kind);
		if (!stack || !definition || definition.mount === "legacy") return;
		draft = cloneJson(stack);

		const input: VueTabMountInput = {
			stack: draft,
			resources: deps.getResources(),
			onChange: (error: string) => {
				syncDraft(kind);
				errors[kind] = error;
				deps.markDirty();
				if (errors[kind]) deps.setStatus(errors[kind], "error");
			},
			onStatus: deps.setStatus,
			copyText: deps.copyText,
			applyStack: deps.applyStack,
			validateStack: deps.validateStack,
		};

		const factory = vueTabMounts[kind];
		if (!factory) return;
		const { component, props } = factory(input);
		app = createApp(component, props);
		app.mount(root);
	}

	function unmount(): void {
		app?.unmount();
		app = undefined;
		draft = undefined;
	}

	function resetErrors(): void {
		for (const key of Object.keys(errors)) delete errors[key];
	}

	function getError(kind: string): string {
		return errors[kind] ?? "";
	}

	function syncDraft(kind: string): void {
		const stack = deps.getStack();
		if (!stack || !draft) return;
		const definition = getEditorTab(kind);
		if (!definition) return;
		// Copy from a deep, JSON-normalized clone: the editors can stash Vue
		// reactive proxies inside nested stack objects (e.g. regex rule
		// snapshots), so we must never write the live draft reference through to
		// the shared stack (which is structuredCloned on save).
		copyStackFields(stack, cloneJson(draft), definition.stackFields);
	}

	return {
		/** Generic entry point for any registered vue tab id. */
		mount,
		// Convenience wrappers kept so legacy-editor.ts keeps working unchanged.
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
