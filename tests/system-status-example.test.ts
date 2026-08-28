import assert from "node:assert/strict";
import test from "node:test";

import registerSystemStatus, { type SystemStatusSnapshot } from "../examples/custom-system-status-extension/index.ts";

test("system-status renderers sample when compiled and use only public context fields", () => {
	let macroRender: ((context: { env: Record<string, unknown>; helpers: unknown }) => string) | undefined;
	let slotRender: ((context: {
		options: Record<string, unknown>;
		helpers: {
			escapeXml(value: string): string;
			plainBullet(label: string, value: string): string;
		};
	}) => string) | undefined;
	let samples = 0;
	const sampleSystemStatus = (): SystemStatusSnapshot => {
		samples += 1;
		const load1 = samples;
		return {
			logicalCores: 16,
			cpuModel: "Test CPU",
			load1,
			load5: load1 + 0.5,
			load15: load1 + 1,
			normalizedLoad1: load1 / 16,
			freeMemoryMb: 8_000 - samples,
			totalMemoryMb: 16_000,
			usedMemoryPercent: 50 + samples,
			uptimeSeconds: samples * 60,
		};
	};

	registerSystemStatus({
		registerMacro: (definition) => {
			macroRender = definition.render;
			return () => {};
		},
		registerSlot: (definition) => {
			slotRender = definition.render;
			return () => {};
		},
	}, sampleSystemStatus);

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
	const macroFirst = macroRender(macroContext);
	const macroSecond = macroRender(macroContext);
	const slotFirst = slotRender(slotContext);
	const slotSecond = slotRender(slotContext);

	assert.notEqual(macroFirst, macroSecond);
	assert.match(macroFirst, /6\.3% normalized \(1\.00 1m load \/ 16 logical cores\)/);
	assert.match(macroSecond, /12\.5% normalized \(2\.00 1m load \/ 16 logical cores\)/);
	assert.notEqual(slotFirst, slotSecond);
	assert.match(slotFirst, /CPU load: 18\.8% normalized \(3\.00 1m load \/ 16 logical cores\)/);
	assert.match(slotSecond, /CPU load: 25\.0% normalized \(4\.00 1m load \/ 16 logical cores\)/);
	assert.equal(samples, 4);
});
