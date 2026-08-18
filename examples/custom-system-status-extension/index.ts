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

interface SystemStatusSnapshot {
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

export default function registerSystemStatus(api: ForgeRegistrationApi): void {
	api.registerMacro({
		name: "cpuLoad",
		source: "pi-forge-example-system-status",
		description: "Current machine CPU load as normalized 1-minute OS load average.",
		render: () => formatCpuLoad(readSystemStatus()),
	});

	api.registerSlot({
		name: "machine-status",
		source: "pi-forge-example-system-status",
		description: "Current machine CPU, memory, and uptime snapshot.",
		options: {
			format: { type: "enum", values: ["plain", "xml"], default: "plain" },
			heading: { type: "string", default: "Machine status" },
			includeMemory: { type: "boolean", default: true },
			includeUptime: { type: "boolean", default: true },
		},
		render: (ctx) => {
			const snapshot = readSystemStatus();
			const includeMemory = ctx.options.includeMemory !== false;
			const includeUptime = ctx.options.includeUptime !== false;
			const heading = typeof ctx.options.heading === "string" && ctx.options.heading.trim()
				? ctx.options.heading.trim()
				: "Machine status";

			if (ctx.format() === "xml") {
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
