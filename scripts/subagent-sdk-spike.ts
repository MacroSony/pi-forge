#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseSpikeArgs, runSubagentSdkSpike } from "./subagent-sdk-spike-lib.ts";

export async function main(args = process.argv.slice(2)): Promise<void> {
	try {
		const report = await runSubagentSdkSpike(parseSpikeArgs(args));
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		if (report.execution.status === "failed" || report.execution.status === "timed-out") process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
