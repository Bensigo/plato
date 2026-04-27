#!/usr/bin/env node

import { runPlatoCliWithRuntime, runPlatoMcpWithRuntime } from "./bootstrap.js";
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
