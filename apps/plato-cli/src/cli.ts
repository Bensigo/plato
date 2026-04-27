#!/usr/bin/env node

import { runPlatoCliWithRuntime, runPlatoMcpWithRuntime } from "./bootstrap.js";
import { isMainModule } from "./bin.js";
import { runPlatoSmoke } from "./smoke.js";
import type {
  RunPlatoCliWithRuntimeOptions,
  RunPlatoMcpWithRuntimeOptions,
} from "./bootstrap.js";
import type { RunPlatoSmokeOptions } from "./smoke.js";

export interface RunPlatoOptions {
  runCli?: (argv: string[], options?: RunPlatoCliWithRuntimeOptions) => Promise<number>;
  runMcp?: (options?: RunPlatoMcpWithRuntimeOptions) => Promise<number>;
  runSmoke?: (options?: RunPlatoSmokeOptions) => Promise<number>;
  stdout?: Pick<NodeJS.WritableStream, "write">;
  stderr?: Pick<NodeJS.WritableStream, "write">;
}

export async function runPlato(argv: string[], options: RunPlatoOptions = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    (options.stdout ?? process.stdout).write(`${buildPlatoHelpText()}\n`);
    return 0;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    (options.stdout ?? process.stdout).write(`${buildCommandHelpText(command)}\n`);
    return 0;
  }
  if (command === "config") {
    const { runCodexRunnerCli } = await import("@plato/codex-runner");
    return runCodexRunnerCli(["config", ...rest], {
      cwd: process.cwd(),
      stdout: options.stdout,
      stderr: options.stderr,
    });
  }
  if (command === "mcp") {
    const parsed = parseRuntimeOptions(rest);
    if (parsed.error) {
      (options.stderr ?? process.stderr).write(`${parsed.error}\n`);
      return 1;
    }
    if (parsed.argv.length > 0) {
      (options.stderr ?? process.stderr).write("usage: plato mcp\n");
      return 1;
    }
    return (options.runMcp ?? runPlatoMcpWithRuntime)(parsed.options);
  }
  if (command === "smoke") {
    if (rest.length > 0) {
      (options.stderr ?? process.stderr).write("usage: plato smoke\n");
      return 1;
    }
    return (options.runSmoke ?? runPlatoSmoke)({
      stdout: options.stdout,
      stderr: options.stderr,
    });
  }

  const parsed = parseRuntimeOptions(argv);
  if (parsed.error) {
    (options.stderr ?? process.stderr).write(`${parsed.error}\n`);
    return 1;
  }
  return (options.runCli ?? runPlatoCliWithRuntime)(parsed.argv, {
    ...parsed.options,
    stdout: options.stdout,
    stderr: options.stderr,
  });
}

function buildPlatoHelpText(): string {
  return [
    "Plato CLI",
    "",
    "Usage:",
    "  plato <command> [options]",
    "",
    "Common workflows:",
    "  plato smoke",
    "      Run the deterministic MVP smoke without opening Codex.",
    "",
    "  plato task start --workspace-path \"$PWD\" --prompt \"Inspect this repo\" --model gpt-5.4",
    "      Start a real Codex-backed task using your local Codex/ChatGPT subscription.",
    "",
    "  plato task status --task-id <id>",
    "      Inspect the current lifecycle state for a task.",
    "",
    "  plato task events --task-id <id>",
    "      Read captured session output and lifecycle events.",
    "",
    "  plato config set-model gpt-5.4",
    "      Set the default Codex model used by real tasks.",
    "",
    "  plato delegate start --task-id <id> --workspace-path \"$PWD\" --prompt \"Ship the feature\"",
    "      Decompose a top-level task, validate the plan, and start the worker graph.",
    "",
    "Commands:",
    "  task       Start, inspect, interrupt, resume, approve, and reject tasks.",
    "  delegate   Plan or start validated delegated worker graphs.",
    "  graph      Validate, start, inspect, and read graph results or synthesis.",
    "  review     Review plans, graph readiness, worker status, and approvals.",
    "  tool       List available worker tool harnesses.",
    "  config     Configure Codex auth and the default model.",
    "  mcp        Run the Plato MCP server over stdio.",
    "  smoke      Run the deterministic local MVP smoke.",
    "",
    "Runtime options:",
    "  --model <name>                  Override the Codex model for this run, e.g. gpt-5.4.",
    "  --db-path <path>                Use an explicit task database path.",
    "  --log-path <path>               Use an explicit event log path.",
    "  --config-path <path>            Use an explicit Plato config path.",
    "  --secrets-path <path>           Use an explicit Plato secrets path.",
    "  --max-concurrent-tasks <count>  Limit concurrent worker execution.",
    "",
    "More help:",
    "  plato task --help",
    "  plato delegate --help",
    "  plato graph --help",
    "  plato review --help",
    "  plato config --help",
    "  plato mcp --help",
  ].join("\n");
}

function buildCommandHelpText(command: string): string {
  switch (command) {
    case "task":
      return [
        "Usage:",
        "  plato task start --workspace-path <path> --prompt <text> [--task-id <id>] [--model <name>]",
        "  plato task status --task-id <id>",
        "  plato task list [--state queued|running|completed|failed|interrupted|awaiting_approval]",
        "  plato task events --task-id <id>",
        "  plato task interrupt --task-id <id>",
        "  plato task resume --task-id <id>",
        "",
        "Examples:",
        "  plato task start --workspace-path \"$PWD\" --prompt \"Inspect this repo\" --model gpt-5.4",
        "  plato task events --task-id plato-real-smoke",
      ].join("\n");
    case "delegate":
      return [
        "Usage:",
        "  plato delegate plan --task-id <id> --workspace-path <path> --prompt <text>",
        "  plato delegate start --task-id <id> --workspace-path <path> --prompt <text>",
        "",
        "Examples:",
        "  plato delegate plan --task-id mvp --workspace-path \"$PWD\" --prompt \"Break this into reviewable milestones\"",
        "  plato delegate start --task-id mvp --workspace-path \"$PWD\" --prompt \"Implement and verify this feature\"",
      ].join("\n");
    case "graph":
      return [
        "Usage:",
        "  plato graph plan --plan-json <json>",
        "  plato graph validate --plan-json <json>",
        "  plato graph start-plan --plan-json <json>",
        "  plato graph start --task-id <id> --workspace-path <path> --prompt <text> --children-json <json>",
        "  plato graph status --task-id <id>",
        "  plato graph results --task-id <id>",
        "  plato graph synthesis --task-id <id>",
      ].join("\n");
    case "review":
      return [
        "Usage:",
        "  plato review plan --plan-json <json>",
        "  plato review graph --task-id <id>",
        "  plato review approvals",
        "",
        "Use review commands to inspect validation failures, worker boundaries, approval gates, and final synthesis readiness.",
      ].join("\n");
    case "tool":
      return [
        "Usage:",
        "  plato tool catalog",
        "",
        "Lists worker tool harnesses, risk levels, approval requirements, and failure modes.",
      ].join("\n");
    case "config":
      return [
        "Usage:",
        "  plato config status",
        "  plato config set-model <model>",
        "  plato config clear-model",
        "  plato config auth-chatgpt [--device-code]",
        "  plato config set-openai-key (--api-key-stdin | --api-key-env <name> | --api-key <key>)",
        "  plato config clear-openai-key",
        "",
        "Examples:",
        "  plato config set-model gpt-5.4",
        "  plato config status",
        "",
        "Per-run overrides still work with --model <name> on task, delegate, graph, and mcp commands.",
      ].join("\n");
    case "mcp":
      return [
        "Usage:",
        "  plato mcp [--model <name>] [--db-path <path>] [--log-path <path>]",
        "",
        "Runs the Plato MCP server over stdio for agent clients.",
      ].join("\n");
    case "smoke":
      return [
        "Usage:",
        "  plato smoke",
        "",
        "Runs deterministic task, delegate, graph, result, review, interrupt, and resume checks with an in-memory runtime.",
      ].join("\n");
    default:
      return buildPlatoHelpText();
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runPlato(process.argv.slice(2));
}

type RuntimeOptions = RunPlatoCliWithRuntimeOptions & RunPlatoMcpWithRuntimeOptions;

function parseRuntimeOptions(argv: string[]): {
  argv: string[];
  options: Partial<RuntimeOptions>;
  error?: string;
} {
  const nextArgv: string[] = [];
  const options: Partial<RuntimeOptions> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      nextArgv.push(token);
      continue;
    }

    const key = token.slice(2);
    if (!isRuntimeOption(key)) {
      nextArgv.push(token);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      return {
        argv: nextArgv,
        options,
        error: `missing value for --${key}`,
      };
    }

    const parsed = runtimeOptionValue(key, value);
    if (parsed.error) {
      return {
        argv: nextArgv,
        options,
        error: parsed.error,
      };
    }
    Object.assign(options, parsed.option);
    index += 1;
  }

  return {
    argv: nextArgv,
    options,
  };
}

function isRuntimeOption(key: string): boolean {
  return [
    "db-path",
    "log-path",
    "config-path",
    "secrets-path",
    "model",
    "max-concurrent-tasks",
  ].includes(key);
}

function runtimeOptionValue(
  key: string,
  value: string,
): { option: Partial<RuntimeOptions>; error?: undefined } | { option?: undefined; error: string } {
  switch (key) {
    case "db-path":
      return { option: { dbPath: value } };
    case "log-path":
      return { option: { logPath: value } };
    case "config-path":
      return { option: { configPath: value } };
    case "secrets-path":
      return { option: { secretsPath: value } };
    case "model":
      return { option: { model: value } };
    case "max-concurrent-tasks": {
      const parsed = Number.parseInt(value, 10);
      return Number.isInteger(parsed) && `${parsed}` === value
        ? { option: { maxConcurrentTasks: parsed } }
        : { error: "max-concurrent-tasks must be an integer" };
    }
    default:
      return { option: {} };
  }
}
