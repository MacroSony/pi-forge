import { createApp, type App } from "vue";

import SchemaForm from "./components/SchemaForm.vue";
import { cloneJson, normalizeValues, type FormSchema, type FormValues } from "./schema-form.ts";

export interface VueSchemaFormHostDependencies {
	getSchema(): FormSchema;
	getValues(): FormValues;
	markDirty(): void;
	setStatus(text: string, tone?: string): void;
	/** Receives committed (normalized, cloned) values plus the first error. */
	onChange?(values: FormValues, error: string): void;
}

/**
 * Generic schema-form host, mirroring the existing vue-item/vue-metadata/vue-tab
 * host pattern: it owns the form draft, mounts the self-contained SchemaForm
 * component into a root element, and bridges change events back to the owner.
 */
export function createVueSchemaFormHost(deps: VueSchemaFormHostDependencies) {
	let app: App<Element> | undefined;
	let draft: FormValues | undefined;
	let error = "";

	function mount(root: Element): void {
		unmount();
		const schema = deps.getSchema();
		draft = normalizeValues(schema, cloneJson(deps.getValues()));
		app = createApp(SchemaForm, {
			schema,
			values: draft,
			onChange: (nextError: string, values: FormValues) => {
				error = nextError;
				deps.markDirty();
				if (nextError) deps.setStatus(nextError, "error");
				deps.onChange?.(cloneJson(values), nextError);
			},
			onStatus: deps.setStatus,
		});
		app.mount(root);
	}

	function unmount(): void {
		app?.unmount();
		app = undefined;
		draft = undefined;
		error = "";
	}

	function reset(): void {
		error = "";
	}

	function getError(): string {
		return error;
	}

	/** Deep clone of the current form draft, or undefined before mounting. */
	function getValues(): FormValues | undefined {
		return draft === undefined ? undefined : cloneJson(draft);
	}

	return { mount, unmount, reset, getError, getValues };
}
