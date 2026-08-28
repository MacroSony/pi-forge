import assert from "node:assert/strict";
import test from "node:test";

import registerSystemStatus from "../examples/custom-system-status-extension/index.ts";

test("system-status renderers use one registration snapshot and only public context fields", () => {
	let macroRender: ((context: { env: Record<string, unknown>; helpers: unknown }) => string) | undefined;
	let slotRender: ((context: {
		options: Record<string, unknown>;
		helpers: {
			escapeXml(value: string): string;
			plainBullet(label: string, value: string): string;
		};
	}) => string) | undefined;

	registerSystemStatus({
		registerMacro: (definition) => {
			macroRender = definition.render;
			return () => {};
		},
		registerSlot: (definition) => {
			slotRender = definition.render;
			return () => {};
		},
	});

	assert.ok(macroRender);
	assert.ok(slotRender);
	const macroContext = { env: {}, helpers: {} };
	const slotContext = {
		options: { format: "plain", includeMemory: true, includeUptime: true },
		helpers: {
			escapeXml: (value: string) => value,
			plainBullet: (label: string, value: string) => `- ${label}: ${value}`,
		},
	};
	assert.equal(macroRender(macroContext), macroRender(macroContext));
	assert.equal(slotRender(slotContext), slotRender(slotContext));
});
