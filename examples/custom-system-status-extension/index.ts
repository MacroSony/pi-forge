import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";

interface ForgeRegistrationApi {
	registerMacro(definition: {
		name: string;
		source?: string;
		description?: string;
		dependencies?: string[];
		render: (ctx: { env: Record<string, unknown>; helpers: unknown }) => string;
	}): () => void;
	registerSlot(definition: {
		name: string;
		source?: string;
		description?: string;
		dependencies?: string[];
		options?: Record<string, unknown>;
		render: (ctx: {
			options: Record<string, unknown>;
			helpers: {
				escapeXml(value: string): string;
				plainBullet(label: string, value: string): string;
			};
		}) => string;
	}): () => void;
}

export interface SystemStatusSnapshot {
	logicalCores: number;
	cpuModel: string;
	load1: number;
	load5: number;
	load15: number;
	normalizedLoad1: number;
	freeMemoryMb: number;
	totalMemoryMb: number;
	usedMemoryPercent: number;
	uptimeSeconds: number;
}

export default function registerSystemStatus(
	api: ForgeRegistrationApi,
	sampleSystemStatus: () => SystemStatusSnapshot = readSystemStatus,
): void {
	api.registerMacro({
		name: "cpuLoad",
		source: "pi-forge-example-system-status",
		description: "Machine CPU load sampled when the prompt is compiled.",
		dependencies: [],
		// Renderers run during prompt compilation. Read a fresh snapshot for each render.
		render: () => formatCpuLoad(Object.freeze(sampleSystemStatus())),
	});

	api.registerSlot({
		name: "machine-status",
		source: "pi-forge-example-system-status",
		description: "Machine CPU, memory, and uptime sampled when the prompt is compiled.",
		dependencies: [],
		options: {
			format: { type: "enum", values: ["plain", "xml"], default: "plain" },
			heading: { type: "string", default: "Machine status" },
			includeMemory: { type: "boolean", default: true },
			includeUptime: { type: "boolean", default: true },
		},
		render: (ctx) => {
			// Do not capture this at registration time: sample when the slot is rendered.
			const snapshot = Object.freeze(sampleSystemStatus());
			const includeMemory = ctx.options.includeMemory !== false;
			const includeUptime = ctx.options.includeUptime !== false;
			const heading = typeof ctx.options.heading === "string" && ctx.options.heading.trim()
				? ctx.options.heading.trim()
				: "Machine status";

			if (ctx.options.format === "xml") {
				const lines = [
					"<machine_status>",
					`  <cpu logical_cores=\"${snapshot.logicalCores}\" normalized_load_1m=\"${snapshot.normalizedLoad1.toFixed(3)}\" model=\"${ctx.helpers.escapeXml(snapshot.cpuModel)}\">${ctx.helpers.escapeXml(formatCpuLoad(snapshot))}</cpu>`,
					`  <load_average one_minute=\"${snapshot.load1.toFixed(2)}\" five_minutes=\"${snapshot.load5.toFixed(2)}\" fifteen_minutes=\"${snapshot.load15.toFixed(2)}\" />`,
				];
				if (includeMemory) {
					lines.push(`  <memory used_percent=\"${snapshot.usedMemoryPercent.toFixed(1)}\" free_mb=\"${snapshot.freeMemoryMb}\" total_mb=\"${snapshot.totalMemoryMb}\" />`);
				}
				if (includeUptime) {
					lines.push(`  <uptime>${ctx.helpers.escapeXml(formatDuration(snapshot.uptimeSeconds))}</uptime>`);
				}
				lines.push("</machine_status>");
				return lines.join("\n");
			}

			const lines = [
				`${heading}:`,
				ctx.helpers.plainBullet("CPU", `${snapshot.logicalCores} logical cores, ${snapshot.cpuModel}`),
				ctx.helpers.plainBullet("CPU load", formatCpuLoad(snapshot)),
				ctx.helpers.plainBullet("Load average", `${snapshot.load1.toFixed(2)} / ${snapshot.load5.toFixed(2)} / ${snapshot.load15.toFixed(2)} (1m/5m/15m)`),
			];
			if (includeMemory) {
				lines.push(ctx.helpers.plainBullet("Memory", `${snapshot.usedMemoryPercent.toFixed(1)}% used (${snapshot.freeMemoryMb} MB free / ${snapshot.totalMemoryMb} MB total)`));
			}
			if (includeUptime) {
				lines.push(ctx.helpers.plainBullet("Uptime", formatDuration(snapshot.uptimeSeconds)));
			}
			return lines.join("\n");
		},
	});
}

function readSystemStatus(): SystemStatusSnapshot {
	const cores = cpus();
	const logicalCores = Math.max(cores.length, 1);
	const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
	const free = freemem();
	const total = totalmem();
	const freeMemoryMb = Math.round(free / 1024 / 1024);
	const totalMemoryMb = Math.round(total / 1024 / 1024);
	const usedMemoryPercent = total > 0 ? ((total - free) / total) * 100 : 0;

	return {
		logicalCores,
		cpuModel: cores[0]?.model ?? "unknown",
		load1,
		load5,
		load15,
		normalizedLoad1: load1 / logicalCores,
		freeMemoryMb,
		totalMemoryMb,
		usedMemoryPercent,
		uptimeSeconds: uptime(),
	};
}

function formatCpuLoad(snapshot: SystemStatusSnapshot): string {
	const normalizedPercent = snapshot.normalizedLoad1 * 100;
	return `${normalizedPercent.toFixed(1)}% normalized (${snapshot.load1.toFixed(2)} 1m load / ${snapshot.logicalCores} logical cores)`;
}

function formatDuration(seconds: number): string {
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
	parts.push(`${minutes}m`);
	return parts.join(" ");
}
