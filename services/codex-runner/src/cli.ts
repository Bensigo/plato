#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import type {
  CreateTaskGraphInput,
  RunnerTaskRecord,
  RunnerTaskGraphSnapshot,
  RunnerTaskState,
  RunnerTaskStatusSnapshot,
  SessionEvent,
} from "./contracts.js";
import { CodexRunnerService } from "./codex-runner-service.js";
import { FileLogStreamer } from "./logs/file-log-streamer.js";
import { DefaultCodexRuntimeManager } from "./runtime/codex-runtime-manager.js";
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
      default:
        stderr.write(`Unknown command: ${command}\n\n${buildHelpText()}\n`);
        return 1;
    }
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
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
    default:
      throw new Error("graph requires a subcommand: start or status");
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

export async function openOperatorRuntime(options: OperatorRuntimeOptions = {}): Promise<OperatorRuntime> {
  const storagePaths = resolveStoragePaths(options.cwd ?? process.cwd(), options.dbPath, options.logPath);
  const persistence = openCodexRunnerPersistence({ filePath: storagePaths.dbPath });
  const service = new CodexRunnerService({
    store: persistence.store,
    sessionStore: persistence.sessionStore,
    worktreeManager: new GitWorktreeManager(),
    logStreamer: new FileLogStreamer(storagePaths.logPath),
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
    "  events <taskId>",
    "  interrupt <taskId>",
    "  resume <taskId>",
    "",
    "Storage:",
    "  --db-path <path>   Defaults to .plato/codex-runner/runner.sqlite",
    "  --log-path <path>  Defaults to the events.json file next to the database",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCodexRunnerCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
