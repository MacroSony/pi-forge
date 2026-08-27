import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface ForgeRegistrationApi {
	registerMacro(definition: {
		name: string;
		source?: string;
		description?: string;
		render: (ctx: { env: Record<string, unknown>; helpers: unknown }) => string;
	}): () => void;
	registerSlot(definition: {
		name: string;
		source?: string;
		description?: string;
		options?: Record<string, unknown>;
		render: (ctx: {
			options: Record<string, unknown>;
			format: () => "xml" | "plain" | "json";
			helpers: {
				escapeXml(value: string): string;
				plainBullet(label: string, value: string): string;
			};
		}) => string;
	}): () => void;
}

interface SmartHomeState {
	lights: Record<string, boolean>;
	curtains: Record<string, number>; // 0-100 open percent
	doors: Record<string, "locked" | "unlocked" | "ajar">;
	updatedAt?: string;
}

/**
 * Trusted extension for the smart-home-butler preset.
 * Reads device state from a local JSON file every render, so the model
 * always sees fresh state without a single tool call.
 * Path override: SMART_HOME_STATE=/path/to/state.json
 */
export default function registerSmartHome(api: ForgeRegistrationApi): void {
	api.registerSlot({
		name: "house-status",
		source: "pi-forge-example-smart-home-butler",
		description: "Live smart-home device state (lights, curtains, doors), re-read on every turn.",
		options: {
			format: { type: "enum", values: ["plain", "xml"], default: "plain" },
			heading: { type: "string", default: "Smart home status" },
		},
		render: (ctx) => {
			const state = readSmartHomeState();
			const heading = typeof ctx.options.heading === "string" && ctx.options.heading.trim()
				? ctx.options.heading.trim()
				: "Smart home status";

			if (ctx.format() === "xml") {
				const lines = ["<smarthome_status>"];
				for (const [room, on] of Object.entries(state.lights)) {
					lines.push(`  <light room="${ctx.helpers.escapeXml(room)}" on="${on}" />`);
				}
				for (const [room, pct] of Object.entries(state.curtains)) {
					lines.push(`  <curtain room="${ctx.helpers.escapeXml(room)}" open_percent="${pct}" />`);
				}
				for (const [door, status] of Object.entries(state.doors)) {
					lines.push(`  <door name="${ctx.helpers.escapeXml(door)}" status="${status}" />`);
				}
				if (state.updatedAt) lines.push(`  <updated_at>${ctx.helpers.escapeXml(state.updatedAt)}</updated_at>`);
				lines.push("</smarthome_status>");
				return lines.join("\n");
			}

			const lines = [`${heading}:`];
			for (const [room, on] of Object.entries(state.lights)) {
				lines.push(ctx.helpers.plainBullet(`Light · ${room}`, on ? "on" : "off"));
			}
			for (const [room, pct] of Object.entries(state.curtains)) {
				lines.push(ctx.helpers.plainBullet(`Curtain · ${room}`, `${pct}% open`));
			}
			for (const [door, status] of Object.entries(state.doors)) {
				lines.push(ctx.helpers.plainBullet(`Door · ${door}`, status));
			}
			if (state.updatedAt) lines.push(ctx.helpers.plainBullet("Updated", state.updatedAt));
			return lines.join("\n");
		},
	});

	api.registerMacro({
		name: "smarthomeSummary",
		source: "pi-forge-example-smart-home-butler",
		description: "One-line summary of smart-home state, e.g. '2 lights on, 1 door unlocked'.",
		render: () => {
			const s = readSmartHomeState();
			const lightsOn = Object.values(s.lights).filter(Boolean).length;
			const unlocked = Object.values(s.doors).filter((d) => d !== "locked").length;
			return `${lightsOn}/${Object.keys(s.lights).length} lights on, ${unlocked} door(s) not locked`;
		},
	});
}

function readSmartHomeState(): SmartHomeState {
	const here = dirname(fileURLToPath(import.meta.url));
	const path = process.env.SMART_HOME_STATE ?? join(here, "state.json");
	try {
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf8")) as SmartHomeState;
		}
	} catch {
		// fall through to demo state
	}
	// Demo fallback (clearly marked, used when no state file exists)
	return {
		lights: { living_room: true, bedroom: false },
		curtains: { living_room: 80 },
		doors: { front: "locked" },
		updatedAt: "demo-fallback",
	};
}
