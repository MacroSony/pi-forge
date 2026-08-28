import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_OUTPUT_CHARS = 16_000;
const BASH_TIMEOUT_MS = 300_000;
const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";
const SHELL_RESET_MESSAGE = "The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.";

const BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

const STR_REPLACE_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`
* A null placeholder for a parameter unused by the selected command is treated as omitted. Required parameters still need values; omit \`str_replace.new_str\` rather than setting it to null when deleting a match

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

const bashSchema = Type.Object({
	command: Type.String({ description: "The bash command to run. Relative path is preferred in the command." }),
});

const nullableString = (description: string) => Type.Union([Type.String(), Type.Null()], { description });
const editorSchema = Type.Object({
	command: Type.Union([
		Type.Literal("view"),
		Type.Literal("create"),
		Type.Literal("str_replace"),
		Type.Literal("insert"),
	], { description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`." }),
	path: Type.String({ description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`." }),
	file_text: Type.Optional(nullableString("Required string parameter of `create` command, with the content of the file to be created. A null placeholder is treated as omitted by commands that do not use this parameter.")),
	insert_line: Type.Optional(Type.Union([Type.Integer(), Type.Null()], { description: "Required integer parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`. A null placeholder is treated as omitted by commands that do not use this parameter." })),
	new_str: Type.Optional(nullableString("Optional string parameter of `str_replace` command containing the new string (if omitted, no string will be added). Required string parameter of `insert` command containing the string to insert. A null placeholder is accepted only by commands that do not use this parameter.")),
	old_str: Type.Optional(nullableString("Required string parameter of `str_replace` command containing the string in `path` to replace. A null placeholder is treated as omitted by commands that do not use this parameter.")),
	view_range: Type.Optional(Type.Union([Type.Array(Type.Integer()), Type.Null()], { description: "Optional parameter of `view` command when `path` points to a file. If omitted or null, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file." })),
});

interface EditorArgs {
	command: "view" | "create" | "str_replace" | "insert";
	path: string;
	file_text?: string | null;
	insert_line?: number | null;
	new_str?: string | null;
	old_str?: string | null;
	view_range?: number[] | null;
}

function textResult(text: string): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined };
}

function maybeTruncate(content: string): string {
	return content.length <= MAX_OUTPUT_CHARS ? content : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MESSAGE;
}

function requireAbsolute(path: string): string {
	if (path.trim().length === 0) throw new Error("path must be a non-empty string");
	if (!isAbsolute(path)) {
		throw new Error(`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`);
	}
	return path;
}

async function statExisting(path: string, command: "view" | "str_replace" | "insert") {
	let info;
	try {
		info = await stat(path);
	} catch {
		throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
	}
	if (info.isDirectory() && command !== "view") {
		throw new Error(`The path ${path} is a directory and only the \`view\` command can be used on directories`);
	}
	return info;
}

function matchOffsets(content: string, search: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	while (true) {
		const match = content.indexOf(search, offset);
		if (match < 0) return offsets;
		offsets.push(match);
		offset = match + search.length;
	}
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
	let line = 1;
	let cursor = 0;
	return offsets.map((offset) => {
		while (cursor < offset) {
			if (content[cursor] === "\n") line += 1;
			cursor += 1;
		}
		return line;
	});
}

function formatFileView(path: string, content: string, viewRange?: number[]): string {
	const allLines = content.split("\n");
	let lines = allLines;
	let initialLine = 1;
	let finalLine: number | undefined;
	let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
	if (viewRange !== undefined) {
		if (
			viewRange.length !== 2
			|| viewRange[0] === undefined
			|| viewRange[1] === undefined
			|| !viewRange.every(Number.isInteger)
		) {
			throw new Error("Invalid `view_range`. It should be a list of two integers.");
		}
		[initialLine, finalLine] = viewRange;
		if (initialLine < 1 || initialLine > allLines.length) {
			throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`);
		}
		if (finalLine > allLines.length) {
			throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``);
		}
		if (finalLine !== -1 && finalLine < initialLine) {
			throw new Error(`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``);
		}
		lines = finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, finalLine);
		prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
	}
	const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`).join("\n");
	return maybeTruncate(`${prompt}:\n${numbered}\n`);
}

async function listDirectory(path: string): Promise<string> {
	async function visit(dir: string, depth: number): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const rows: string[] = [];
		for (const entry of entries.filter((candidate) =>
			!candidate.name.startsWith(".")
			&& candidate.name !== "node_modules"
			&& candidate.name !== "__pycache__"
		)) {
			const fullPath = join(dir, entry.name);
			const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
			rows.push(`${type}\t${fullPath}`);
			if (entry.isDirectory() && depth < 2) rows.push(...await visit(fullPath, depth + 1));
		}
		return rows;
	}
	const rows = [`d\t${path}`, ...await visit(path, 1)].sort((left, right) => {
		const leftPath = left.slice(left.indexOf("\t") + 1);
		const rightPath = right.slice(right.indexOf("\t") + 1);
		return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
	});
	return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${maybeTruncate(rows.join("\n") + "\n")}\n`;
}

async function executeEditor(args: EditorArgs): Promise<AgentToolResult<undefined>> {
	const path = requireAbsolute(args.path);
	switch (args.command) {
		case "view": {
			const info = await statExisting(path, "view");
			if (info.isDirectory()) {
				if (args.view_range != null) throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
				return textResult(await listDirectory(path));
			}
			if (!info.isFile()) throw new Error(`cannot view "${path}": not a regular file or directory`);
			return textResult(formatFileView(path, await readFile(path, "utf8"), args.view_range ?? undefined));
		}
		case "create": {
			if (args.file_text == null) throw new Error("Parameter `file_text` is required for command: create");
			try {
				await access(path, constants.F_OK);
				throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("File already exists")) throw error;
			}
			await writeFile(path, args.file_text, { encoding: "utf8", flag: "wx" });
			return textResult(`New file created successfully at: ${path}`);
		}
		case "str_replace": {
			if (args.new_str === null) throw new Error("Parameter `new_str` must be omitted or contain a string for command: str_replace");
			if (args.old_str == null || args.old_str.length === 0) throw new Error("Parameter `old_str` is required for command: str_replace");
			const info = await statExisting(path, "str_replace");
			if (!info.isFile()) throw new Error(`cannot edit "${path}": not a regular file`);
			const before = await readFile(path, "utf8");
			const offsets = matchOffsets(before, args.old_str);
			const offset = offsets[0];
			if (offset === undefined) {
				throw new Error(`No replacement was performed, old_str \`${args.old_str}\` did not appear verbatim in ${path}.`);
			}
			if (offsets.length > 1) {
				const lines = lineNumbersAt(before, offsets);
				throw new Error(`No replacement was performed. Multiple occurrences of old_str \`${args.old_str}\` in lines [${lines.join(", ")}]. Please ensure it is unique`);
			}
			await writeFile(path, before.slice(0, offset) + (args.new_str ?? "") + before.slice(offset + args.old_str.length), "utf8");
			return textResult(`The file ${path} has been edited successfully.`);
		}
		case "insert": {
			if (args.insert_line == null) throw new Error("Parameter `insert_line` is required for command: insert");
			if (args.new_str == null) throw new Error("Parameter `new_str` is required for command: insert");
			const info = await statExisting(path, "insert");
			if (!info.isFile()) throw new Error(`cannot insert into "${path}": not a regular file`);
			const before = await readFile(path, "utf8");
			const lines = before.split("\n");
			if (!Number.isInteger(args.insert_line) || args.insert_line < 0 || args.insert_line > lines.length) {
				throw new Error(`Invalid \`insert_line\` parameter: ${args.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`);
			}
			const after = [
				...lines.slice(0, args.insert_line),
				...args.new_str.split("\n"),
				...lines.slice(args.insert_line),
			].join("\n");
			await writeFile(path, after, "utf8");
			return textResult(`The file ${path} has been edited successfully.`);
		}
	}
}

function quoteForBash(value: string): string {
	return `$'${value
		.replaceAll("\\", "\\\\")
		.replaceAll("'", "\\'")
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n")}'`;
}

function trimTrailingNewline(text: string): string {
	return text.replace(/\r?\n$/, "");
}

function appendStatusMarker(content: string, marker?: string): string {
	if (marker === undefined) return content;
	return content.length === 0 ? marker : `${content}\n${marker}`;
}

function outputAfterStart(output: string, start: string): string {
	const startIndex = output.lastIndexOf(start);
	const partial = startIndex >= 0 ? output.slice(startIndex + start.length) : output;
	return trimTrailingNewline(partial.replace(/^\r?\n/, ""));
}

class PersistentBash {
	private child: ChildProcessWithoutNullStreams | undefined;
	private cwd: string | undefined;
	private queue: Promise<void> = Promise.resolve();

	async execute(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
		if (command.trim().length === 0) throw new Error("command must be a non-empty string");
		if (this.cwd !== cwd) await this.reset("working directory changed");
		this.cwd = cwd;
		const run = this.queue.then(() => this.executeSerialized(command, signal));
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	async reset(_reason: string): Promise<void> {
		const child = this.child;
		this.child = undefined;
		if (!child || child.killed) return;
		try {
			if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
			else child.kill("SIGTERM");
		} catch {
			// The process may already be gone.
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				try {
					if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch {}
				resolve();
			}, 250);
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	private ensureShell(cwd: string): ChildProcessWithoutNullStreams {
		if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
		const child = spawn("bash", ["--noprofile", "--norc"], {
			cwd,
			detached: process.platform !== "win32",
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		return child;
	}

	private executeSerialized(command: string, signal?: AbortSignal): Promise<string> {
		const child = this.ensureShell(this.cwd ?? process.cwd());
		const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const start = `__DSH_PI_MINIMAL_BASH_START_${nonce}__`;
		const end = `__DSH_PI_MINIMAL_BASH_END_${nonce}:`;
		const wrapped = `printf '%s\\n' ${quoteForBash(start)}; eval -- ${quoteForBash(command)}; __dsh_pi_minimal_status=$?; printf '%s%s\\n' ${quoteForBash(end)} "$__dsh_pi_minimal_status"`;

		return new Promise<string>((resolve, reject) => {
			let output = "";
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				child.stdout.off("data", onData);
				child.stderr.off("data", onData);
				child.off("close", onClose);
				child.off("error", onError);
				callback();
			};
			const completeIfDone = () => {
				const endIndex = output.lastIndexOf(end);
				if (endIndex < 0) return;
				const status = /^(\d+)\r?\n?/.exec(output.slice(endIndex + end.length))?.[1];
				if (status === undefined) return;
				const startIndex = output.lastIndexOf(start, endIndex);
				const raw = output.slice(startIndex >= 0 ? startIndex + start.length : 0, endIndex).replace(/^\r?\n/, "");
				const clipped = maybeTruncate(trimTrailingNewline(raw));
				const exitCode = Number(status);
				finish(() => resolve(appendStatusMarker(clipped, exitCode === 0 ? undefined : `[exit code: ${exitCode}]`)));
			};
			const onData = (chunk: Buffer) => {
				output += chunk.toString("utf8");
				completeIfDone();
			};
			const resetAndResolve = async (text: string) => {
				await this.reset("persistent bash command ended the shell");
				resolve(text);
			};
			const onClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
				const rendered = maybeTruncate(outputAfterStart(output, start));
				const marker = closeSignal !== null
					? `[shell killed by signal: ${closeSignal}]`
					: code !== null
						? `[shell exited: code ${code}]`
						: "[shell exited]";
				finish(() => {
					void resetAndResolve([
						appendStatusMarker(rendered, marker),
						SHELL_RESET_MESSAGE,
					].filter((part) => part.length > 0).join("\n"));
				});
			};
			const onError = (error: Error) => finish(() => reject(error));
			const onAbort = () => {
				finish(() => {
					void this.reset("persistent bash command aborted").finally(() => reject(new Error("aborted")));
				});
			};
			const timer = setTimeout(() => {
				const partial = maybeTruncate(outputAfterStart(output, start));
				finish(() => {
					void this.reset("persistent bash command timed out").then(() => resolve([
						`Your command timed out after ${Math.round(BASH_TIMEOUT_MS / 1000)} seconds or experienced an OOM error. Below is partial output:`,
						partial,
						SHELL_RESET_MESSAGE,
					].filter((part) => part.length > 0).join("\n")));
				});
			}, BASH_TIMEOUT_MS);

			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			child.once("close", onClose);
			child.once("error", onError);
			child.stdin.write(`${wrapped}\n`, (error) => {
				if (error) finish(() => reject(error));
			});
		});
	}
}

class PersistentBashPool {
	private readonly shells = new Map<string, PersistentBash>();

	async execute(command: string, cwd: string, owner: string, signal?: AbortSignal): Promise<string> {
		let shell = this.shells.get(owner);
		if (!shell) {
			shell = new PersistentBash();
			this.shells.set(owner, shell);
		}
		return shell.execute(command, cwd, signal);
	}

	async resetAll(): Promise<void> {
		const shells = [...this.shells.values()];
		this.shells.clear();
		await Promise.all(shells.map((shell) => shell.reset("session shutdown")));
	}
}

export default function registerDeepSeekMinimalTools(pi: ExtensionAPI): void {
	const shells = new PersistentBashPool();
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: BASH_DESCRIPTION,
		parameters: bashSchema,
		executionMode: "sequential",
		async execute(_toolCallId, args, signal, _onUpdate, ctx) {
			return textResult(await shells.execute(args.command, ctx.cwd, ctx.sessionManager.getSessionId(), signal));
		},
	});
	pi.registerTool({
		name: "str_replace_editor",
		label: "str_replace_editor",
		description: STR_REPLACE_EDITOR_DESCRIPTION,
		parameters: editorSchema,
		executionMode: "sequential",
		async execute(_toolCallId, args) {
			return executeEditor(args);
		},
	});
	pi.on("session_shutdown", async () => {
		await shells.resetAll();
	});
}
