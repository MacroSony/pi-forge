import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession, } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_CONTRACT_VERSION, canonicalSubagentJson, negotiateSubagentTools, subagentPromptRuntimeFingerprint, } from "./contract.js";
import { modelRuntimeFromRegistry } from "./pi-model-runtime.js";
import { PI_FORGE_SUBPROCESS_REPORT_FD_ENV, sanitizeSubprocessReportValue, } from "./subprocess-report.js";
export const PI_SUBPROCESS_READONLY_BACKEND_ID = "pi-subprocess-readonly";
export const PI_FORGE_SUBPROCESS_INPUT_ENV = "PI_FORGE_SUBAGENT_BRIDGE_INPUT";
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const ACCESS_CAPABILITIES = {
    readOnlyMountIsolation: false,
    readWriteMountIsolation: false,
    symlinkSafeContainment: false,
    processIsolation: false,
    agentNetworkIsolation: false,
};
const READ_ONLY_TOOL_CATALOG = [
    { id: "pi.read", name: "read", description: "Read a file.", effects: ["filesystem-read"], adapterMapping: "pi:read" },
    { id: "pi.grep", name: "grep", description: "Search file contents.", effects: ["filesystem-read"], adapterMapping: "pi:grep" },
    { id: "pi.find", name: "find", description: "Find files by pattern.", effects: ["filesystem-read"], adapterMapping: "pi:find" },
    { id: "pi.ls", name: "ls", description: "List directory contents.", effects: ["filesystem-read"], adapterMapping: "pi:ls" },
];
export const PI_SUBPROCESS_READONLY_BACKEND_DESCRIPTOR = {
    id: PI_SUBPROCESS_READONLY_BACKEND_ID,
    version: "0.1.0",
    capabilities: {
        access: { ...ACCESS_CAPABILITIES },
        limits: {
            timeoutMs: ["host-abort"],
            maxTurns: ["unsupported"],
            tokenBudget: ["unsupported"],
            maxOutputBytes: ["unsupported"],
        },
        cancellation: true,
        mediaMimeTypes: [],
        traceInspection: false,
        artifactRetention: false,
        remoteTransport: true,
        promptRuntimeFidelity: "backend-assisted",
    },
};
export class PiSubprocessBackend {
    descriptor = structuredClone(PI_SUBPROCESS_READONLY_BACKEND_DESCRIPTOR);
    #modelRegistry;
    #modelRuntime;
    #cwd;
    #now;
    #idFactory;
    #invocationFactory;
    #bridgePath;
    #primed = new Map();
    #active = new Map();
    #reports = new Map();
    constructor(options) {
        this.#modelRegistry = options.modelRegistry;
        this.#modelRuntime = options.modelRuntime ?? modelRuntimeFromRegistry(options.modelRegistry);
        this.#cwd = options.cwd;
        this.#now = options.now ?? (() => new Date());
        this.#idFactory = options.idFactory ?? (() => `pi-subprocess-preflight:${randomUUID()}`);
        this.#invocationFactory = options.invocationFactory ?? defaultPiInvocation;
        this.#bridgePath = options.bridgePath ?? defaultBridgePath();
    }
    preflight(input) {
        const diagnostics = [];
        const access = input.request.access;
        if (access.level !== "read-only" || access.workspaces.length !== 1 || access.workspaces[0]?.mode !== "read-only") {
            diagnostics.push(errorDiagnostic("pi-subprocess.access", "The subprocess backend requires one read-only workspace.", "access"));
        }
        if (access.workingDirectory?.workspaceHandle !== access.workspaces[0]?.handle || access.workingDirectory?.path !== ".") {
            diagnostics.push(errorDiagnostic("pi-subprocess.cwd", "The subprocess backend requires the requested workspace root as its working directory.", "access.workingDirectory"));
        }
        if (access.network !== "allow")
            diagnostics.push(errorDiagnostic("pi-subprocess.network", "A shared-user subprocess cannot honestly enforce network deny.", "access.network"));
        if (access.allowProcess === true)
            diagnostics.push(errorDiagnostic("pi-subprocess.process", "The read-only subprocess does not expose process tools.", "access.allowProcess"));
        if ((input.request.input.media?.length ?? 0) > 0)
            diagnostics.push(errorDiagnostic("pi-subprocess.media", "The first subprocess backend supports text tasks only.", "input.media"));
        for (const name of ["maxTurns", "tokenBudget", "maxOutputBytes"]) {
            const requirement = input.request.limits[name];
            if (requirement?.enforcement === "required")
                diagnostics.push(errorDiagnostic("pi-subprocess.limit", `${name} cannot be enforced by the subprocess backend.`, `limits.${name}`));
            else if (requirement)
                diagnostics.push(warningDiagnostic("pi-subprocess.limit-ignored", `${name} is unsupported and will not be accepted.`, `limits.${name}`));
        }
        const model = this.#modelRegistry.find(input.snapshot.profile.model.provider, input.snapshot.profile.model.id);
        if (!model)
            diagnostics.push(errorDiagnostic("pi-subprocess.model", `Unknown model: ${input.snapshot.profile.model.provider}/${input.snapshot.profile.model.id}`, "profile.model"));
        else {
            if (!this.#modelRegistry.hasConfiguredAuth(model))
                diagnostics.push(errorDiagnostic("pi-subprocess.auth", `Model ${model.provider}/${model.id} has no configured authentication.`, "profile.model"));
            const effectiveThinking = clampThinkingLevel(model, input.snapshot.profile.thinkingLevel);
            if (effectiveThinking !== input.snapshot.profile.thinkingLevel)
                diagnostics.push(errorDiagnostic("pi-subprocess.thinking", `Model ${model.provider}/${model.id} would clamp thinking level ${input.snapshot.profile.thinkingLevel} to ${effectiveThinking}.`, "profile.thinkingLevel"));
        }
        const preflightId = this.#idFactory();
        if (diagnostics.some((diagnostic) => diagnostic.level === "error") || !model) {
            return { status: "rejected", preflightId, backend: structuredClone(this.descriptor), diagnostics };
        }
        const workspace = access.workspaces[0];
        const limits = {};
        if (input.request.limits.timeoutMs)
            limits.timeoutMs = { value: input.request.limits.timeoutMs.value, enforcement: "host-abort" };
        diagnostics.push(warningDiagnostic("pi-subprocess.shared-user", "Read-only is enforced by the model-visible tool allowlist, not by OS isolation; the subprocess retains the invoking user's permissions.", "access"));
        return {
            status: "accepted",
            preflightId,
            backend: structuredClone(this.descriptor),
            model: { provider: model.provider, id: model.id },
            thinkingLevel: input.snapshot.profile.thinkingLevel,
            toolCatalog: structuredClone(READ_ONLY_TOOL_CATALOG),
            access: {
                level: "read-only",
                mounts: [{ workspaceHandle: workspace.handle, mountId: "host-workspace", mode: "read-only" }],
                workingDirectory: { mountId: "host-workspace", path: "." },
                network: "allow",
                process: false,
                executionBoundary: "shared-user",
                enforcement: { ...ACCESS_CAPABILITIES },
            },
            limits,
            diagnostics,
        };
    }
    async prepare(input, context) {
        if (this.#primed.has(input.preflight.preflightId))
            throw new Error(`Pi subprocess preflight is already prepared: ${input.preflight.preflightId}`);
        const model = this.#requireModel(input.preflight.model.provider, input.preflight.model.id);
        const negotiated = negotiateSubagentTools(input.preflight.toolCatalog, input.snapshot.promptStack?.tools, input.request.access);
        const effectiveToolNames = negotiated.effectiveToolNames;
        const tempDir = mkdtempSync(join(tmpdir(), "pi-forge-subprocess-"));
        const providerGate = deferred();
        const preparationReady = deferred();
        let prepared;
        let session;
        try {
            const settingsManager = SettingsManager.create(this.#cwd, tempDir, { projectTrusted: true });
            const resourceLoader = new DefaultResourceLoader({
                cwd: this.#cwd,
                agentDir: tempDir,
                settingsManager,
                extensionFactories: [{
                        name: "pi-forge-subprocess-preparation",
                        factory: this.#compilerBridge(input, context, providerGate, preparationReady, (result) => { prepared = result; }),
                    }],
                noExtensions: true,
                noSkills: true,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
            });
            await resourceLoader.reload();
            const created = await createAgentSession({
                cwd: this.#cwd,
                agentDir: tempDir,
                modelRuntime: this.#modelRuntime,
                model,
                thinkingLevel: input.preflight.thinkingLevel,
                resourceLoader,
                settingsManager,
                sessionManager: SessionManager.inMemory(this.#cwd),
                noTools: "all",
                tools: effectiveToolNames,
            });
            session = created.session;
            session.setActiveToolsByName(effectiveToolNames);
            const execution = this.#startPreparation(session, input.request.input.text, preparationReady);
            const result = await abortable(preparationReady.promise, context.signal);
            if (!prepared || canonicalSubagentJson(prepared) !== canonicalSubagentJson(result))
                throw new Error("Pi subprocess preparation bridge returned inconsistent host preparation.");
            this.#primed.set(input.preflight.preflightId, {
                preflightId: input.preflight.preflightId,
                requestId: input.request.requestId,
                result,
                session,
                tempDir,
                providerGate,
                execution,
                disposed: false,
            });
            return structuredClone(result);
        }
        catch (error) {
            providerGate.reject(new Error("Subprocess dry preparation stopped before provider transport."));
            if (session) {
                await session.abort().catch(() => undefined);
                session.dispose();
            }
            rmSync(tempDir, { recursive: true, force: true });
            throw error;
        }
    }
    async execute(plan, context) {
        const primed = this.#primed.get(plan.preflightId);
        if (!primed || primed.requestId !== plan.requestId)
            throw new Error("Pi subprocess execution has no matching prepared plan.");
        if (primed.result.runtime.promptRuntimeFingerprint !== plan.promptRuntimeFingerprint
            || primed.result.preparation.systemPrompt !== plan.systemPrompt
            || canonicalSubagentJson(primed.result.preparation.messages) !== canonicalSubagentJson(plan.messages)) {
            await this.#stopPreparation(primed);
            throw new Error("Pi subprocess execution plan does not match its prepared prompt.");
        }
        await this.#stopPreparation(primed);
        const effectiveToolNames = toolNamesForPlan(plan);
        const report = createReport(plan, this.#cwd, effectiveToolNames, this.#now());
        this.#reports.set(plan.runId, report);
        context.onUpdate?.({ phase: "starting", message: `Starting ${plan.profile.profile.id} with ${effectiveToolNames.join(", ") || "no tools"}.`, details: reportSummary(report) });
        const runDir = mkdtempSync(join(tmpdir(), "pi-forge-subprocess-run-"));
        const inputPath = join(runDir, "bridge-input.json");
        const systemPromptPath = join(runDir, "system-prompt.md");
        const marker = `PI_FORGE_SUBAGENT_MARKER_${randomUUID()}`;
        writeFileSync(inputPath, JSON.stringify({
            marker,
            systemPrompt: plan.systemPrompt,
            messages: plan.messages,
            model: plan.model,
            effectiveToolNames,
        }), { encoding: "utf8", mode: 0o600 });
        writeFileSync(systemPromptPath, plan.systemPrompt, { encoding: "utf8", mode: 0o600 });
        try {
            const piArgs = subprocessArguments(plan, effectiveToolNames, this.#bridgePath, systemPromptPath, marker);
            const invocation = this.#invocationFactory(piArgs);
            const terminal = await this.#runChild(invocation, plan, report, inputPath, context);
            return terminal;
        }
        finally {
            rmSync(runDir, { recursive: true, force: true });
        }
    }
    async cancel(input) {
        const child = this.#active.get(input.runId);
        if (child)
            terminateChild(child);
    }
    async discard(preflightId) {
        const primed = this.#primed.get(preflightId);
        if (!primed)
            return false;
        await this.#stopPreparation(primed);
        return true;
    }
    takeReport(runId) {
        const report = this.#reports.get(runId);
        if (!report)
            return undefined;
        this.#reports.delete(runId);
        return sanitizePiSubprocessRunReport(report);
    }
    async dispose() {
        for (const primed of [...this.#primed.values()])
            await this.#stopPreparation(primed);
        for (const child of this.#active.values())
            terminateChild(child);
        this.#primed.clear();
        this.#active.clear();
        this.#reports.clear();
    }
    #compilerBridge(input, context, providerGate, preparationReady, setPrepared) {
        return (pi) => {
            let prepared;
            pi.on("before_agent_start", async (event) => {
                try {
                    const runtime = this.#runtimeSnapshot(input.preflight, event.systemPrompt, event.systemPromptOptions);
                    prepared = await context.prepare(runtime);
                    setPrepared(prepared);
                    preparationReady.resolve(prepared);
                    return { systemPrompt: prepared.preparation.systemPrompt };
                }
                catch (error) {
                    preparationReady.reject(error);
                    providerGate.reject(error);
                    throw error;
                }
            });
            pi.on("context", () => {
                if (!prepared)
                    throw new Error("Pi subprocess context event arrived before host preparation.");
                return { messages: prepared.preparation.messages.map((message, index) => preparedMessageToAgentMessage(message, input.preflight, index)) };
            });
            pi.on("before_provider_request", async () => {
                await providerGate.promise;
            });
        };
    }
    #runtimeSnapshot(preflight, baseSystemPrompt, options) {
        const runtime = {
            baseSystemPrompt,
            options: {
                customPrompt: options.customPrompt,
                selectedTools: [...options.selectedTools ?? []],
                toolSnippets: { ...options.toolSnippets ?? {} },
                promptGuidelines: [...options.promptGuidelines ?? []],
                appendSystemPrompt: options.appendSystemPrompt,
                cwd: options.cwd,
                contextFiles: [],
                skills: [],
            },
            model: structuredClone(preflight.model),
            preparedAt: this.#now().toISOString(),
            fidelity: "backend-assisted",
        };
        return { ...runtime, promptRuntimeFingerprint: subagentPromptRuntimeFingerprint(runtime) };
    }
    async #startPreparation(session, task, preparationReady) {
        try {
            await session.prompt(task, { source: "extension" });
            await session.waitForIdle();
        }
        catch (error) {
            preparationReady.reject(error);
        }
    }
    async #stopPreparation(primed) {
        if (primed.disposed)
            return;
        primed.disposed = true;
        this.#primed.delete(primed.preflightId);
        void primed.session.abort();
        primed.providerGate.reject(new Error("Subprocess dry preparation completed without provider transport."));
        await primed.execution.catch(() => undefined);
        primed.session.dispose();
        rmSync(primed.tempDir, { recursive: true, force: true });
    }
    async #runChild(invocation, plan, report, inputPath, context) {
        let stdoutBytes = 0;
        let reportBytes = 0;
        let settled = false;
        const child = spawn(invocation.command, invocation.args, {
            cwd: this.#cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                [PI_FORGE_SUBPROCESS_INPUT_ENV]: inputPath,
                [PI_FORGE_SUBPROCESS_REPORT_FD_ENV]: "3",
            },
        });
        this.#active.set(plan.runId, child);
        const abort = () => terminateChild(child);
        if (context.signal.aborted)
            abort();
        else
            context.signal.addEventListener("abort", abort, { once: true });
        const failStream = (message) => {
            if (!report.errorMessage)
                report.errorMessage = message;
            terminateChild(child);
        };
        const processLine = (line) => {
            if (!line.trim())
                return;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                failStream("Subprocess bridge emitted malformed report JSON.");
                return;
            }
            if (event.type === "message_end" && event.message) {
                const message = sanitizePiSubprocessMessage(event.message);
                report.messages.push(message);
                captureAssistantReceipt(report, message);
                if (isRecord(message) && message.role === "toolResult") {
                    context.onUpdate?.({ phase: "tool-result", message: toolResultSummary(message), details: reportSummary(report) });
                }
                else {
                    context.onUpdate?.({ phase: "message", message: latestAssistantText(report.messages) || "Subagent completed a model turn.", details: reportSummary(report) });
                }
            }
            else if (event.type === "tool_result_end" && event.message) {
                const message = sanitizePiSubprocessMessage(event.message);
                report.messages.push(message);
                context.onUpdate?.({ phase: "tool-result", message: toolResultSummary(message), details: reportSummary(report) });
            }
        };
        if (!child.stdout) {
            failStream("Subprocess text output channel was unavailable.");
        }
        else {
            child.stdout.on("data", (chunk) => {
                stdoutBytes += chunk.length;
                if (stdoutBytes > MAX_STDOUT_BYTES)
                    failStream(`Subprocess text output exceeded ${MAX_STDOUT_BYTES} bytes.`);
            });
        }
        const reportStream = child.stdio[3];
        if (!reportStream) {
            failStream("Subprocess bridge report channel was unavailable.");
        }
        else {
            reportStream.on("data", (chunk) => {
                reportBytes += chunk.length;
                if (reportBytes > MAX_REPORT_STREAM_BYTES)
                    failStream(`Sanitized subprocess report stream exceeded ${MAX_REPORT_STREAM_BYTES} bytes.`);
            });
            createInterface({ input: reportStream, crlfDelay: Infinity }).on("line", processLine);
        }
        if (!child.stderr) {
            failStream("Subprocess error output channel was unavailable.");
        }
        else {
            child.stderr.on("data", (chunk) => {
                if (Buffer.byteLength(report.stderr, "utf8") >= MAX_STDERR_BYTES)
                    return;
                report.stderr = appendBounded(report.stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
            });
        }
        const outcome = await new Promise((resolve) => {
            child.once("error", (error) => resolve({ code: null, signal: null, spawnError: error }));
            child.once("close", (code, signal) => resolve({ code, signal }));
        });
        if (settled)
            throw new Error("Subprocess completion settled more than once.");
        settled = true;
        context.signal.removeEventListener("abort", abort);
        this.#active.delete(plan.runId);
        report.exitCode = outcome.code ?? undefined;
        report.signal = outcome.signal ?? undefined;
        report.finishedAt = this.#now().toISOString();
        if (outcome.spawnError)
            report.errorMessage = outcome.spawnError.message;
        const output = latestAssistantText(report.messages);
        const common = backendResponseCommon(plan);
        if (context.signal.aborted) {
            report.status = "cancelled";
            context.onUpdate?.({ phase: "finishing", message: "Subagent cancelled.", details: reportSummary(report) });
            return { ...common, status: "cancelled", reason: abortReason(context.signal) };
        }
        if (outcome.spawnError || outcome.code !== 0 || report.stopReason === "error" || report.stopReason === "aborted" || report.errorMessage) {
            report.status = "failed";
            const message = report.errorMessage || report.stderr.trim() || `Pi subprocess exited with code ${outcome.code ?? "unknown"}.`;
            context.onUpdate?.({ phase: "finishing", message: `Subagent failed: ${message}`, details: reportSummary(report) });
            return {
                ...common,
                status: "failed",
                error: { code: "subprocess", message, retryable: false },
                output: output ? { text: output.slice(0, plan.resultProjection.maxChars), partial: true } : undefined,
            };
        }
        if (!output) {
            report.status = "failed";
            report.errorMessage = "Pi subprocess produced no assistant report.";
            return { ...common, status: "failed", error: { code: "subprocess-empty", message: report.errorMessage, retryable: false } };
        }
        report.status = "completed";
        context.onUpdate?.({ phase: "finishing", message: "Subagent report ready.", details: reportSummary(report) });
        return { ...common, status: "completed", output: { text: output.slice(0, plan.resultProjection.maxChars), partial: false } };
    }
    #requireModel(provider, id) {
        const model = this.#modelRegistry.find(provider, id);
        if (!model)
            throw new Error(`Pi subprocess model disappeared after preflight: ${provider}/${id}`);
        return model;
    }
}
export function sanitizePiSubprocessRunReport(report) {
    return {
        ...report,
        model: { ...report.model },
        effectiveToolNames: [...report.effectiveToolNames],
        messages: report.messages.map(sanitizeSubprocessReportValue),
        usage: { ...report.usage },
    };
}
function sanitizePiSubprocessMessage(value) {
    return sanitizeSubprocessReportValue(value);
}
function defaultPiInvocation(piArgs) {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && existsSync(currentScript))
        return { command: process.execPath, args: [currentScript, ...piArgs] };
    const execName = basename(process.execPath).toLowerCase();
    if (!/^(node|bun)(\.exe)?$/.test(execName))
        return { command: process.execPath, args: piArgs };
    return { command: "pi", args: piArgs };
}
function defaultBridgePath() {
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    return join(dirname(fileURLToPath(import.meta.url)), `subprocess-bridge${extension}`);
}
function subprocessArguments(plan, toolNames, bridgePath, systemPromptPath, marker) {
    const args = [
        "--mode", "text",
        "--print",
        "--no-session",
        "--model", `${plan.model.provider}/${plan.model.id}`,
        "--thinking", plan.thinkingLevel,
        "--system-prompt", systemPromptPath,
        "--extension", bridgePath,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--approve",
    ];
    if (toolNames.length > 0)
        args.push("--tools", toolNames.join(","));
    else
        args.push("--no-tools");
    args.push(marker);
    return args;
}
function toolNamesForPlan(plan) {
    const byId = new Map(plan.preflight.toolCatalog.map((tool) => [tool.id, tool.name]));
    return plan.effectiveToolIds.map((id) => {
        const name = byId.get(id);
        if (!name)
            throw new Error(`Prepared subprocess tool disappeared from its catalog: ${id}`);
        return name;
    });
}
function createReport(plan, cwd, toolNames, now) {
    return {
        runId: plan.runId,
        executionFingerprint: plan.executionFingerprint,
        status: "running",
        startedAt: now.toISOString(),
        model: structuredClone(plan.model),
        thinkingLevel: plan.thinkingLevel,
        effectiveToolNames: [...toolNames],
        executionBoundary: "shared-user",
        workingDirectory: cwd,
        messages: [],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
    };
}
function reportSummary(report) {
    const { messages, stderr, ...rest } = report;
    return { ...rest, usage: { ...report.usage }, effectiveToolNames: [...report.effectiveToolNames], messageCount: messages.length, stderrBytes: Buffer.byteLength(stderr, "utf8") };
}
function captureAssistantReceipt(report, value) {
    if (!isRecord(value) || value.role !== "assistant")
        return;
    report.usage.turns += 1;
    if (isRecord(value.usage)) {
        report.usage.input += numberOrZero(value.usage.input);
        report.usage.output += numberOrZero(value.usage.output);
        report.usage.cacheRead += numberOrZero(value.usage.cacheRead);
        report.usage.cacheWrite += numberOrZero(value.usage.cacheWrite);
        report.usage.totalTokens += numberOrZero(value.usage.totalTokens);
        if (isRecord(value.usage.cost))
            report.usage.cost += numberOrZero(value.usage.cost.total);
    }
    if (typeof value.stopReason === "string")
        report.stopReason = value.stopReason;
    if (typeof value.errorMessage === "string")
        report.errorMessage = value.errorMessage;
}
function latestAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content))
            continue;
        const text = message.content.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text)).join("");
        if (text.trim())
            return text.trim();
    }
    return "";
}
function toolResultSummary(value) {
    if (!isRecord(value))
        return "Subagent tool result received.";
    const name = typeof value.toolName === "string" ? value.toolName : "tool";
    const error = value.isError === true ? " failed" : " completed";
    return `${name}${error}.`;
}
function appendBounded(current, addition, maxBytes) {
    const remaining = maxBytes - Buffer.byteLength(current, "utf8");
    if (remaining <= 0)
        return current;
    const bytes = Buffer.from(addition, "utf8");
    return current + bytes.subarray(0, remaining).toString("utf8");
}
function terminateChild(child) {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
    }, 5_000);
    force.unref();
}
function preparedMessageToAgentMessage(message, preflight, index) {
    if (message.content.some((part) => part.type === "media"))
        throw new Error("Subprocess media preparation is not implemented.");
    const content = message.content.map((part) => ({ type: "text", text: part.type === "text" ? part.text : "" }));
    if (message.role === "user")
        return { role: "user", content: content.length === 1 ? content[0].text : content, timestamp: index };
    if (message.role === "custom")
        return { role: "custom", customType: "pi-forge-subagent", content, display: false, details: {}, timestamp: index };
    return {
        role: "assistant",
        content,
        api: "unknown",
        provider: preflight.model.provider,
        model: preflight.model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: index,
    };
}
function backendResponseCommon(plan) {
    return {
        schemaVersion: SUBAGENT_CONTRACT_VERSION,
        requestId: plan.requestId,
        runId: plan.runId,
        backendId: plan.backendId,
        profileFingerprint: plan.profile.profileFingerprint,
        executionFingerprint: plan.executionFingerprint,
        model: structuredClone(plan.model),
        effectiveToolIds: [...plan.effectiveToolIds],
        enforcement: { access: structuredClone(plan.access), limits: structuredClone(plan.limits) },
        durationMs: 0,
        artifacts: [],
    };
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
}
async function abortable(promise, signal) {
    if (!signal)
        return promise;
    if (signal.aborted)
        throw new Error("Pi subprocess preparation was cancelled.");
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error("Pi subprocess preparation was cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
function abortReason(signal) {
    return typeof signal.reason === "string" && signal.reason ? signal.reason : "Subprocess execution cancelled.";
}
function errorDiagnostic(code, message, path) {
    return { level: "error", code, message, path };
}
function warningDiagnostic(code, message, path) {
    return { level: "warning", code, message, path };
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function numberOrZero(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
//# sourceMappingURL=pi-subprocess-backend.js.map