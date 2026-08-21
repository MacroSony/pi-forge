import type { FormSchema, FormValues } from "../schema-form.ts";

export interface ContributionTabDescriptor {
	tabId: string;
	title: string;
	icon: string;
	schema: FormSchema;
	values: FormValues;
}

export function settingsContributionButtonId(tabId: string): string {
	return `settings-${encodeURIComponent(tabId)}TabBtn`;
}

export function uniqueContributionDescriptors(tabs: readonly ContributionTabDescriptor[]): ContributionTabDescriptor[] {
	const seen = new Set<string>();
	return tabs.filter((tab) => {
		if (seen.has(tab.tabId)) return false;
		seen.add(tab.tabId);
		return true;
	});
}
