#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createFileBackedPlatoConfigService } from "@plato/config";
import type { CodexOptions } from "@openai/codex-sdk";
import type {
  CreateTaskGraphInput,
  ParentTaskSynthesisRecord,
  RunnerTaskRecord,
  RunnerTaskGraphResultSnapshot,
  RunnerTaskGraphSnapshot,
  RunnerTaskState,
  RunnerTaskStatusSnapshot,
  SessionEvent,
} from "./contracts.js";
import { CodexRunnerService } from "./codex-runner-service.js";
import { FileLogStreamer } from "./logs/file-log-streamer.js";
import { DefaultCodexRuntimeManager } from "./runtime/codex-runtime-manager.js";
import { CodexSdkBackedAgentSessionFactory } from "./session/codex-sdk-backed-agent-session.js";
import { openCodexRunnerPersistence } from "./store/sqlite-runner-persistence.js";
import { GitWorktreeManager } from "./worktree/git-worktree-manager.js";

type Writer = {
  write(chunk: string): void;
};

export interface RunnerOperatorClient {
  startTask(input: {
    taskId: string;
    repoPath: string;
    prompt: string;
    priority?: number;
  }): Promise<RunnerTaskRecord>;
  createTaskGraph(input: CreateTaskGraphInput): Promise<RunnerTaskGraphSnapshot>;
  getTask(taskId: string): Promise<RunnerTaskRecord | undefined>;
  getTaskGraph(taskId: string): Promise<RunnerTaskGraphSnapshot | undefined>;
  getTaskGraphResults(taskId: string): Promise<RunnerTaskGraphResultSnapshot | undefined>;
  reconcileTaskGraphResults?(taskId: string): Promise<RunnerTaskGraphResultSnapshot | undefined>;
  getTaskStatus(taskId: string): Promise<RunnerTaskStatusSnapshot | undefined>;
  listTasks(): Promise<RunnerTaskRecord[]>;
  listTasksByState(state: RunnerTaskState): Promise<RunnerTaskRecord[]>;
  listEvents(taskId: string): Promise<SessionEvent[]>;
  interruptTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<RunnerTaskRecord>;
}

export interface OperatorRuntime {
  service: RunnerOperatorClient;
  close(): void;
}

export interface OperatorRuntimeOptions {
  dbPath?: string;
  logPath?: string;
  configPath?: string;
  secretsPath?: string;
  cwd?: string;
  maxConcurrentTasks?: number;
}

export interface RunCodexRunnerCliOptions {
  cwd?: string;
  stdout?: Writer;
  stderr?: Writer;
  openRuntime?: (options: OperatorRuntimeOptions) => Promise<OperatorRuntime> | OperatorRuntime;
}

export async function runCodexRunnerCli(
  argv: string[],
  options: RunCodexRunnerCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = options.cwd ?? process.cwd();
  const openRuntime = options.openRuntime ?? openOperatorRuntime;
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help") {
    stdout.write(`${buildHelpText()}\n`);
    return 0;
  }

  try {
    switch (command) {
      case "start":
        return await handleStart(rest, { cwd, stdout, openRuntime });
      case "status":
        return await handleStatus(rest, { cwd, stdout, openRuntime });
      case "graph":
        return await handleGraph(rest, { cwd, stdout, openRuntime });
      case "events":
        return await handleEvents(rest, { cwd, stdout, openRuntime });
      case "interrupt":
        return await handleInterrupt(rest, { cwd, stdout, openRuntime });
      case "resume":
        return await handleResume(rest, { cwd, stdout, openRuntime });
      case "config":
        return await handleConfig(rest, { cwd, stdout });
      default:
        stderr.write(`Unknown command: ${command}\n\n${buildHelpText()}\n`);
        return 1;
    }
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

async function handleConfig(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout">,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "status":
      return handleConfigStatus(rest, options);
    case "set-openai-key":
      return handleConfigSetOpenAIKey(rest, options);
    case "clear-openai-key":
      return handleConfigClearOpenAIKey(rest, options);
    case "auth-chatgpt":
      throw new Error("ChatGPT OAuth is not implemented yet; use config set-openai-key for Milestone 21");
    default:
      throw new Error("config requires a subcommand: status, set-openai-key, clear-openai-key, or auth-chatgpt");
  }
}

async function handleConfigStatus(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout">,
): Promise<number> {
  const service = openConfigService(argv, options.cwd);
  writeJson(options.stdout ?? process.stdout, await service.getStatus());
  return 0;
}

async function handleConfigSetOpenAIKey(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout">,
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      "api-key": { type: "string" },
      "config-path": { type: "string" },
      "secrets-path": { type: "string" },
    },
  });
  const apiKey = parsed.values["api-key"]?.trim();
  if (!apiKey) {
    throw new Error("config set-openai-key requires --api-key");
  }

  const service = createFileBackedPlatoConfigService({
    configPath: resolveOptionalPath(options.cwd, parsed.values["config-path"]),
    secretsPath: resolveOptionalPath(options.cwd, parsed.values["secrets-path"]),
  });
  writeJson(options.stdout ?? process.stdout, await service.setOpenAIApiKey(apiKey));
  return 0;
}

async function handleConfigClearOpenAIKey(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout">,
): Promise<number> {
  const service = openConfigService(argv, options.cwd);
  writeJson(options.stdout ?? process.stdout, await service.clearCodexAuth());
  return 0;
}

async function handleGraph(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  switch (subcommand) {
    case "start":
      return handleGraphStart(rest, options);
    case "status":
      return handleGraphStatus(rest, options);
    case "results":
      return handleGraphResults(rest, options);
    case "synthesis":
      return handleGraphSynthesis(rest, options);
    default:
      throw new Error("graph requires a subcommand: start, status, results, or synthesis");
  }
}

async function handleGraphStart(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      "task-id": { type: "string" },
      "repo-path": { type: "string" },
      prompt: { type: "string" },
      priority: { type: "string" },
      child: { type: "string", multiple: true },
      "max-concurrent-tasks": { type: "string" },
      "db-path": { type: "string" },
      "log-path": { type: "string" },
    },
  });
  const prompt = parsed.values.prompt?.trim();
  if (!prompt) {
    throw new Error("graph start requires --prompt");
  }

  const children = (parsed.values.child ?? []).map(parseChildSpec);
  const runtime = await options.openRuntime?.({
    cwd: options.cwd,
    dbPath: parsed.values["db-path"],
    logPath: parsed.values["log-path"],
    maxConcurrentTasks: parseOptionalInteger(parsed.values["max-concurrent-tasks"], "max concurrent tasks"),
  });

  if (!runtime) {
    throw new Error("operator runtime was not created");
  }

  try {
    const graph = await runtime.service.createTaskGraph({
      parent: {
        taskId: parsed.values["task-id"] ?? randomUUID(),
        repoPath: resolve(parsed.values["repo-path"] ?? options.cwd ?? process.cwd()),
        prompt,
        priority: parseOptionalInteger(parsed.values.priority, "priority"),
      },
      children,
    });
    writeJson(options.stdout ?? process.stdout, graph);
    return 0;
  } finally {
    runtime.close();
  }
}

async function handleGraphStatus(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "db-path": { type: "string" },
      "log-path": { type: "string" },
    },
  });
  const [taskId] = parsed.positionals;
  if (!taskId) {
    throw new Error("graph status requires a task id");
  }

  const runtime = await options.openRuntime?.({
    cwd: options.cwd,
    dbPath: parsed.values["db-path"],
    logPath: parsed.values["log-path"],
  });

  if (!runtime) {
    throw new Error("operator runtime was not created");
  }

  try {
    const graph = await runtime.service.getTaskGraph(taskId);
    if (!graph) {
      throw new Error(`Task graph ${taskId} was not found`);
    }
    writeJson(options.stdout ?? process.stdout, graph);
    return 0;
  } finally {
    runtime.close();
  }
}

async function handleGraphResults(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const snapshot = await loadGraphResults(argv, options, "graph results");
  writeJson(options.stdout ?? process.stdout, snapshot);
  return 0;
}

async function handleGraphSynthesis(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const snapshot = await loadGraphResults(argv, options, "graph synthesis");
  const synthesis: ParentTaskSynthesisRecord | undefined = snapshot.synthesis;
  if (!synthesis) {
    throw new Error(`Task graph ${snapshot.parentTaskId} does not have a synthesis record yet`);
  }

  writeJson(options.stdout ?? process.stdout, synthesis);
  return 0;
}

async function loadGraphResults(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
  commandName: string,
): Promise<RunnerTaskGraphResultSnapshot> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "db-path": { type: "string" },
      "log-path": { type: "string" },
    },
  });
  const [taskId] = parsed.positionals;
  if (!taskId) {
    throw new Error(`${commandName} requires a task id`);
  }

  const runtime = await options.openRuntime?.({
    cwd: options.cwd,
    dbPath: parsed.values["db-path"],
    logPath: parsed.values["log-path"],
  });

  if (!runtime) {
    throw new Error("operator runtime was not created");
  }

  try {
    const snapshot = runtime.service.reconcileTaskGraphResults
      ? await runtime.service.reconcileTaskGraphResults(taskId)
      : await runtime.service.getTaskGraphResults(taskId);
    if (!snapshot) {
      throw new Error(`Task graph ${taskId} was not found`);
    }

    return snapshot;
  } finally {
    runtime.close();
  }
}

export async function openOperatorRuntime(options: OperatorRuntimeOptions = {}): Promise<OperatorRuntime> {
  const storagePaths = resolveStoragePaths(options.cwd ?? process.cwd(), options.dbPath, options.logPath);
  const persistence = openCodexRunnerPersistence({ filePath: storagePaths.dbPath });
  const service = new CodexRunnerService({
    store: persistence.store,
    sessionStore: persistence.sessionStore,
    worktreeManager: new GitWorktreeManager(),
    logStreamer: new FileLogStreamer(storagePaths.logPath),
    agentSessionFactory: new CodexSdkBackedAgentSessionFactory({
      codexOptions: await resolveCodexOptionsFromConfig(options),
    }),
    runtimeManager: new DefaultCodexRuntimeManager(),
    maxConcurrentTasks: options.maxConcurrentTasks,
  });

  return {
    service,
    close: () => {
      persistence.close();
    },
  };
}

export async function resolveCodexOptionsFromConfig(
  options: Pick<OperatorRuntimeOptions, "configPath" | "secretsPath" | "cwd"> = {},
): Promise<CodexOptions | undefined> {
  const auth = await createFileBackedPlatoConfigService({
    configPath: resolveOptionalPath(options.cwd, options.configPath),
    secretsPath: resolveOptionalPath(options.cwd, options.secretsPath),
  }).resolveCodexAuth();
  if (auth?.provider !== "openai_api_key" || !auth.openAIApiKey) {
    return undefined;
  }

  return {
    apiKey: auth.openAIApiKey,
  } as CodexOptions;
}

async function handleStart(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      "task-id": { type: "string" },
      "repo-path": { type: "string" },
      prompt: { type: "string" },
      priority: { type: "string" },
      "max-concurrent-tasks": { type: "string" },
      "db-path": { type: "string" },
      "log-path": { type: "string" },
    },
  });
  const prompt = parsed.values.prompt?.trim();
  if (!prompt) {
    throw new Error("start requires --prompt");
  }

  const runtime = await options.openRuntime?.({
    cwd: options.cwd,
    dbPath: parsed.values["db-path"],
    logPath: parsed.values["log-path"],
    maxConcurrentTasks: parseOptionalInteger(parsed.values["max-concurrent-tasks"], "max concurrent tasks"),
  });

  if (!runtime) {
    throw new Error("operator runtime was not created");
  }

  try {
    const task = await runtime.service.startTask({
      taskId: parsed.values["task-id"] ?? randomUUID(),
      repoPath: resolve(parsed.values["repo-path"] ?? options.cwd ?? process.cwd()),
      prompt,
      priority: parseOptionalInteger(parsed.values.priority, "priority"),
    });

    writeJson(options.stdout ?? process.stdout, { task });
    return 0;
  } finally {
    runtime.close();
  }
}

async function handleStatus(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      state: { type: "string" },
      "db-path": { type: "string" },
      "log-path": { type: "string" },
    },
  });
  const runtime = await options.openRuntime?.({
    cwd: options.cwd,
    dbPath: parsed.values["db-path"],
    logPath: parsed.values["log-path"],
  });

  if (!runtime) {
    throw new Error("operator runtime was not created");
  }

  try {
    const [taskId] = parsed.positionals;
    if (taskId) {
      const snapshot = await runtime.service.getTaskStatus(taskId);
      if (!snapshot) {
        throw new Error(`Task ${taskId} was not found`);
      }

      writeJson(options.stdout ?? process.stdout, snapshot);
      return 0;
    }

    const requestedState = parseOptionalState(parsed.values.state);
    const tasks = requestedState
      ? await runtime.service.listTasksByState(requestedState)
      : await runtime.service.listTasks();

    writeJson(options.stdout ?? process.stdout, { tasks });
    return 0;
  } finally {
    runtime.close();
  }
}

async function handleEvents(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "db-path": { type: "string" },
      "log-path": { type: "string" },
    },
  });
  const [taskId] = parsed.positionals;
  if (!taskId) {
    throw new Error("events requires a task id");
  }

  const runtime = await options.openRuntime?.({
    cwd: options.cwd,
    dbPath: parsed.values["db-path"],
    logPath: parsed.values["log-path"],
  });

  if (!runtime) {
    throw new Error("operator runtime was not created");
  }

  try {
    const events = await runtime.service.listEvents(taskId);
    writeJson(options.stdout ?? process.stdout, { taskId, events });
    return 0;
  } finally {
    runtime.close();
  }
}

async function handleInterrupt(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "db-path": { type: "string" },
      "log-path": { type: "string" },
    },
  });
  const [taskId] = parsed.positionals;
  if (!taskId) {
    throw new Error("interrupt requires a task id");
  }

  const runtime = await options.openRuntime?.({
    cwd: options.cwd,
    dbPath: parsed.values["db-path"],
    logPath: parsed.values["log-path"],
  });

  if (!runtime) {
    throw new Error("operator runtime was not created");
  }

  try {
    await runtime.service.interruptTask(taskId);
    const snapshot = await runtime.service.getTaskStatus(taskId);
    writeJson(options.stdout ?? process.stdout, snapshot ?? { taskId, interrupted: true });
    return 0;
  } finally {
    runtime.close();
  }
}

async function handleResume(
  argv: string[],
  options: Pick<RunCodexRunnerCliOptions, "cwd" | "stdout" | "openRuntime">,
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "db-path": { type: "string" },
      "log-path": { type: "string" },
    },
  });
  const [taskId] = parsed.positionals;
  if (!taskId) {
    throw new Error("resume requires a task id");
  }

  const runtime = await options.openRuntime?.({
    cwd: options.cwd,
    dbPath: parsed.values["db-path"],
    logPath: parsed.values["log-path"],
  });

  if (!runtime) {
    throw new Error("operator runtime was not created");
  }

  try {
    await runtime.service.resumeTask(taskId);
    const snapshot = await runtime.service.getTaskStatus(taskId);
    writeJson(options.stdout ?? process.stdout, snapshot ?? { taskId });
    return 0;
  } finally {
    runtime.close();
  }
}

function resolveStoragePaths(cwd: string, dbPath?: string, logPath?: string): { dbPath: string; logPath: string } {
  const resolvedDbPath = resolve(cwd, dbPath ?? ".plato/codex-runner/runner.sqlite");
  const defaultLogPath = resolve(dirname(resolvedDbPath), "events.json");

  return {
    dbPath: resolvedDbPath,
    logPath: resolve(cwd, logPath ?? defaultLogPath),
  };
}

function openConfigService(argv: string[], cwd: string | undefined) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      "config-path": { type: "string" },
      "secrets-path": { type: "string" },
    },
  });

  return createFileBackedPlatoConfigService({
    configPath: resolveOptionalPath(cwd, parsed.values["config-path"]),
    secretsPath: resolveOptionalPath(cwd, parsed.values["secrets-path"]),
  });
}

function resolveOptionalPath(cwd: string | undefined, path: string | undefined): string | undefined {
  return path ? resolve(cwd ?? process.cwd(), path) : undefined;
}

function parseOptionalInteger(raw: string | undefined, fieldName: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }

  return value;
}

function parseOptionalState(raw: string | undefined): RunnerTaskState | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (
    raw !== "queued" &&
    raw !== "running" &&
    raw !== "awaiting_approval" &&
    raw !== "interrupted" &&
    raw !== "completed" &&
    raw !== "failed"
  ) {
    throw new Error(`Unsupported task state: ${raw}`);
  }

  return raw;
}

function parseChildSpec(raw: string): CreateTaskGraphInput["children"][number] {
  if (raw.trim().startsWith("{")) {
    return parseJsonChildSpec(raw);
  }

  const firstSeparatorIndex = raw.indexOf(":");
  if (firstSeparatorIndex === -1) {
    throw new Error("--child must use JSON or taskId:prompt[:priority]");
  }

  const taskId = raw.slice(0, firstSeparatorIndex);
  const promptAndPriority = raw.slice(firstSeparatorIndex + 1);
  const lastSeparatorIndex = promptAndPriority.lastIndexOf(":");
  const rawPriority =
    lastSeparatorIndex === -1 ? undefined : promptAndPriority.slice(lastSeparatorIndex + 1);
  const hasTrailingPriority = rawPriority !== undefined && /^-?\d+$/.test(rawPriority.trim());
  const prompt = hasTrailingPriority
    ? promptAndPriority.slice(0, lastSeparatorIndex)
    : promptAndPriority;
  const priority = hasTrailingPriority ? rawPriority : undefined;

  if (!taskId?.trim() || !prompt?.trim()) {
    throw new Error("--child must use JSON or taskId:prompt[:priority]");
  }

  return {
    taskId: taskId.trim(),
    prompt: prompt.trim(),
    priority: parseOptionalInteger(priority, "child priority"),
  };
}

function parseJsonChildSpec(raw: string): CreateTaskGraphInput["children"][number] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON child spec: ${formatCliError(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON child spec must be an object");
  }

  const spec = parsed as Record<string, unknown>;
  if (typeof spec.taskId !== "string" || !spec.taskId.trim()) {
    throw new Error("JSON child spec requires taskId");
  }
  if (typeof spec.prompt !== "string" || !spec.prompt.trim()) {
    throw new Error("JSON child spec requires prompt");
  }
  if (spec.repoPath !== undefined && typeof spec.repoPath !== "string") {
    throw new Error("JSON child spec repoPath must be a string");
  }
  if (
    spec.priority !== undefined &&
    (typeof spec.priority !== "number" || !Number.isInteger(spec.priority))
  ) {
    throw new Error("JSON child spec priority must be an integer");
  }

  const dependencyTaskIds = spec.dependencyTaskIds ?? spec.dependencies;
  if (
    dependencyTaskIds !== undefined &&
    (!Array.isArray(dependencyTaskIds) ||
      dependencyTaskIds.some((dependencyTaskId) => typeof dependencyTaskId !== "string"))
  ) {
    throw new Error("JSON child spec dependencyTaskIds must be an array of strings");
  }

  return {
    taskId: spec.taskId.trim(),
    repoPath: typeof spec.repoPath === "string" ? spec.repoPath : undefined,
    prompt: spec.prompt.trim(),
    priority: typeof spec.priority === "number" ? spec.priority : undefined,
    dependencyTaskIds: Array.isArray(dependencyTaskIds) ? dependencyTaskIds : undefined,
  };
}

function writeJson(writer: Writer, value: unknown): void {
  writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown CLI failure";
}

function buildHelpText(): string {
  return [
    "codex-runner <command>",
    "",
    "Commands:",
    "  start --prompt <text> [--task-id <id>] [--repo-path <path>] [--priority <n>] [--max-concurrent-tasks <n>]",
    "  status [taskId] [--state <state>]",
    "  graph start --prompt <text> --child <json|taskId:prompt[:priority]> [--child ...] [--max-concurrent-tasks <n>]",
    "  graph status <taskId>",
    "  graph results <taskId>",
    "  graph synthesis <taskId>",
    "  events <taskId>",
    "  interrupt <taskId>",
    "  resume <taskId>",
    "  config status",
    "  config set-openai-key --api-key <key>",
    "  config clear-openai-key",
    "  config auth-chatgpt",
    "",
    "Storage:",
    "  --db-path <path>   Defaults to .plato/codex-runner/runner.sqlite",
    "  --log-path <path>  Defaults to the events.json file next to the database",
    "  --config-path <path>   Defaults to ~/.plato/config.json for config commands",
    "  --secrets-path <path>  Defaults to ~/.plato/secrets.json for config commands",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCodexRunnerCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
